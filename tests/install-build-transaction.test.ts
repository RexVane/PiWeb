import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const runner = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawnSync: runner.spawnSync }));
import { ensureInstallBuild, hasProductionBuild } from "../scripts/install-build.mjs";
import { selectProductionBuild } from "../scripts/build-output.mjs";
import { runLauncher } from "../scripts/launcher.mjs";
import { recycleFixture } from "./lib/sandbox/fixtures";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); runner.spawnSync.mockReset(); for (const root of roots.splice(0)) await recycleFixture(root); });
function writeBuild(root: string, buildDir: string, id: string) {
	const files = ["BUILD_ID", "routes-manifest.json", "build-manifest.json", "prerender-manifest.json", "server/app-paths-manifest.json", "server/chunks/runtime.js"];
	for (const file of files) { const target = path.join(root, buildDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file === "BUILD_ID" ? id : file.endsWith(".js") ? "runtime" : "{}"); }
	fs.writeFileSync(path.join(root, buildDir, "required-server-files.json"), JSON.stringify({ version: 1, config: { distDir: buildDir }, files: files.slice(0, 5).map((file) => `${buildDir}/${file}`) }));
}
function fixture() {
	vi.stubEnv("PIWEB_SKIP_INSTALL_BUILD", "0");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-install-transaction-")); roots.push(root);
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@rexvane/piweb", version: "1.0.0" }));
	fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
	fs.mkdirSync(path.join(root, "node_modules/next"), { recursive: true });
	fs.writeFileSync(path.join(root, "node_modules/next/package.json"), JSON.stringify({ bin: "cli.js" }));
	fs.writeFileSync(path.join(root, "node_modules/next/cli.js"), "");
	writeBuild(root, ".next", "old-serving");
	runner.spawnSync.mockImplementation((_command, _args, options) => { writeBuild(options.cwd, options.env.PIWEB_BUILD_DIR, "new-ready"); return { status: 0 }; });
	return root;
}
it("promotes a complete install build without moving or overwriting the old serving directory", () => {
	const root = fixture();
	expect(ensureInstallBuild(root, { force: true, log: () => {}, warn: () => {} })).toBe("built");
	expect(selectProductionBuild(root)?.buildDir).toMatch(/^\.next-releases\/install-/);
	expect(fs.readFileSync(path.join(root, ".next/BUILD_ID"), "utf8")).toBe("old-serving");
	expect(hasProductionBuild(root)).toBe(true);
});
it("returns failed and keeps a usable old build when copying a fresh release fails", () => {
	const root = fixture(); const originalCopy = fs.cpSync;
	vi.spyOn(fs, "cpSync").mockImplementation((source, target, options) => {
		if (String(target).startsWith(path.join(root, ".next-releases") + path.sep)) throw new Error("simulated disk full");
		return originalCopy(source, target, options);
	});
	expect(ensureInstallBuild(root, { force: true, log: () => {}, warn: () => {} })).toBe("failed");
	expect(selectProductionBuild(root)).toEqual({ buildDir: ".next", buildId: "old-serving" });
	expect(fs.existsSync(path.join(root, ".next-releases/update.lock"))).toBe(false);
});
it("does not skip a broken release manifest just because active.json exists", () => {
	const root = fixture(); fs.mkdirSync(path.join(root, ".next-releases"));
	fs.writeFileSync(path.join(root, ".next-releases/active.json"), JSON.stringify({ schema: 1, state: "ready", buildDir: ".next-releases/missing", buildId: "missing" }));
	expect(hasProductionBuild(root)).toBe(false);
	expect(ensureInstallBuild(root, { force: true, log: () => {}, warn: () => {} })).toBe("built");
	expect(selectProductionBuild(root)?.buildId).toBe("new-ready");
});
it("keeps the active serving build when final ownership metadata cannot be written", () => {
	const root = fixture(); const originalRename = fs.renameSync;
	vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
		if (String(target).endsWith(".owner.json") && JSON.parse(fs.readFileSync(source, "utf8")).state === "ready") throw new Error("simulated metadata disk failure");
		return originalRename(source, target);
	});
	expect(ensureInstallBuild(root, { force: true, log: () => {}, warn: () => {} })).toBe("failed");
	expect(selectProductionBuild(root)).toEqual({ buildDir: ".next", buildId: "old-serving" });
});
it("syncs the candidate manifest before promotion and retains a recovery selection", () => {
	const root = fixture(); const synced: string[] = [], writes = new Map<number, string>(); const originalSync = fs.fsyncSync, originalRename = fs.renameSync, originalWrite = fs.writeFileSync;
	vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => { if (typeof target === "number") writes.set(target, String(data)); return originalWrite(target, data, options); });
	vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => { synced.push(writes.get(fd) ?? ""); return originalSync(fd); });
	vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
		if (String(target) === path.join(root, ".next-releases/active.json")) expect(synced.some((raw) => raw.includes('"state": "ready"') && raw.includes('"new-ready"'))).toBe(true);
		return originalRename(source, target);
	});
	expect(ensureInstallBuild(root, { force: true, log: () => {}, warn: () => {} })).toBe("built");
	fs.writeFileSync(path.join(root, ".next-releases/active.json"), "{");
	expect(selectProductionBuild(root)?.buildId).toBe("new-ready");
});

it("repairs an incomplete production installation before constructing its final launch plan", async () => {
	const root = fixture(); fs.renameSync(path.join(root, ".next/required-server-files.json"), path.join(root, ".next/required-server-files.saved"));
	const spawn = vi.fn(() => { const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }); setImmediate(() => child.emit("exit", 0)); return child; });
	expect(await runLauncher({ root, args: ["--no-open"], env: { PIWEB_SKIP_WARMUP: "1" }, dependencies: { spawn, probePort: async () => "free", isPiWebRunning: async () => false, readHttpProxySetting: () => null, readSystemProxy: () => null, log: vi.fn(), warn: vi.fn() } })).toBe(0);
	expect(runner.spawnSync).toHaveBeenCalledTimes(1);
	expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["start"]), expect.objectContaining({ env: expect.objectContaining({ PIWEB_BUILD_DIR: expect.stringMatching(/^\.next-releases\/install-/), PI_WEB_AUTH: "1" }) }));
	expect(fs.readFileSync(path.join(root, ".next/BUILD_ID"), "utf8")).toBe("old-serving");
});

it("does not start a child or probe a port when production build repair fails", async () => {
	const root = fixture(); fs.renameSync(path.join(root, ".next/required-server-files.json"), path.join(root, ".next/required-server-files.saved"));
	runner.spawnSync.mockReturnValue({ status: 1 });
	const spawn = vi.fn(), probePort = vi.fn();
	await expect(runLauncher({ root, args: ["--no-open"], env: {}, dependencies: { spawn, probePort, log: vi.fn(), warn: vi.fn() } })).rejects.toThrow(/无法准备生产构建/);
	expect(spawn).not.toHaveBeenCalled(); expect(probePort).not.toHaveBeenCalled();
});
