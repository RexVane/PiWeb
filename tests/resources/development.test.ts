import fs from "node:fs/promises";
import { recycleGeneratedFixture } from "../fixtures/system-trash";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

let root: string; let development: typeof import("../../src/lib/resources/development"); let preview: typeof import("../../src/lib/resources/preview"); let assets: typeof import("../../src/lib/resources/assets"); let discovery: typeof import("../../src/lib/resources/discovery");
beforeAll(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-resource-development-"))); await fs.mkdir(path.join(root, "agent")); await fs.mkdir(path.join(root, "resources"));
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent")); vi.stubEnv("PI_WEB_ROOT", path.resolve(".")); vi.resetModules();
	development = await import("../../src/lib/resources/development"); preview = await import("../../src/lib/resources/preview"); assets = await import("../../src/lib/resources/assets"); discovery = await import("../../src/lib/resources/discovery");
});
afterAll(async () => { vi.unstubAllEnvs(); await recycleGeneratedFixture(root); });

describe("independent resource design and passive preview", () => {
	it("creates a real workspace with public documentation but never auto-installs it", async () => {
		const prepared = await development.prepareNewResource(path.join(root, "resources"));
		expect(prepared.cwd.startsWith(path.join(root, "resources"))).toBe(true);
		expect(await fs.readFile(path.join(prepared.cwd, "PIWEB-API.md"), "utf8")).toContain("public");
		expect(await discovery.discoverResourcePackages(prepared.cwd)).toEqual([]);
		const [item] = await preview.preparedResourceViews(prepared.cwd);
		expect(item.view.preview).toBe(true);
		const token = item.view.url.split("/")[4];
		expect((await assets.readResourceAsset(token, "index.html")).data.toString()).toContain("Resource preview");
		await expect(assets.readResourceAsset(token, "../PIWEB-API.md")).rejects.toThrow();
		const newRoot = path.join(root, "new-default"); await fs.mkdir(newRoot);
		await development.prepareNewResource(newRoot);
		expect(await preview.preparedResourceViews(prepared.cwd)).toHaveLength(1);
	});
	it("scaffolds a PiWeb package without a brief and returns no session prompt", async () => {
		const route = await import("../../src/app/api/resources/development/route");
		const post = (body: object) => route.POST(new Request("http://localhost/api/resources/development", { method: "POST", body: JSON.stringify(body) }));
		const destination = path.join(root, "resources");
		const response = await post({ action: "design", root: destination });
		const { data } = await response.json();
		expect(response.status).toBe(200);
		expect(data.prompt).toBeUndefined();
		expect(path.dirname(data.prepared.cwd)).toBe(destination);
		const manifest = JSON.parse(await fs.readFile(path.join(data.prepared.cwd, "package.json"), "utf8"));
		expect(manifest.pi).toEqual({ extensions: ["src/index.ts"] });
		expect(manifest.piweb.views).toEqual([expect.objectContaining({ entry: "web/index.html" })]);
		expect(await fs.readdir(path.join(data.prepared.cwd, "web"))).toEqual(["client.js", "index.html"]);
		const status = await route.GET(new Request(`http://localhost/api/resources/development?status=1&cwd=${encodeURIComponent(data.prepared.cwd)}`));
		expect((await status.json()).data).toEqual({ design: true, hasWeb: true });
		expect(await discovery.discoverResourcePackages(data.prepared.cwd)).toEqual([]);
	});
	it("copies a CLI resource into an independent adaptation workspace without executing its factory", async () => {
		const original = path.join(root, "original"); await fs.mkdir(original); await fs.mkdir(path.join(original, "src"));
		await fs.writeFile(path.join(original, "package.json"), JSON.stringify({ name: "cli-example", pi: { extensions: ["src/index.ts"] } }));
		const source = 'export default function(pi) { globalThis.shouldNotRun = true; pi.registerCommand("ui", { handler: async (_args, ctx) => ctx.ui.custom(factory) }); }';
		await fs.writeFile(path.join(original, "src/index.ts"), source);
		const prepared = await development.prepareExistingResource(original);
		expect(prepared.cwd).not.toBe(original); expect(prepared.compatibility).toBe("adapt");
		expect(await fs.readFile(path.join(original, "src/index.ts"), "utf8")).toBe(source);
		expect((globalThis as Record<string, unknown>).shouldNotRun).toBeUndefined();
		expect(JSON.parse(await fs.readFile(path.join(prepared.cwd, "piweb-upstream.json"), "utf8")).source).toBe(original);
	});
	it("places default development sources outside Pi auto-loaded extensions and rejects extensions dirs", async () => {
		const { defaultResourceDevelopmentRoot } = await import("../../src/lib/resources/preferences");
		const fallback = defaultResourceDevelopmentRoot();
		const autoExt = path.join(root, "agent", "extensions");
		await fs.mkdir(autoExt, { recursive: true });
		expect(path.resolve(fallback)).not.toBe(path.resolve(autoExt));
		expect(path.basename(fallback)).toBe("resource-sources");
		await expect(development.prepareNewResource(autoExt)).rejects.toThrow(/auto-loaded/);
	});
	it("refuses previewing arbitrary workspaces outside the remembered development directory", async () => {
		await expect(preview.preparedResourceViews(path.join(root, "original"))).rejects.toThrow(/development workspace/);
	});
});
