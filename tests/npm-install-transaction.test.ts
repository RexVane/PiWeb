import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { beginNpmSettingsWrite, npmTransactionPath, recoverNpmPrefix, withNpmInstallTransaction } from "../src/lib/npm-install-transaction";
import { JsoncSettingsStorage, mutateJsoncSettingsFileSync } from "../src/lib/jsonc-settings-storage";
import { securePackageManager } from "../src/lib/package-manager-safe";
import { recycleFixture } from "./fixtures/recycle";

let base: string, root: string, settings: string;
const oldPackages = ["npm:fixture@1.0.0"], newPackages = ["npm:fixture@2.0.0"];
beforeEach(async () => {
	base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "piweb-npm-transaction-")));
	root = path.join(base, "npm"); settings = path.join(base, "settings.json");
	await fsp.mkdir(path.join(root, "node_modules", "fixture"), { recursive: true });
	await fsp.writeFile(path.join(root, "node_modules", "fixture", "index.js"), "old usable implementation");
	await fsp.writeFile(settings, JSON.stringify({ packages: oldPackages, theme: "retained" }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await recycleFixture(base); });
const plan = () => [{ root, settings: { file: settings, after: { packages: newPackages } } }];
const live = () => fs.readFileSync(path.join(root, "node_modules", "fixture", "index.js"), "utf8");
const saveSettings = () => { beginNpmSettingsWrite(root); mutateJsoncSettingsFileSync(settings, (current) => ({ ...current, packages: newPackages })); };

it("keeps the live installation untouched until the staged tree and settings are ready", async () => {
	await withNpmInstallTransaction(plan(), async () => {
		await fsp.writeFile(npmTransactionPath(path.join(root, "node_modules", "fixture", "index.js")), "new implementation");
		expect(live()).toBe("old usable implementation");
		saveSettings();
	});
	expect(live()).toBe("new implementation");
	const prior = (await fsp.readdir(base)).find((name) => name.startsWith("npm-previous-"))!;
	expect(fs.readFileSync(path.join(base, prior, "node_modules", "fixture", "index.js"), "utf8")).toBe("old usable implementation");
	expect(fs.readFileSync(path.join(base, "backups", "INDEX.md"), "utf8")).toContain(prior);
	expect(fs.existsSync(path.join(base, "piweb-npm-transaction.json"))).toBe(false);
});

it("restores package settings after a persistence failure while retaining unrelated changes", async () => {
	await expect(withNpmInstallTransaction(plan(), async () => {
		await fsp.writeFile(npmTransactionPath(path.join(root, "node_modules", "fixture", "index.js")), "partial new implementation");
		saveSettings();
		mutateJsoncSettingsFileSync(settings, (current) => ({ ...current, theme: "new unrelated value" }));
		throw Object.assign(new Error("late verification failure"), { code: "EIO" });
	})).rejects.toThrow("late verification failure");
	expect(live()).toBe("old usable implementation");
	expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toEqual({ packages: oldPackages, theme: "new unrelated value" });
});

it("refuses to overwrite installed package edits made during staging", async () => {
	await expect(withNpmInstallTransaction(plan(), async () => {
		await fsp.writeFile(path.join(root, "node_modules", "fixture", "index.js"), "concurrent user edit");
		saveSettings();
	})).rejects.toThrow("changed during the operation");
	expect(live()).toBe("concurrent user edit");
	expect(JSON.parse(fs.readFileSync(settings, "utf8")).packages).toEqual(oldPackages);
});

