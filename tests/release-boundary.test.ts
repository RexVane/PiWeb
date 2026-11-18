import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeBuildInventory, readProductionBuild, selectProductionBuild, assertReleaseCapacity } from "../scripts/build-output.mjs";
import { acquireFileLock } from "../scripts/file-lock.mjs";
import { isolatedCommandEnv, exactRegistryVersion, OFFICIAL_REGISTRY_ARGS } from "../scripts/update-environment.mjs";
import { recycleFixture } from "./fixtures/recycle";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await recycleFixture(root); });
async function fixture(buildDir = ".next-releases/ready") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-release-boundary-")); roots.push(root);
	const files = ["BUILD_ID", "routes-manifest.json", "build-manifest.json", "prerender-manifest.json", "server/app-paths-manifest.json", "server/chunks/hidden.js"];
	for (const file of files) { const target = path.join(root, buildDir, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file === "BUILD_ID" ? "complete" : file.endsWith(".js") ? "module.exports=1" : "{}"); }
	await fs.writeFile(path.join(root, buildDir, "required-server-files.json"), JSON.stringify({ version: 1, config: { distDir: buildDir }, files: files.slice(0, 5).map((file) => `${buildDir}/${file}`) }));
	writeBuildInventory(root, buildDir);
	return { root, buildDir };
}
it("detects a missing chunk omitted by Next required-server-files", async () => {
	const { root, buildDir } = await fixture();
	expect(readProductionBuild(root, buildDir).buildId).toBe("complete");
	await fs.unlink(path.join(root, buildDir, "server/chunks/hidden.js"));
	expect(() => readProductionBuild(root, buildDir)).toThrow(/hidden.js.*missing/);
});
it("detects a removed inventory and changed same-length chunk", async () => {
	const a = await fixture();
	await fs.writeFile(path.join(a.root, a.buildDir, "server/chunks/hidden.js"), "module.exports=2");
	expect(() => readProductionBuild(a.root, a.buildDir)).toThrow(/changed production build/);
	const b = await fixture(); await fs.unlink(path.join(b.root, b.buildDir, "piweb-build-inventory.json"));
	expect(() => readProductionBuild(b.root, b.buildDir)).toThrow(/inventory.*missing/);
});
it("keeps the last complete release selectable while an update is building or failed", async () => {
	const { root, buildDir } = await fixture();
	for (const state of ["building", "failed"]) {
		await fs.writeFile(path.join(root, ".next-releases/active.json"), JSON.stringify({ schema: 1, state, buildDir: ".next-releases/broken", previous: { schema: 1, state: "ready", buildDir, buildId: "complete" } }));
		expect(selectProductionBuild(root)).toEqual({ buildDir, buildId: "complete" });
	}
});
it("recovers a corrupt active manifest only from a validated saved ready selection", async () => {
	const { root, buildDir } = await fixture();
	await fs.writeFile(path.join(root, ".next-releases/active.json"), "");
	expect(() => selectProductionBuild(root)).toThrow(/no saved ready selection/);
	await fs.writeFile(path.join(root, ".next-releases/last-ready.json"), JSON.stringify({ schema: 1, state: "ready", buildDir, buildId: "complete" }));
	expect(selectProductionBuild(root)).toEqual({ buildDir, buildId: "complete" });
	await fs.writeFile(path.join(root, buildDir, "server/chunks/hidden.js"), "module.exports=2");
	expect(() => selectProductionBuild(root)).toThrow(/changed production build/);
});
it("reclaims dead locks but refuses live owners and live child processes", async () => {
	const { root } = await fixture(); const file = path.join(root, "lock");
	await fs.writeFile(file, JSON.stringify({ pid: 2147483647, startedAt: "2020-01-01" }));
	const release = acquireFileLock(file);
	expect(() => acquireFileLock(file)).toThrow(/already running/);
	release();
	await fs.writeFile(file, JSON.stringify({ pid: 2147483647, children: [process.pid] }));
	expect(() => acquireFileLock(file)).toThrow(/already running/);
});
it("preserves historical directories and caps only owned inactive releases", async () => {
	const { root, buildDir } = await fixture();
	for (let i = 0; i < 15; i++) await fs.mkdir(path.join(root, ".next-releases", `historical-${i}`));
	assertReleaseCapacity(root, { PIWEB_MAX_RETAINED_RELEASES: "2" });
	await fs.cp(path.join(root, buildDir), path.join(root, ".next-releases", "second"), { recursive: true });
	expect(() => assertReleaseCapacity(root, { PIWEB_MAX_RETAINED_RELEASES: "2" })).toThrow(/archive old inactive releases manually/);
	expect((await fs.readdir(path.join(root, ".next-releases"))).length).toBe(17);
});
it("strips installer credentials and injection while pinning official scoped registries", () => {
	const env = isolatedCommandEnv({ PATH: "safe-path", PI_WEB_LAUNCH_TOKEN: "credential", PI_WEB_SECRET: "secret", NODE_OPTIONS: "--import=evil.mjs", NODE_EXTRA_CA_CERTS: "evil", NODE_TLS_REJECT_UNAUTHORIZED: "0", npm_config_registry: "http://evil", PIWEB_BUILD_DIR: ".next" });
	expect(env.PATH).toBe("safe-path");
	for (const key of ["PI_WEB_LAUNCH_TOKEN", "PI_WEB_SECRET", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "npm_config_registry", "PIWEB_BUILD_DIR"]) expect(env[key]).toBeUndefined();
	expect(OFFICIAL_REGISTRY_ARGS).toContain("--@earendil-works:registry=https://registry.npmjs.org");
	for (const raw of ["2.5.0 malicious", "2.5.0\n3.0.0", "2.0.0-beta..1", "2.0.0-01"]) expect(() => exactRegistryVersion(raw)).toThrow();
	expect(exactRegistryVersion("2.5.0-beta.1+build.2\n")).toBe("2.5.0-beta.1+build.2");
});
it("caps only newly owned failed outputs while preserving them and historical directories", async () => {
	const { root } = await fixture();
	for (let i = 0; i < 3; i++) {
		const buildDir = `.next-releases/failed-${i}`; await fs.mkdir(path.join(root, buildDir));
		await fs.writeFile(path.join(root, `${buildDir}.owner.json`), JSON.stringify({ schema: 1, buildDir, state: "failed" }));
	}
	expect(() => assertReleaseCapacity(root)).toThrow(/backups\/files.*backups\/INDEX.md/);
	expect((await fs.readdir(path.join(root, ".next-releases"))).filter((name) => name.startsWith("failed-")).length).toBe(6);
});
