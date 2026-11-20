import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let root: string;
let cwd: string;
let packageRoot: string;
let discovery: typeof import("../../src/lib/resources/discovery");
let host: typeof import("../../src/lib/resources/host");
let assets: typeof import("../../src/lib/resources/assets");
let preferences: typeof import("../../src/lib/resources/preferences");

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-resource-host-"));
	cwd = path.join(root, "workspace"); packageRoot = path.join(root, "resource");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir); await fs.mkdir(packageRoot);
	await fs.mkdir(path.join(packageRoot, "src")); await fs.mkdir(path.join(packageRoot, "web"));
	await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "host-test", type: "module", version: "1.0.0", pi: { extensions: ["src/index.ts"] }, piweb: { apiVersion: 1, id: "host-test", host: "src/host.mjs", views: [{ id: "main", entry: "web/index.html", methods: ["select"] }] } }));
	await fs.writeFile(path.join(packageRoot, "src/index.ts"), 'export default function () { throw new Error("Discovery must never execute code"); }');
	await fs.writeFile(path.join(packageRoot, "src/host.mjs"), `export function activate(host) {
		globalThis.__resourceActivations = (globalThis.__resourceActivations || 0) + 1;
		host.actions.register("ping", async () => { await host.storage.write("state.json", { value: 42 }); return host.storage.read("state.json"); });
		host.services.register("timer", () => { globalThis.__resourceStarts = (globalThis.__resourceStarts || 0) + 1; return () => { globalThis.__resourceStops = (globalThis.__resourceStops || 0) + 1; }; });
	}`);
	await fs.writeFile(path.join(packageRoot, "web/index.html"), "<!doctype html><p>hello</p>");
	await fs.writeFile(path.join(packageRoot, "secret.ts"), "secret server code");
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot], defaultProjectTrust: "always" }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir); vi.stubEnv("PI_OFFLINE", "1");
	vi.resetModules();
	discovery = await import("../../src/lib/resources/discovery");
	host = await import("../../src/lib/resources/host");
	assets = await import("../../src/lib/resources/assets");
	preferences = await import("../../src/lib/resources/preferences");
});
afterAll(async () => {
	await fs.writeFile(path.join(root, "agent/settings.json"), "{}");
	await host.reconcileResourceHosts(cwd);
	await vi.waitFor(() => expect(host.resourceHostStatuses()).toEqual([]));
	vi.unstubAllEnvs();
	for (const key of ["__resourceActivations", "__resourceStarts", "__resourceStops"]) Reflect.deleteProperty(globalThis, key);
	await fs.rm(root, { recursive: true, force: true });
});

describe("real Pi package discovery and public host", () => {
	it("discovers views and metadata without loading the Pi extension or host entry", async () => {
		const packages = await discovery.discoverResourcePackages(cwd);
		expect(packages).toHaveLength(1);
		expect(packages[0]).toMatchObject({ enabled: true, id: "host-test", scope: "user" });
		expect((globalThis as Record<string, unknown>).__resourceActivations).toBeUndefined();
		expect(await discovery.resourceViews(cwd)).toMatchObject([{ id: "user:host-test:main", scope: "user" }]);
	});
	it("serves only assets in the declared web directory", async () => {
		const [view] = await discovery.resourceViews(cwd);
		const token = view.url.split("/")[4];
		expect((await assets.readResourceAsset(token, "index.html")).data.toString()).toContain("hello");
		await expect(assets.readResourceAsset(token, "../secret.ts")).rejects.toThrow();
		await expect(assets.readResourceAsset(token, "secret.ts")).rejects.toThrow();
		expect(assets.RESOURCE_CSP).toContain("sandbox allow-scripts");
		expect(assets.RESOURCE_CSP).not.toContain("allow-same-origin");
	});
	it("activates once for multiple action calls and preserves its own namespaced data", async () => {
		expect(await host.invokeResourceAction("host-test", "ping", null, { cwd })).toEqual({ value: 42 });
		expect(await host.invokeResourceAction("host-test", "ping", null, { cwd })).toEqual({ value: 42 });
		expect((globalThis as Record<string, unknown>).__resourceActivations).toBe(1);
		expect((globalThis as Record<string, unknown>).__resourceStarts).toBe(1);
	});
	it("stops the web/host part when the associated Pi extension is disabled", async () => {
		await fs.writeFile(path.join(root, "agent/settings.json"), JSON.stringify({ packages: [{ source: packageRoot, extensions: [] }] }));
		expect((await discovery.discoverResourcePackages(cwd))[0].enabled).toBe(false);
		await host.reconcileResourceHosts(cwd);
		await vi.waitFor(() => expect((globalThis as Record<string, unknown>).__resourceStops).toBe(1));
		await expect(host.invokeResourceAction("host-test", "ping", null, { cwd })).rejects.toThrow(/unavailable/);
	});
	it("preserves independent preferences, rejects local catalogs, and does not replace malformed settings", async () => {
		await preferences.saveResourcePreferences({ developmentRoot: cwd });
		expect((await preferences.getResourcePreferences()).developmentRoot).toBe(cwd);
		expect(() => preferences.publicCatalogUrl("http://127.0.0.1/catalog.json")).toThrow();
		expect(() => preferences.publicCatalogUrl("https://192.168.1.1/catalog.json")).toThrow();
		await fs.writeFile(preferences.resourcePreferencesPath(), "broken");
		await expect(preferences.saveResourcePreferences({ renderers: {} })).rejects.toThrow();
		expect(await fs.readFile(preferences.resourcePreferencesPath(), "utf8")).toBe("broken");
	});
});