it("copies package hard links into private files and keeps internal directory links usable", async () => {
	const external = path.join(base, "external.js");
	fs.writeFileSync(external, "external store");
	fs.linkSync(external, path.join(root, "node_modules", "fixture", "linked.js"));
	fs.symlinkSync(path.join(root, "node_modules", "fixture"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
	await withNpmInstallTransaction([{ root }], async () => {
		fs.writeFileSync(npmTransactionPath(path.join(root, "node_modules", "fixture", "linked.js")), "private modification");
		expect(fs.readFileSync(external, "utf8")).toBe("external store");
	});
	expect(fs.readFileSync(path.join(root, "alias", "linked.js"), "utf8")).toBe("private modification");
	expect(fs.readFileSync(external, "utf8")).toBe("external store");
});

it("does not follow an external directory link while copying an npm prefix", async () => {
	const external = path.join(base, "external"); fs.mkdirSync(external);
	fs.writeFileSync(path.join(external, "private.txt"), "private");
	fs.symlinkSync(external, path.join(root, "external-link"), process.platform === "win32" ? "junction" : "dir");
	const readdir = vi.spyOn(fsp, "readdir");
	await withNpmInstallTransaction([{ root }], async () => {
		expect(fs.lstatSync(npmTransactionPath(path.join(root, "external-link"))).isSymbolicLink()).toBe(true);
	});
	expect(readdir.mock.calls.some(([file]) => String(file) === external)).toBe(false);
});

it("recovers every scope from one entry after a real process exit during group promotion", async () => {
	const project = path.join(base, "project"), other = path.join(project, ".pi", "npm");
	fs.mkdirSync(path.join(other, "node_modules", "fixture"), { recursive: true });
	fs.writeFileSync(path.join(other, "node_modules", "fixture", "index.js"), "old project implementation");
	const module = path.resolve("src/lib/npm-install-transaction.ts");
	const script = `import fs from 'node:fs'; import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url); const m=await jiti.import(${JSON.stringify(module)});
const root=process.argv[1]; const rename=fs.renameSync;
if(process.platform==='win32'){const api=(await jiti.import(${JSON.stringify(path.resolve("src/lib/windows-directory-api.ts"))})).windowsDirectoryApiSync();const native=api.rename;api.rename=(a,b)=>{const result=native(a,b);if(String(a)===root&&String(b).includes('npm-previous-'))process.exit(77);return result;};}
else fs.renameSync=(a,b)=>{const result=rename(a,b); if(String(a)===root && String(b).includes('npm-previous-')) process.exit(77); return result;};
await m.withNpmInstallTransaction([{root},{root:process.argv[2],projectRoot:process.argv[3]}],async()=>{for(const target of [root,process.argv[2]])fs.writeFileSync(m.npmTransactionPath(target+'/node_modules/fixture/index.js'),'recovered new implementation');});`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, other, project], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NODE_OPTIONS: "" } });
	let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += chunk; });
	const [code] = await once(child, "exit");
	expect(code, stderr).toBe(77);
	expect(fs.existsSync(root)).toBe(false);
	recoverNpmPrefix(root, undefined, [{ root }, { root: other, projectRoot: project }]);
	expect(live()).toBe("recovered new implementation");
	expect(fs.readFileSync(path.join(other, "node_modules", "fixture", "index.js"), "utf8")).toBe("recovered new implementation");
	expect((await fsp.readdir(base)).some((name) => name.startsWith("npm-previous-"))).toBe(true);
	expect(fs.existsSync(path.join(base, "piweb-npm-transaction.json"))).toBe(false);
}, 30_000);

