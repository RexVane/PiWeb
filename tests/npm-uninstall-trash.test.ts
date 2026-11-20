import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { JsoncSettingsStorage, mutateJsoncSettingsFileSync } from "@/lib/jsonc-settings-storage";
import { beginNpmSettingsWrite, finishNpmTrashCleanup, npmTransactionPath, NpmTransactionCommittedError, recoverNpmPrefix, withNpmInstallTransaction } from "@/lib/npm-install-transaction";
import { securePackageManager } from "@/lib/package-manager-safe";
import { recycleGeneratedFixture } from "./fixtures/system-trash";

const native = vi.hoisted(() => ({ move: vi.fn(async (_target: string, _options: unknown) => ({ removed: _target })), destinations: [] as string[] }));
vi.mock("@/lib/recycle-bin", () => ({ moveToTrash: native.move }));
let group: string, directory: string, root: string, settings: string, trash: string;
beforeAll(async () => { group = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "piweb-npm-trash-tests-"))); });
afterAll(async () => { await recycleGeneratedFixture(group); });
beforeEach(async () => {
	directory = await fsp.mkdtemp(path.join(group, "case-")); root = path.join(directory, "npm"); settings = path.join(directory, "settings.json"); trash = path.join(directory, "test-system-trash");
	await fsp.mkdir(path.join(root, "node_modules", "fixture"), { recursive: true }); await fsp.mkdir(path.join(root, "node_modules", "other")); await fsp.mkdir(trash);
	await fsp.writeFile(path.join(root, "node_modules", "fixture", "index.js"), "original implementation");
	await fsp.writeFile(path.join(root, "node_modules", "other", "index.js"), "other package remains usable");
	await fsp.writeFile(settings, JSON.stringify({ packages: ["npm:fixture"], theme: "retained" }));
	native.destinations = []; native.move.mockReset().mockImplementation(async (target) => {
		const destination = path.join(trash, `${randomUUID()}-${path.basename(target)}`);
		await fsp.rename(target, destination); native.destinations.push(destination); return { removed: target };
	});
});
const plans = () => [{ root, recyclePrevious: true, settings: { file: settings, after: { packages: [] } } }];
async function stagedUninstall(): Promise<void> {
	await fsp.rename(npmTransactionPath(path.join(root, "node_modules", "fixture")), path.join(directory, `removed-stage-copy-${randomUUID()}`));
	beginNpmSettingsWrite(root); mutateJsoncSettingsFileSync(settings, (current) => ({ ...current, packages: [] }));
}
const previous = () => path.join(directory, fs.readdirSync(directory).find((name) => name.startsWith("npm-previous-"))!);
const journal = () => path.join(directory, "piweb-npm-transaction.json");

