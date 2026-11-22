import fs from "node:fs/promises";
import { recycleGeneratedFixture } from "../fixtures/system-trash";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseResourceManifest, resolveResourceFile, staticResourceCompatibility } from "../../src/lib/resources/manifest";
import { parseResourceCatalog, readBundledResourceCatalog } from "../../src/lib/resources/catalog";
import { resourceFrameMessage, safeResourceViewUrl } from "../../src/lib/resources/frame-protocol";
import { RESOURCE_FRAME_CHANNEL } from "../../src/lib/resources/protocol";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await recycleGeneratedFixture(root); });
const manifest = (entry = "web/index.html") => ({ apiVersion: 1, id: "sample", views: [{ id: "main", entry, placement: "panel", methods: ["select"] }], host: "src/host.mjs" });

it("bundles the optional Ask user recommendation with a fixed Git revision", () => {
	expect(readBundledResourceCatalog().items).toContainEqual(expect.objectContaining({
		id: "@rexvane/piweb-ask-user", types: ["extensions"], compatibility: "web",
		source: expect.stringMatching(/^git:github\.com\/RexVane\/piweb-ask-user@[a-f\d]{40}$/),
		selection: { extensions: ["src/index.ts"], skills: [], prompts: [], themes: [] },
	}));
});

describe("resource manifest", () => {
	it("accepts embedded package settings and explicit request-free automatic composer views", () => {
		const views = [{ id: "settings", entry: "web/settings.html", placement: "settings", methods: [] },
			{ id: "progress", entry: "web/progress.html", placement: "aboveEditor", autoMount: true, methods: [] }];
		expect(parseResourceManifest({ ...manifest(), views }, "sample")?.views).toMatchObject(views);
		expect(parseResourceManifest(manifest(), "sample")?.views[0].autoMount).toBeUndefined();
	});
	it.each(["panel", "dialog", "settings", undefined])("rejects automatic mounting in %s", placement => {
		expect(() => parseResourceManifest({ ...manifest(), views: [{ id: "progress", entry: "web/index.html", placement, methods: [], autoMount: true }] }, "sample")).toThrow(/request-free composer/);
	});
	it("does not automatically mount a question renderer or accept a non-boolean opt-in", () => {
		const view = { id: "progress", entry: "web/index.html", placement: "aboveEditor", methods: ["select"], autoMount: true };
		expect(() => parseResourceManifest({ ...manifest(), views: [view] }, "sample")).toThrow(/request-free composer/);
		expect(() => parseResourceManifest({ ...manifest(), views: [{ ...view, methods: [], autoMount: "true" }] }, "sample")).toThrow(/automatic mounting/);
	});
	it("accepts the public data contract and rejects unsupported versions", () => {
		expect(parseResourceManifest(manifest(), "sample")).toMatchObject({ apiVersion: 1, views: [{ methods: ["select"] }] });
		expect(() => parseResourceManifest({ ...manifest(), apiVersion: 2 }, "sample")).toThrow(/version/);
	});
	it.each(["../index.html", "/etc/index.html", "web/../index.html", "web/%2e%2e/index.html", "web\\index.html", "index.html"])("rejects an unsafe view path %s", (entry) => {
		expect(() => parseResourceManifest(manifest(entry), "sample")).toThrow();
	});
	it("checks canonical asset paths rather than allowing escaping symlinks", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-resource-manifest-")); roots.push(root);
		await fs.mkdir(path.join(root, "package"));
		await fs.mkdir(path.join(root, "outside"));
		await fs.writeFile(path.join(root, "outside", "index.html"), "private");
		await fs.symlink(path.join(root, "outside"), path.join(root, "package", "escape"), process.platform === "win32" ? "junction" : "dir");
		await expect(resolveResourceFile(path.join(root, "package"), "escape/index.html")).rejects.toThrow(/escapes/);
		await fs.writeFile(path.join(root, "outside.html"), "private");
		try {
			await fs.symlink(path.join(root, "outside.html"), path.join(root, "package", "escape.html"), "file");
			await expect(resolveResourceFile(path.join(root, "package"), "escape.html")).rejects.toThrow(/escapes/);
		} catch (error) {
			if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
		}
	});
	it("does not claim generic CLI code is proven compatible", () => {
		expect(staticResourceCompatibility(undefined, ["pi.registerTool({})"])).toBe("unknown");
		expect(staticResourceCompatibility(undefined, ['ctx.ui.custom(factory)'])).toBe("adapt");
		expect(staticResourceCompatibility(undefined, ['if (ctx.mode !== "tui") return'])).toBe("adapt");
	});
});

describe("untrusted market and frame inputs", () => {
	it("drops remote catalog entries that install local files or unsupported resource types", () => {
		const base = { name: "A", author: "user", types: ["extensions"], compatibility: "web" };
		const result = parseResourceCatalog({ version: 1, items: [{ ...base, id: "ok", source: "npm:sample@1.0.0" }, { ...base, id: "local", source: "/etc/code" }, { ...base, id: "bad", types: ["unknown"] }] });
		expect(result.items.map((item) => item.id)).toEqual(["ok"]);
	});
	it("never accepts a frame action without the per-instance token", () => {
		expect(resourceFrameMessage({ channel: RESOURCE_FRAME_CHANNEL, type: "invoke", id: "one", name: "list", token: "wrong" }, "right")).toBeUndefined();
		expect(resourceFrameMessage({ channel: RESOURCE_FRAME_CHANNEL, type: "invoke", id: "one", name: "list", token: "right" }, "right")).toMatchObject({ name: "list" });
	});
	it("allows only same-host resource entry URLs and bounds resize requests", () => {
		expect(safeResourceViewUrl("/api/resources/views/abcd/assets/index.html")).toBe(true);
		expect(safeResourceViewUrl("https://evil.example/index.html")).toBe(false);
		expect(safeResourceViewUrl("/api/resources/views/abcd/assets/../private.html")).toBe(false);
		expect(resourceFrameMessage({ channel: RESOURCE_FRAME_CHANNEL, token: "ok", type: "resize", height: 100_000 }, "ok")?.height).toBe(1000);
	});
	it("only the trusted automatic-frame option permits compact or collapsed sizes", () => {
		const message = { channel: RESOURCE_FRAME_CHANNEL, token: "ok", type: "resize", height: 38 };
		expect(resourceFrameMessage(message, "ok")?.height).toBe(80);
		expect(resourceFrameMessage(message, "ok", 0)?.height).toBe(38);
		expect(resourceFrameMessage({ ...message, minHeight: 0, height: 0 }, "ok")?.height).toBe(80);
		expect(resourceFrameMessage({ ...message, height: -20 }, "ok", 0)?.height).toBe(0);
		expect(resourceFrameMessage({ ...message, height: 100_000 }, "ok", 0)?.height).toBe(1000);
		expect(resourceFrameMessage({ ...message, token: "foreign" }, "ok", 0)).toBeUndefined();
	});
});