it("recovers a removed package before the first SDK resource resolution after a real process exit", async () => {
	const packageRoot = path.join(root, "node_modules", "fixture"), skill = path.join(packageRoot, "skills", "old", "SKILL.md");
	fs.mkdirSync(path.dirname(skill), { recursive: true });
	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["./skills"] } }));
	fs.writeFileSync(skill, "---\nname: old\ndescription: retained skill\n---\nUse the retained implementation.\n");
	const script = `import fs from 'node:fs'; import {createJiti} from 'jiti'; const jiti=createJiti(import.meta.url);
const m=await jiti.import(${JSON.stringify(path.resolve("src/lib/npm-install-transaction.ts"))});
const settings=await jiti.import(${JSON.stringify(path.resolve("src/lib/jsonc-settings-storage.ts"))});
const root=process.argv[1], file=process.argv[2];
await m.withNpmInstallTransaction([{root,settings:{file,after:{packages:[]}}}],async()=>{m.beginNpmSettingsWrite(root);settings.mutateJsoncSettingsFileSync(file,c=>({...c,packages:[]}));process.exit(78);});`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, settings], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NODE_OPTIONS: "" } });
	let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += chunk; });
	const [code] = await once(child, "exit"); expect(code, stderr).toBe(78);
	expect(JSON.parse(fs.readFileSync(settings, "utf8")).packages).toEqual([]);
	const sm = SettingsManager.fromStorage(new JsoncSettingsStorage(base, base), { projectTrusted: true });
	await sm.reload();
	expect(sm.getGlobalSettings().packages).toEqual([]);
	const manager = securePackageManager(new DefaultPackageManager({ cwd: base, agentDir: base, settingsManager: sm }));
	const resolved = await manager.resolve(async () => "skip");
	expect(JSON.parse(fs.readFileSync(settings, "utf8")).packages).toEqual(oldPackages);
	expect(sm.getGlobalSettings().packages).toEqual(oldPackages);
	expect(resolved.skills.some((resource) => path.resolve(resource.path) === skill)).toBe(true);
	expect(live()).toBe("old usable implementation");
}, 30_000);

it("finishes a decided commit after a recoverable promotion failure in the same process", async () => {
	const api = process.platform === "win32" ? (await import("../src/lib/windows-directory-api")).windowsDirectoryApiSync() : undefined;
	const original = api ? api.rename.bind(api) : fs.renameSync.bind(fs);
	const replacement = (source: string, target: string, replace?: boolean) => {
		if (path.basename(source).startsWith("npm-stage-")) throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
		return api ? original(source, target, replace) : original(source, target);
	};
	const spy = api ? vi.spyOn(api, "rename").mockImplementation(replacement) : vi.spyOn(fs, "renameSync").mockImplementation(replacement as typeof fs.renameSync);
	try {
		await expect(withNpmInstallTransaction(plan(), async () => {
			fs.writeFileSync(npmTransactionPath(path.join(root, "node_modules", "fixture", "index.js")), "decided new implementation"); saveSettings();
		})).rejects.toMatchObject({ pending: true });
	} finally { spy.mockRestore(); }
	recoverNpmPrefix(root);
	expect(live()).toBe("decided new implementation");
	expect(JSON.parse(fs.readFileSync(settings, "utf8")).packages).toEqual(newPackages);
});

it("rejects a forged recovery group pointing outside the caller's installation scopes", () => {
	const outside = path.join(base, "outside"), externalRoot = path.join(outside, "npm"); fs.mkdirSync(externalRoot, { recursive: true });
	fs.writeFileSync(path.join(externalRoot, "canary.txt"), "external unchanged");
	fs.writeFileSync(path.join(outside, "settings.json"), '{"packages":["private"]}');
	const id = randomUUID(), groupId = randomUUID(), otherId = randomUUID();
	const group = path.join(base, `piweb-npm-group-${groupId}.json`);
	fs.writeFileSync(group, JSON.stringify({ version: 1, id: groupId, decision: "commit", roots: [root, externalRoot], members: { [root.toLowerCase()]: id, [externalRoot.toLowerCase()]: otherId, [root]: id, [externalRoot]: otherId } }));
	fs.writeFileSync(path.join(base, "piweb-npm-transaction.json"), JSON.stringify({ version: 1, id, pid: 99999999, phase: "working", hadOriginal: true, group: { id: groupId, file: group } }));
	expect(() => recoverNpmPrefix(root)).toThrow(/another workspace/);
	expect(fs.readFileSync(path.join(externalRoot, "canary.txt"), "utf8")).toBe("external unchanged");
	expect(fs.readFileSync(path.join(outside, "settings.json"), "utf8")).toBe('{"packages":["private"]}');
});

