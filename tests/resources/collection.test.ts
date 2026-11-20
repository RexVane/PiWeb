import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResourceSelection } from "../../src/lib/resources/protocol";

let root: string; let cwd: string; let collection: string;
let service: typeof import("../../src/lib/plugins-service");
let discovery: typeof import("../../src/lib/resources/discovery");
let host: typeof import("../../src/lib/resources/host");
let assets: typeof import("../../src/lib/resources/assets");
const selection = (name: string): ResourceSelection => ({ extensions: [`packages/${name}/src/index.ts`], skills: [], prompts: [], themes: [] });

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-resource-collection-")); cwd = path.join(root, "workspace"); collection = path.join(root, "collection");
	await fs.mkdir(cwd); await fs.mkdir(path.join(root, "agent")); await fs.mkdir(collection);
	const names = ["question", "automation", "unselected"];
	await fs.writeFile(path.join(collection, "package.json"), JSON.stringify({ name: "collection", type: "module", pi: { extensions: names.map((name) => `packages/${name}/src/index.ts`) }, piweb: { apiVersion: 1, resources: names.map((name) => `packages/${name}`) } }));
	for (const name of names) {
		const directory = path.join(collection, "packages", name);
		await fs.mkdir(path.join(directory, "src"), { recursive: true }); await fs.mkdir(path.join(directory, "web"));
		await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name, type: "module", pi: { extensions: ["src/index.ts"] }, piweb: { apiVersion: 1, id: name, host: "src/host.mjs", views: [{ id: "main", entry: "web/index.html" }] } }));
		await fs.writeFile(path.join(directory, "src/index.ts"), "export default function() {};");
		await fs.writeFile(path.join(directory, "src/host.mjs"), 'import { value } from "./value.mjs"; export function activate(host) { host.actions.register("ping", () => value); }');
		await fs.writeFile(path.join(directory, "src/value.mjs"), `export const value = "${name}";`);
		await fs.writeFile(path.join(directory, "web/index.html"), `<!doctype html><p>${name} page</p>`);
	}
	await fs.writeFile(path.join(root, "agent/settings.json"), "{}");
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent")); vi.stubEnv("PI_OFFLINE", "1"); vi.resetModules();
	service = await import("../../src/lib/plugins-service"); discovery = await import("../../src/lib/resources/discovery"); host = await import("../../src/lib/resources/host"); assets = await import("../../src/lib/resources/assets");
});
afterAll(async () => {
	await fs.writeFile(path.join(root, "agent/settings.json"), "{}"); await host.reconcileResourceHosts(cwd);
	await vi.waitFor(() => expect(host.resourceHostStatuses()).toEqual([])); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true });
});
const settings = async () => JSON.parse(await fs.readFile(path.join(root, "agent/settings.json"), "utf8"));

describe("one Pi Git/local package, independently selected resources", () => {
	it("initially installs only the selected extension, not the whole collection", async () => {
		await service.installPackage(collection, false, cwd, selection("question"));
		expect((await settings()).packages).toHaveLength(1);
		expect((await discovery.discoverResourcePackages(cwd)).map((item) => [item.id, item.enabled])).toEqual([["question", true], ["automation", false], ["unselected", false]]);
	});
	it("merges another selection into the same official Pi package without replacing the first", async () => {
		await service.installPackage(collection, false, cwd, selection("automation"));
		expect((await settings()).packages).toHaveLength(1);
		const resources = await discovery.discoverResourcePackages(cwd);
		expect(resources.find((item) => item.id === "question")?.enabled).toBe(true);
		expect(resources.find((item) => item.id === "automation")?.enabled).toBe(true);
		expect(resources.find((item) => item.id === "unselected")?.enabled).toBe(false);
		expect(await host.invokeResourceAction("question", "ping", null, { cwd })).toBe("question");
		expect(await host.invokeResourceAction("automation", "ping", null, { cwd })).toBe("automation");
	});
	it("resolves two identically named views to their own member's assets", async () => {
		for (const view of await discovery.resourceViews(cwd)) {
			const token = view.url.split("/")[4];
			expect((await assets.readResourceAsset(token, "index.html")).data.toString()).toContain(`${view.resourceId} page`);
		}
	});
	it("turns one member off without disabling the other or registering a private enable flag", async () => {
		await service.toggleResource("question", true, "user", cwd);
		const resources = await discovery.discoverResourcePackages(cwd);
		expect(resources.find((item) => item.id === "question")?.enabled).toBe(false);
		expect(resources.find((item) => item.id === "automation")?.enabled).toBe(true);
		expect((await settings()).disabledExtensions).toBeUndefined();
		await expect(host.invokeResourceAction("question", "ping", null, { cwd })).rejects.toThrow();
	});
	it("reloads local helper code by content revision without replacing the host process", async () => {
		await fs.writeFile(path.join(collection, "packages/automation/src/value.mjs"), 'export const value = "new value";');
		expect(await host.invokeResourceAction("automation", "ping", null, { cwd })).toBe("new value");
	});
	it("refuses undeclared paths without briefly persisting a whole-package enable", async () => {
		const before = await settings();
		await expect(service.installPackage(collection, false, cwd, { ...selection("question"), extensions: ["packages/missing/src/index.ts"] })).rejects.toThrow(/not declared/);
		expect(await settings()).toEqual(before);
	});
});
