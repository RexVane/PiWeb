import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { runLauncher } from "../scripts/launcher.mjs";
import { writeBuildInventory } from "../scripts/build-output.mjs";
import { recycleFixture } from "./lib/sandbox/fixtures";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await recycleFixture(root); });

function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piweb-launch-validation-"))); roots.push(root);
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@rexvane/piweb" }));
	fs.mkdirSync(path.join(root, "node_modules/vitest"), { recursive: true });
	fs.writeFileSync(path.join(root, "node_modules/vitest/package.json"), "{}");
	return root;
}
function build(root: string, buildDir = ".next", buildId = "sealed") {
	const files = ["BUILD_ID", "routes-manifest.json", "build-manifest.json", "prerender-manifest.json", "server/app-paths-manifest.json"];
	for (const file of [...files, "server/chunks/runtime.js"]) {
		const target = path.join(root, buildDir, file); fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, file === "BUILD_ID" ? buildId : file.endsWith(".js") ? "module.exports=1" : "{}");
	}
	fs.writeFileSync(path.join(root, buildDir, "required-server-files.json"), JSON.stringify({ version: 1, config: { distDir: buildDir }, files: files.map((file) => `${buildDir}/${file}`) }));
	writeBuildInventory(root, buildDir);
	return path.join(root, buildDir, "server/chunks/runtime.js");
}
function dependencies() {
	return {
		spawn: vi.fn(() => { const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }); setImmediate(() => child.emit("exit", 0)); return child; }),
		probePort: vi.fn<() => Promise<"free">>(async () => "free"), isPiWebRunning: vi.fn(async () => false),
		readHttpProxySetting: () => null, readSystemProxy: () => null, log: vi.fn(), warn: vi.fn(),
	};
}
function launch(root: string, deps = dependencies(), extraEnv = {}) {
	return runLauncher({ root, args: ["--no-open"], env: { PI_WEB_AUTH: "1", PIWEB_SKIP_WARMUP: "1", ...extraEnv }, dependencies: deps });
}

it("hashes a complete build only once before starting the authenticated production child", async () => {
	const root = fixture(), runtime = build(root), deps = dependencies();
	const reads = vi.spyOn(fs, "readFileSync");
	expect(await launch(root, deps)).toBe(0);
	expect(reads.mock.calls.filter(([file]) => String(file) === runtime)).toHaveLength(1);
	expect(deps.spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["start"]), expect.objectContaining({ env: expect.objectContaining({ PIWEB_BUILD_DIR: ".next", PI_WEB_AUTH: "1" }) }));
});

it("does not reuse a prior launch's verification for same-size, restored-mtime corruption", async () => {
	const root = fixture(), runtime = build(root);
	expect(await launch(root)).toBe(0);
	const previous = fs.statSync(runtime); fs.writeFileSync(runtime, "module.exports=2"); fs.utimesSync(runtime, previous.atime, previous.mtime);
	const deps = dependencies();
	await expect(launch(root, deps)).rejects.toThrow(/changed production build/);
	expect(deps.spawn).not.toHaveBeenCalled(); expect(deps.probePort).not.toHaveBeenCalled();
});

it("keeps a validated immutable release during promotion and selects the new release on the next launch", async () => {
	const root = fixture(), oldDir = ".next-releases/old", newDir = ".next-releases/new";
	const runtime = build(root, oldDir, "old-id"); build(root, newDir, "new-id");
	const active = path.join(root, ".next-releases/active.json");
	fs.writeFileSync(active, JSON.stringify({ schema: 1, state: "ready", buildDir: oldDir, buildId: "old-id" }));
	const deps = dependencies(), reads = vi.spyOn(fs, "readFileSync");
	deps.probePort.mockImplementation(async () => { fs.writeFileSync(active, JSON.stringify({ schema: 1, state: "ready", buildDir: newDir, buildId: "new-id" })); return "free"; });
	expect(await launch(root, deps)).toBe(0);
	expect(reads.mock.calls.filter(([file]) => String(file) === runtime)).toHaveLength(1);
	expect(deps.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ env: expect.objectContaining({ PIWEB_BUILD_DIR: oldDir }) }));
	const next = dependencies(); expect(await launch(root, next)).toBe(0);
	expect(next.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ env: expect.objectContaining({ PIWEB_BUILD_DIR: newDir }) }));
});

it("validates the previous ready release while a new release is unfinished and rejects conflicting overrides", async () => {
	const root = fixture(), buildDir = ".next-releases/ready", runtime = build(root, buildDir, "ready-id");
	fs.writeFileSync(path.join(root, ".next-releases/active.json"), JSON.stringify({ schema: 1, state: "building", buildDir: ".next-releases/pending", previous: { schema: 1, state: "ready", buildDir, buildId: "ready-id" } }));
	const deps = dependencies(), reads = vi.spyOn(fs, "readFileSync");
	expect(await launch(root, deps)).toBe(0);
	expect(reads.mock.calls.filter(([file]) => String(file) === runtime)).toHaveLength(1);
	const rejected = dependencies(); await expect(launch(root, rejected, { PIWEB_BUILD_DIR: ".next" })).rejects.toThrow(/conflicts/);
	expect(rejected.spawn).not.toHaveBeenCalled();
});

it("rejects a linked runtime directory before probing a port or reading the outside chunk", async () => {
	const root = fixture(), outside = fixture(); build(root); const externalRuntime = build(outside);
	fs.renameSync(path.join(root, ".next/server"), path.join(root, ".next/server-original"));
	fs.symlinkSync(path.join(outside, ".next/server"), path.join(root, ".next/server"), process.platform === "win32" ? "junction" : "dir");
	const deps = dependencies(), reads = vi.spyOn(fs, "readFileSync");
	await expect(launch(root, deps)).rejects.toThrow(/linked/);
	expect(deps.spawn).not.toHaveBeenCalled(); expect(deps.probePort).not.toHaveBeenCalled();
	expect(reads.mock.calls.some(([file]) => String(file) === externalRuntime)).toBe(false);
});