it("rejects project recovery through a newly linked .pi directory", () => {
	const project = path.join(base, "project"), outside = path.join(base, "outside"); fs.mkdirSync(project); fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "piweb-npm-transaction.json"), "external canary");
	fs.symlinkSync(outside, path.join(project, ".pi"), process.platform === "win32" ? "junction" : "dir");
	expect(() => recoverNpmPrefix(path.join(project, ".pi", "npm"), project)).toThrow(/must not be linked/);
	expect(fs.readFileSync(path.join(outside, "piweb-npm-transaction.json"), "utf8")).toBe("external canary");
});

it("rejects a coordinator reached through a linked allowed project directory", () => {
	const project = path.join(base, "project"), outside = path.join(base, "outside"); fs.mkdirSync(project); fs.mkdirSync(outside);
	fs.symlinkSync(outside, path.join(project, ".pi"), process.platform === "win32" ? "junction" : "dir");
	const id = randomUUID(), groupId = randomUUID();
	const name = `piweb-npm-group-${groupId}.json`, coordinator = path.join(outside, name);
	const content = JSON.stringify({ version: 1, id: groupId, decision: "commit", roots: [root], members: { [root]: id, [root.toLowerCase()]: id } });
	fs.writeFileSync(coordinator, content);
	fs.writeFileSync(path.join(base, "piweb-npm-transaction.json"), JSON.stringify({ version: 1, id, pid: 99999999, phase: "working", hadOriginal: true, group: { id: groupId, file: path.join(project, ".pi", name) } }));
	expect(() => recoverNpmPrefix(root, undefined, [{ root }, { root: path.join(project, ".pi", "npm"), projectRoot: project }])).toThrow(/physical/);
	expect(fs.readFileSync(coordinator, "utf8")).toBe(content);
	expect(live()).toBe("old usable implementation");
});

it("preserves an external file when the recovery index is hard-linked", async () => {
	const outside = path.join(base, "outside.txt"), backups = path.join(base, "backups"), index = path.join(backups, "INDEX.md");
	fs.writeFileSync(outside, "external private content"); fs.mkdirSync(backups); fs.linkSync(outside, index);
	await expect(withNpmInstallTransaction(plan(), async () => { saveSettings(); })).rejects.toMatchObject({ pending: true });
	expect(fs.readFileSync(outside, "utf8")).toBe("external private content");
	fs.renameSync(index, path.join(backups, "quarantined-index-link"));
	recoverNpmPrefix(root);
	expect(fs.readFileSync(outside, "utf8")).toBe("external private content");
	expect(JSON.parse(fs.readFileSync(settings, "utf8")).packages).toEqual(newPackages);
});

it("preserves a recovery index created between inspection and open", async () => {
	const backups = path.join(base, "backups"), index = path.join(backups, "INDEX.md");
	const open = fs.openSync.bind(fs); let injected = false;
	const spy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
		if (String(file) === index && !injected) {
			injected = true;
			fs.writeFileSync(index, "concurrent recovery note\n", { flag: "wx" });
		}
		return open(file, flags, mode);
	});
	try { await expect(withNpmInstallTransaction(plan(), async () => { saveSettings(); })).rejects.toMatchObject({ pending: true }); }
	finally { spy.mockRestore(); }
	expect(injected).toBe(true);
	expect(fs.readFileSync(index, "utf8")).toBe("concurrent recovery note\n");
	recoverNpmPrefix(root);
	expect(fs.readFileSync(index, "utf8")).toMatch(/^concurrent recovery note\n.*Previous plugin installation/s);
});

