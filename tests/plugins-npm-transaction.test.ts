import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { JsoncSettingsStorage } from "../src/lib/jsonc-settings-storage";
import { securePackageManager } from "../src/lib/package-manager-safe";
import { installPackage, removePackage, updatePackages, ResourceRefreshError } from "../src/lib/plugins-service";
import { recycleFixture } from "./lib/sandbox/fixtures";

const state = vi.hoisted(() => ({ agentDir: "", manager: undefined as DefaultPackageManager | undefined, settings: undefined as SettingsManager | undefined, reload: vi.fn(async () => {}) }));
vi.mock("../src/lib/pi", () => ({ getAgentDir: () => state.agentDir, getPackageManager: () => state.manager!, getSettingsManager: () => state.settings!, reloadAllLoaders: state.reload }));
vi.mock("../src/lib/agent-manager", () => ({ reloadSessionsForCwd: vi.fn(async () => {}) }));
let base: string, cwd: string;
let command: ReturnType<typeof vi.fn<(command: string, args: string[]) => Promise<void>>>;
interface Internals {
	runCommand(command: string, args: string[]): Promise<void>;
	shouldUpdateNpmSource(source: unknown, scope: string): Promise<{ shouldUpdate: boolean; installedVersion: string; targetVersion: string }>;
}
const prefix = (local: boolean) => local ? path.join(cwd, ".pi", "npm") : path.join(state.agentDir, "npm");
const settingsFile = (local: boolean) => local ? path.join(cwd, ".pi", "settings.json") : path.join(state.agentDir, "settings.json");
const readVersion = (local: boolean) => JSON.parse(fs.readFileSync(path.join(prefix(local), "node_modules", "fixture", "package.json"), "utf8")).version;
beforeEach(async () => {
	base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "piweb-plugin-npm-")));
	state.agentDir = path.join(base, "agent"); cwd = path.join(base, "workspace");
	for (const local of [false, true]) {
		fs.mkdirSync(path.join(prefix(local), "node_modules", "fixture"), { recursive: true });
		fs.writeFileSync(path.join(prefix(local), "node_modules", "fixture", "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
		fs.writeFileSync(path.join(prefix(local), "user-package-note.txt"), "retain package edits");
		fs.writeFileSync(settingsFile(local), JSON.stringify({ packages: ["npm:fixture"], theme: "kept" }));
	}
	state.settings = SettingsManager.fromStorage(new JsoncSettingsStorage(cwd, state.agentDir), { projectTrusted: true });
	state.manager = securePackageManager(new DefaultPackageManager({ cwd, agentDir: state.agentDir, settingsManager: state.settings }));
	state.reload.mockReset().mockResolvedValue();
	command = vi.fn(async (_command: string, args: string[]) => {
		const stage = args[args.indexOf("--prefix") + 1];
		expect(path.basename(stage)).toMatch(/^npm-stage-/);
		expect(args).toContain("--ignore-scripts");
		const target = path.join(stage, "node_modules", "fixture");
		if (args[0] === "uninstall") fs.renameSync(target, target + "-removed");
		else fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }));
	});
	vi.spyOn(state.manager as unknown as Internals, "runCommand").mockImplementation(command);
	vi.spyOn(state.manager as unknown as Internals, "shouldUpdateNpmSource").mockResolvedValue({ shouldUpdate: true, installedVersion: "1.0.0", targetVersion: "2.0.0" });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await recycleFixture(base); });

it.each([false, true])("installs through the real SDK into only the requested scope local=%s", async (local) => {
	await installPackage("npm:fixture@2.0.0", local, cwd);
	expect(readVersion(local)).toBe("2.0.0"); expect(readVersion(!local)).toBe("1.0.0");
	expect(JSON.parse(fs.readFileSync(settingsFile(local), "utf8")).packages).toEqual(["npm:fixture@2.0.0"]);
	expect(fs.readFileSync(path.join(prefix(local), "user-package-note.txt"), "utf8")).toBe("retain package edits");
});

it("keeps the previous installation and SDK settings when a staged npm command fails", async () => {
	command.mockImplementationOnce(async (_command, args) => {
		fs.writeFileSync(path.join(args[args.indexOf("--prefix") + 1], "node_modules", "fixture", "package.json"), '{"version":"damaged"}');
		throw new Error("npm late failure");
	});
	await expect(installPackage("npm:fixture@2.0.0", false, cwd)).rejects.toThrow("npm late failure");
	expect(readVersion(false)).toBe("1.0.0");
	expect(state.settings!.getGlobalSettings().packages).toEqual(["npm:fixture"]);
	expect(state.reload).not.toHaveBeenCalled();
});

it("removes a disabled-only npm package without manufacturing an absent packages field", async () => {
	fs.writeFileSync(settingsFile(false), JSON.stringify({ disabledPackages: ["npm:fixture"], theme: "kept" }));
	await state.settings!.reload();
	expect(await removePackage("npm:fixture", false, cwd)).toBe(true);
	expect(JSON.parse(fs.readFileSync(settingsFile(false), "utf8"))).toEqual({ disabledPackages: [], theme: "kept" });
	expect(fs.existsSync(path.join(prefix(false), "node_modules", "fixture"))).toBe(false);
	expect(readVersion(true)).toBe("1.0.0");
});

it("updates both npm scopes through their private stages", async () => {
	// Version lookup and npm execution are mocked; exercise updates even in the offline suite.
	vi.stubEnv("PI_OFFLINE", "");
	await updatePackages(undefined, cwd);
	expect(command).toHaveBeenCalledTimes(2);
	expect(readVersion(false)).toBe("2.0.0"); expect(readVersion(true)).toBe("2.0.0");
	for (const local of [false, true]) expect(JSON.parse(fs.readFileSync(settingsFile(local), "utf8")).packages).toEqual(["npm:fixture"]);
});

it("keeps a committed installation when resource refresh fails afterwards", async () => {
	state.reload.mockRejectedValueOnce(new Error("refresh failed"));
	await expect(installPackage("npm:fixture@2.0.0", false, cwd)).rejects.toBeInstanceOf(ResourceRefreshError);
	expect(readVersion(false)).toBe("2.0.0");
	expect(JSON.parse(fs.readFileSync(settingsFile(false), "utf8")).packages).toEqual(["npm:fixture@2.0.0"]);
});