describe("confirmed npm uninstall keeps official transactions but recycles the old generation", () => {
	it("recycles the original installation tree without creating a backup index and keeps other packages available", async () => {
		await withNpmInstallTransaction(plans(), stagedUninstall);
		expect(native.move).toHaveBeenCalledTimes(1);
		expect(await fsp.readFile(path.join(native.destinations[0], "node_modules", "fixture", "index.js"), "utf8")).toBe("original implementation");
		expect(await fsp.readFile(path.join(root, "node_modules", "other", "index.js"), "utf8")).toBe("other package remains usable");
		expect(fs.existsSync(path.join(root, "node_modules", "fixture"))).toBe(false);
		expect(JSON.parse(await fsp.readFile(settings, "utf8"))).toEqual({ packages: [], theme: "retained" });
		expect(fs.existsSync(path.join(directory, "backups"))).toBe(false); expect(fs.existsSync(journal())).toBe(false);
	});

	it("retains the original tree and committed journal when recycling fails, then retries once across parallel readers", async () => {
		native.move.mockRejectedValueOnce(Object.assign(new Error("Trash unavailable"), { code: "TRASH_UNAVAILABLE" }));
		await expect(withNpmInstallTransaction(plans(), stagedUninstall)).rejects.toBeInstanceOf(NpmTransactionCommittedError);
		const old = previous(); expect(await fsp.readFile(path.join(old, "node_modules", "fixture", "index.js"), "utf8")).toBe("original implementation");
		expect(fs.existsSync(journal())).toBe(true); expect(fs.existsSync(path.join(directory, "backups"))).toBe(false);
		expect(recoverNpmPrefix(root)).toBe(true);
		await Promise.all([finishNpmTrashCleanup(plans()), finishNpmTrashCleanup(plans())]);
		expect(native.move).toHaveBeenCalledTimes(2); expect(native.destinations).toHaveLength(1);
		expect(fs.existsSync(old)).toBe(false); expect(fs.existsSync(journal())).toBe(false);
	});

	it("joins a previously committed uninstall before the first real SDK resolver reads package settings", async () => {
		native.move.mockRejectedValueOnce(new Error("temporary Trash failure"));
		await expect(withNpmInstallTransaction(plans(), stagedUninstall)).rejects.toMatchObject({ applied: true });
		const manager = securePackageManager(new DefaultPackageManager({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.fromStorage(new JsoncSettingsStorage(directory, directory), { projectTrusted: true }) }));
		await manager.resolve(async () => "skip");
		expect(native.destinations).toHaveLength(1); expect(fs.existsSync(journal())).toBe(false);
		expect(await fsp.readFile(path.join(native.destinations[0], "node_modules", "fixture", "index.js"), "utf8")).toBe("original implementation");
	});

	it("never overwrites pending uninstall recovery with another install when system Trash is still unavailable", async () => {
		native.move.mockRejectedValue(new Error("Trash still unavailable"));
		await expect(withNpmInstallTransaction(plans(), stagedUninstall)).rejects.toMatchObject({ applied: true });
		const before = await fsp.readFile(journal(), "utf8"); const old = previous();
		await expect(withNpmInstallTransaction([{ root }], async () => {})).rejects.toThrow("Trash still unavailable");
		expect(await fsp.readFile(journal(), "utf8")).toBe(before);
		expect(await fsp.readFile(path.join(old, "node_modules", "fixture", "index.js"), "utf8")).toBe("original implementation");
	});

	it("does not recycle a replacement directory forged in the old generation's path", async () => {
		native.move.mockRejectedValueOnce(new Error("retry later"));
		await expect(withNpmInstallTransaction(plans(), stagedUninstall)).rejects.toMatchObject({ applied: true });
		const old = previous(); await fsp.rename(old, `${old}.saved`); await fsp.mkdir(old); await fsp.writeFile(path.join(old, "private.txt"), "retain replacement");
		await expect(finishNpmTrashCleanup(plans())).rejects.toThrow("changed");
		expect(native.move).toHaveBeenCalledTimes(1); expect(await fsp.readFile(path.join(old, "private.txt"), "utf8")).toBe("retain replacement");
	});

	it("recovers a real process exit immediately after promotion and sends the original generation to Trash", async () => {
		const script = `import fs from 'node:fs'; import {createJiti} from 'jiti'; const jiti=createJiti(import.meta.url);
const tx=await jiti.import(${JSON.stringify(path.resolve("src/lib/npm-install-transaction.ts"))});
const json=await jiti.import(${JSON.stringify(path.resolve("src/lib/jsonc-settings-storage.ts"))});
const root=process.argv[1], file=process.argv[2];
if(process.platform==='win32'){const api=(await jiti.import(${JSON.stringify(path.resolve("src/lib/windows-directory-api.ts"))})).windowsDirectoryApiSync();const rename=api.rename.bind(api);api.rename=(a,b,...rest)=>{const value=rename(a,b,...rest);if(String(a).includes('npm-stage-')&&String(b)==='npm')process.exit(88);return value;};}
else{const rename=fs.renameSync;fs.renameSync=(a,b)=>{const value=rename(a,b);if(String(a).includes('npm-stage-')&&String(b)===root)process.exit(88);return value;};}
await tx.withNpmInstallTransaction([{root,recyclePrevious:true,settings:{file,after:{packages:[]}}}],async()=>{fs.renameSync(tx.npmTransactionPath(root+'/node_modules/fixture'),root+'-stage-discard');tx.beginNpmSettingsWrite(root);json.mutateJsoncSettingsFileSync(file,c=>({...c,packages:[]}));});`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, settings], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += chunk; });
		const [code] = await once(child, "exit"); expect(code, stderr).toBe(88);
		expect(recoverNpmPrefix(root)).toBe(true); await finishNpmTrashCleanup(plans());
		expect(await fsp.readFile(path.join(native.destinations[0], "node_modules", "fixture", "index.js"), "utf8")).toBe("original implementation");
		expect(fs.existsSync(journal())).toBe(false); expect(fs.existsSync(path.join(directory, "backups"))).toBe(false);
	}, 30_000);
});