it.skipIf(process.platform !== "win32")("pins Windows npm ancestors during both asynchronous copy and package execution", async () => {
	const project = path.join(base, "project"), install = path.join(project, ".pi", "npm");
	fs.mkdirSync(install, { recursive: true }); fs.writeFileSync(path.join(install, "file.txt"), "original");
	const check = () => {
		expect(() => fs.renameSync(path.join(project, ".pi"), path.join(project, "moved"))).toThrow();
		expect(() => fs.renameSync(project, path.join(base, "moved-project"))).toThrow();
	};
	const copy = fsp.copyFile.bind(fsp); let copied = false;
	const spy = vi.spyOn(fsp, "copyFile").mockImplementation(async (...args) => { copied = true; check(); return copy(...args); });
	try { await withNpmInstallTransaction([{ root: install, projectRoot: project }], async () => { await Promise.resolve(); check(); }); }
	finally { spy.mockRestore(); }
	expect(copied).toBe(true);
	fs.renameSync(project, path.join(base, "moved-project"));
	const held = path.join(base, "held.txt"), temporary = path.join(base, "replacement.txt");
	fs.writeFileSync(held, "old"); fs.writeFileSync(temporary, "new");
	const koffi = (await import("koffi")).default;
	const kernel = koffi.load("kernel32.dll");
	const open = kernel.func("void *CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *templateFile)");
	const close = kernel.func("bool CloseHandle(void *handle)");
	const handle = open(held, 0x80000000, 0x1, null, 3, 0, null);
	try {
		const api = (await import("../src/lib/windows-directory-api")).windowsDirectoryApiSync();
		expect(() => api.rename(temporary, path.basename(held))).toThrow(expect.objectContaining({ code: expect.stringMatching(/EACCES|EBUSY/) }));
		expect(fs.readFileSync(held, "utf8")).toBe("old");
	} finally { close(handle); }
});

it("contains a real npm late package-json save failure in the stage", async () => {
	vi.stubEnv("npm_config_cache", path.join(base, "npm-cache"));
	const pack = path.join(base, "pack"); fs.mkdirSync(pack);
	fs.writeFileSync(path.join(pack, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }));
	fs.writeFileSync(path.join(pack, "index.js"), "module.exports='new package';");
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "test-prefix", private: true, dependencies: {} }));
	const sm = SettingsManager.create(base, path.join(base, "agent"));
	const pm = securePackageManager(new DefaultPackageManager({ cwd: base, agentDir: base, settingsManager: sm })) as unknown as { runNpmCommand(args: string[], options?: { cwd: string }): Promise<void> };
	await pm.runNpmCommand(["pack", pack, "--pack-destination", base, "--ignore-scripts", "--offline"], { cwd: base });
	const proof = path.join(base, "late-proof.json"), preload = path.join(base, "fail-save.cjs");
	fs.writeFileSync(preload, `const fs=require('node:fs');const fsp=require('node:fs/promises');const write=fsp.writeFile;fsp.writeFile=async function(file,...args){if(String(file)===process.env.PIWEB_TEST_SETTINGS_FAILURE){fs.writeFileSync(${JSON.stringify(proof)},fs.readFileSync(require('node:path').join(require('node:path').dirname(file),'node_modules','fixture','package.json')));throw Object.assign(new Error('injected late EACCES'),{code:'EACCES'});}return write.call(this,file,...args);};`);
	await expect(withNpmInstallTransaction(plan(), async () => {
		const stage = npmTransactionPath(root);
		vi.stubEnv("NODE_OPTIONS", `--require=${JSON.stringify(preload)}`);
		vi.stubEnv("PIWEB_TEST_SETTINGS_FAILURE", path.join(stage, "package.json"));
		try { await pm.runNpmCommand(["install", path.join(base, "fixture-2.0.0.tgz"), "--prefix", stage, "--offline", "--no-audit", "--no-fund"]); }
		finally { vi.unstubAllEnvs(); }
		saveSettings();
	})).rejects.toThrow();
	expect(JSON.parse(fs.readFileSync(proof, "utf8")).version).toBe("2.0.0");
	expect(live()).toBe("old usable implementation");
	expect(JSON.parse(fs.readFileSync(settings, "utf8")).packages).toEqual(oldPackages);
}, 30_000);
