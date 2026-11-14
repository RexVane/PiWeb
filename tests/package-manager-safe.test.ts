import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { securePackageManager, validatePackageSource } from "../src/lib/package-manager-safe";
import { recycleFixture } from "./lib/sandbox/fixtures";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await recycleFixture(root); });

describe("plugin source boundary", () => {
	it.each(["npm:--registry=http://127.0.0.1/", "npm:../../outside/pkg", "npm:@scope/../../outside", "npm:https://example.test/pkg.tgz", "npm:file:../pkg", "npm:foo@file:../pkg", "npm:foo@npm:other", "npm:foo@1.0.0\n--prefix=elsewhere", "npm:", "npm:@scope", "npm:/absolute"])("rejects unsafe npm reference %s", (source) => {
		expect(() => validatePackageSource(source)).toThrow();
	});
	it.each(["npm:some-plugin", "npm:@scope/plugin@1.2.3-beta.1+build.4", "npm:plugin@^1.2.0", "npm:plugin@>=1 <2", "npm:plugin@next", "npm:plugin@*", "git:https://private.example/team/repo", "ssh://git@internal/team/plugin.git", "./local-plugin", "D:\\plugins\\local"])("preserves authorized package reference %s", (source) => {
		expect(() => validatePackageSource(source)).not.toThrow();
	});
});

it("guards the SDK's configured package lookup as well as explicit install arguments", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-safe-package-")); roots.push(root);
	const manager = securePackageManager(new DefaultPackageManager({ cwd: root, agentDir: path.join(root, "agent"), settingsManager: SettingsManager.create(root, path.join(root, "agent")) }));
	expect(() => manager.getInstalledPath("npm:../../outside", "project")).toThrow(/registry package/);
	await expect(manager.install("npm:--prefix=elsewhere")).rejects.toThrow(/registry package/);
});

it.each(["install", "uninstall", "update"])("adds ignore-scripts to the SDK %s command without changing global environment", async (action) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-safe-package-")); roots.push(root);
	const manager = new DefaultPackageManager({ cwd: root, agentDir: root, settingsManager: SettingsManager.create(root, root) });
	const seam = manager as unknown as { runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>; runNpmCommand(args: string[]): Promise<void> };
	const spy = vi.spyOn(seam, "runCommand").mockResolvedValue();
	const envBefore = process.env.npm_config_ignore_scripts;
	securePackageManager(manager);
	await seam.runNpmCommand([action, "probe"]);
	expect(spy).toHaveBeenCalledWith("npm", [action, "probe", "--ignore-scripts"], undefined);
	expect(process.env.npm_config_ignore_scripts).toBe(envBefore);
});

it("suppresses actual npm dependency-install lifecycle scripts", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-safe-package-")); roots.push(root);
	await fs.writeFile(path.join(root, "mark.cjs"), "require('node:fs').appendFileSync('executed', process.argv[2] + '\\n');");
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "piweb-lifecycle-probe", version: "1.0.0", scripts: { preinstall: "node mark.cjs preinstall", install: "node mark.cjs install", postinstall: "node mark.cjs postinstall", prepare: "node mark.cjs prepare" } }));
	const manager = new DefaultPackageManager({ cwd: root, agentDir: root, settingsManager: SettingsManager.create(root, root) });
	const seam = manager as unknown as { runNpmCommand(args: string[], options?: { cwd: string }): Promise<void> };
	const args = ["install", "--offline", "--no-audit", "--no-fund", "--package-lock=false"];
	securePackageManager(manager);
	await seam.runNpmCommand(args, { cwd: root });
	expect(await fs.stat(path.join(root, "executed")).then(() => true, () => false)).toBe(false);
	// A real unprotected SDK command proves these are runnable lifecycle hooks.
	const original = new DefaultPackageManager({ cwd: root, agentDir: root, settingsManager: SettingsManager.create(root, root) }) as unknown as typeof seam;
	await original.runNpmCommand([...args, "--ignore-scripts=false"], { cwd: root });
	expect(await fs.readFile(path.join(root, "executed"), "utf8")).toBe("preinstall\ninstall\npostinstall\nprepare\n");
}, 30_000);
