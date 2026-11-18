import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { JsoncSettingsStorage } from "../src/lib/jsonc-settings-storage";
import { getPiSettings, patchPiSettings } from "../src/lib/pi-settings";
import { getSettingsManager, reloadSettingsManagers, reloadAllLoaders, resourceLoaderReady, getResourceLoader } from "../src/lib/pi";
import { recycleFixture } from "./fixtures/recycle";
import { readJsonObject, readJsonObjectSync } from "../src/lib/agent-config";
import { resourceFingerprint } from "../src/lib/resource-fingerprint";

vi.mock("../src/lib/growth-tracker", () => ({ GROWTH_TRACKER_VERSION: 1, createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }) }));
let root: string, agentDir: string, first: string, second: string;
const managed: ReturnType<typeof import("../src/lib/agent-manager")["getManaged"]>[] = [];
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-effective-"));
	agentDir = path.join(root, "agent"); first = path.join(root, "first"); second = path.join(root, "second");
	await Promise.all([fs.mkdir(agentDir), fs.mkdir(path.join(first, ".pi"), { recursive: true }), fs.mkdir(second)]);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir); vi.stubEnv("PI_OFFLINE", "1");
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", cacheWarming: "off", compaction: { enabled: false, reserveTokens: 12345 } }));
});
afterEach(async () => {
	const manager = await import("../src/lib/agent-manager");
	for (const item of managed.splice(0)) await manager.disposeSession(item);
	vi.unstubAllEnvs(); vi.restoreAllMocks();
	await recycleFixture(root);
});

it("SDK public storage reads JSONC and preserves BOM, comments and unrelated fields when SDK writes", async () => {
	const file = path.join(agentDir, "settings.json");
	await fs.writeFile(file, '\uFEFF{\n // user note\n "theme": "dark",\n "steeringMode": "one-at-a-time",\n}\n');
	const sm = SettingsManager.fromStorage(new JsoncSettingsStorage(first, agentDir), { projectTrusted: true });
	expect(sm.getSteeringMode()).toBe("one-at-a-time");
	expect(sm.drainErrors()).toEqual([]);
	sm.setSteeringMode("all"); await sm.flush();
	expect(sm.drainErrors()).toEqual([]);
	const stored = await fs.readFile(file, "utf8");
	expect(stored.startsWith("\uFEFF")).toBe(true);
	expect(stored).toContain("// user note"); expect(stored).toContain('"theme": "dark"');
	expect(stored).toContain('"steeringMode": "all"');
});

it("untrusted project settings remain editable while effective values match the global SDK settings", async () => {
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", compaction: { enabled: false, reserveTokens: 12345 }, cacheWarming: "off" }));
	await fs.writeFile(path.join(first, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true }, steeringMode: "all", cacheWarming: "idle" }));
	const settings = await getPiSettings(first);
	expect(settings.projectTrusted).toBe(false); expect(settings.compaction.enabled).toBe(true);
	expect(settings.effective?.compaction.enabled).toBe(false);
	expect(settings.cacheWarming).toBe("off"); expect(settings.effective?.cacheWarming).toBe("off");
	const sdk = getSettingsManager(first);
	expect(sdk.getCompactionSettings().enabled).toBe(false); expect(sdk.getSteeringMode()).toBe("one-at-a-time");
	await patchPiSettings({ compaction: { reserveTokens: 6789 } }, first);
	expect((await getPiSettings(first)).compaction).toMatchObject({ enabled: true, reserveTokens: 6789 });
	expect(sdk.getCompactionSettings()).toMatchObject({ enabled: false, reserveTokens: 12345 });
	await expect(patchPiSettings({ cacheWarming: "idle" }, first)).rejects.toThrow("global");
	await expect(patchPiSettings({ httpProxy: "http://localhost:7890" }, first)).rejects.toThrow("global");
});

it("preserves simultaneous SDK and web settings writes without a synchronous lock failure", async () => {
	const sdk = getSettingsManager(first);
	for (let index = 0; index < 8; index++) {
		const patch = patchPiSettings({ retry: { maxRetries: index + 1 } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		sdk.setTheme(`theme-${index}`);
		await Promise.all([patch, sdk.flush()]);
		expect(sdk.drainErrors()).toEqual([]);
		const stored = JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"));
		expect(stored).toMatchObject({ theme: `theme-${index}`, retry: { maxRetries: index + 1 }, compaction: { reserveTokens: 12345 } });
	}
});

it("global hot updates preserve trusted project overrides and project hot updates affect only that project", async () => {
	await fs.writeFile(path.join(first, ".pi", "settings.json"), JSON.stringify({ steeringMode: "all", followUpMode: "all" }));
	const manager = await import("../src/lib/agent-manager");
	const { SessionManager } = await import("../src/lib/pi");
	for (const cwd of [first, second]) {
		const sm = SessionManager.create(cwd);
		sm.appendMessage({ role: "user", content: "offline settings check", timestamp: 1 });
		const item = manager.getManaged(sm.getSessionFile()!); managed.push(item);
		await manager.ensureSession(item);
	}
	const [a, b] = managed;
	expect(a.session!.agent.steeringMode).toBe("all"); expect(b.session!.agent.steeringMode).toBe("one-at-a-time");
	await patchPiSettings({ steeringMode: "all" });
	manager.applySettingsToSessions({ steeringMode: "all" });
	expect(b.session!.agent.steeringMode).toBe("all");
	await patchPiSettings({ steeringMode: "one-at-a-time" });
	manager.applySettingsToSessions({ steeringMode: "one-at-a-time" });
	expect(a.session!.agent.steeringMode).toBe("all"); expect(b.session!.agent.steeringMode).toBe("one-at-a-time");
	await patchPiSettings({ steeringMode: "one-at-a-time" }, first);
	manager.applySettingsToSessions({ steeringMode: "one-at-a-time" }, first);
	expect(a.session!.agent.steeringMode).toBe("one-at-a-time"); expect(b.session!.agent.steeringMode).toBe("one-at-a-time");
});

it("reports SDK swallowed settings failures and attempts every manager before reporting refresh failure", async () => {
	const a = getSettingsManager(first), b = getSettingsManager(second);
	const reloadB = vi.spyOn(b, "reload");
	await fs.writeFile(path.join(agentDir, "settings.json"), "{ malformed");
	await expect(reloadSettingsManagers()).rejects.toThrow("could not refresh");
	expect(reloadB).toHaveBeenCalled();
	await fs.writeFile(path.join(agentDir, "settings.json"), "{}");
	await expect(reloadSettingsManagers()).resolves.toBeUndefined();
	expect(a.drainErrors()).toEqual([]);
});

it("reports extension load errors even when the SDK resolves reload successfully", async () => {
	await fs.writeFile(path.join(first, ".pi", "settings.json"), JSON.stringify({ extensions: [path.join(first, "broken.mjs")] }));
	await fs.writeFile(path.join(first, "broken.mjs"), "export default ???");
	await resourceLoaderReady(first);
	expect(getResourceLoader(first).getExtensions().errors.length).toBeGreaterThan(0);
	await expect(reloadAllLoaders()).rejects.toThrow("could not refresh");
	// This file shares module-level loader caches across tests. On POSIX fixture roots
	// are not removed by recycleFixture, so the broken extension would keep failing every
	// later global refresh in this file; repair the cached loader before the test ends.
	await fs.writeFile(path.join(first, ".pi", "settings.json"), "{}");
	await fs.rm(path.join(first, "broken.mjs"), { force: true });
	await resourceLoaderReady(first);
	await expect(reloadAllLoaders()).resolves.toEqual(expect.any(Array));
});

it("plugin scope changes and resource fingerprints read JSONC consistently without rewriting user formatting", async () => {
	const source = path.join(root, "package"), extra = path.join(root, "project-skills");
	await fs.mkdir(source); await fs.mkdir(path.join(extra, "demo"), { recursive: true });
	await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "settings-jsonc-fixture", pi: { skills: [] } }));
	const document = path.join(extra, "demo", "SKILL.md");
	await fs.writeFile(document, "---\nname: jsonc-fixture\ndescription: fixture\n---\nInitial body");
	const globalFile = path.join(agentDir, "settings.json"), projectFile = path.join(first, ".pi", "settings.json");
	await fs.writeFile(globalFile, '\uFEFF{\n // global note\n "defaultProjectTrust": "always",\n "cacheWarming": "off",\n}\n');
	await fs.writeFile(projectFile, "\uFEFF{\n // project note\n \"packages\": [" + JSON.stringify(source) + "],\n \"skills\": [" + JSON.stringify(extra) + "],\n}\n");
	expect((await readJsonObject(projectFile)).packages).toEqual([source]);
	expect(readJsonObjectSync(projectFile).skills).toEqual([extra]);
	const before = resourceFingerprint({ cwd: first, agentDir, trusted: true });
	await fs.writeFile(document, "---\nname: jsonc-fixture\ndescription: changed fixture\n---\nEdited body");
	expect(resourceFingerprint({ cwd: first, agentDir, trusted: true })).not.toBe(before);
	const { listPackages, togglePackage } = await import("../src/lib/plugins-service");
	expect((await listPackages(first)).some((item) => item.source === source && item.scope === "project")).toBe(true);
	await togglePackage(source, true, "project", first);
	const saved = await fs.readFile(projectFile, "utf8");
	expect(saved.startsWith("\uFEFF")).toBe(true); expect(saved).toContain("// project note");
	expect((await readJsonObject(projectFile)).disabledPackages).toEqual([source]);
	expect((await fs.readFile(globalFile, "utf8"))).toContain("// global note");
	await fs.writeFile(path.join(agentDir, "auth.json"), "{ // auth stays strict\n}");
	await expect(readJsonObject(path.join(agentDir, "auth.json"))).rejects.toThrow();
});
