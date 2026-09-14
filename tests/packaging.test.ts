/**
 * 成品发布的打包契约。
 *
 * `files` 是白名单，逐一列举 Next 内部文件非常脆弱：0.3.7 只列了 .next/server 等子目录，
 * 结果漏掉 .next 根下全部运行时清单（required-server-files.json 等），用户 `npm i -g` 装得上、
 * 一执行 piweb 就崩在缺清单上。这里钉住三件事：
 *   1. 白名单必须以整个 .next 为单位（不要退回逐个列举）；
 *   2. 残缺构建要被识别为「没有可用构建」，从而走一次性重建而不是崩溃；
 *   3. 发布闸门用真实 tarball 解包后校验，白名单漏文件时直接失败。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readProductionBuild } from "../scripts/build-output.mjs";
import { hasProductionBuild } from "../scripts/install-build.mjs";
import { verifyPackedPackage } from "../scripts/verify-package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function tempDir(prefix: string) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

/** 与 launcher 测试同构的最小可用构建。 */
async function writeBuild(root: string, { buildId = true, manifests = true } = {}) {
	const buildDir = path.join(root, ".next");
	const files = ["routes-manifest.json", "build-manifest.json", "prerender-manifest.json", "server/app-paths-manifest.json"];
	for (const file of files) {
		const full = path.join(buildDir, file);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, "{}");
	}
	if (!buildId) return;
	await fs.writeFile(path.join(buildDir, "BUILD_ID"), "build-id");
	if (!manifests) return;
	await fs.writeFile(path.join(buildDir, "required-server-files.json"), JSON.stringify({
		version: 1, config: { distDir: ".next" }, files: files.map((file) => `.next/${file}`),
	}));
}

describe("published package covers the whole production build", () => {
	it("whitelists .next as a directory instead of enumerating Next internals", async () => {
		const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
		expect(manifest.files).toContain(".next");
		// 逐个列举 .next/xxx 的做法会随 Next 版本漂移，正是漏掉运行时清单的原因。
		expect(manifest.files.filter((entry: string) => entry.startsWith(".next/"))).toEqual([]);
	});

	it("treats a BUILD_ID without its runtime manifests as no usable build (self-heal path)", async () => {
		const root = await tempDir("piweb-truncated-");
		await writeBuild(root, { manifests: false });
		expect(hasProductionBuild(root)).toBe(false);
		await writeBuild(root, { manifests: true });
		expect(hasProductionBuild(root)).toBe(true);
	});

	it("names the missing manifest and the fix instead of a bare ENOENT path", async () => {
		const root = await tempDir("piweb-truncated-");
		await writeBuild(root, { manifests: false });
		await expect(async () => readProductionBuild(root, ".next")).rejects.toThrow(/required-server-files\.json[\s\S]*npm install -g @rexvane\/piweb@latest/);
	});
});

describe("release gate on the real tarball", () => {
	/** 造一个待打包的最小包；`files` 由用例决定，用来复现白名单漏文件。 */
	async function fakePackage(files: string[], extra: (root: string) => Promise<void>) {
		const root = await tempDir("piweb-pack-");
		await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
			name: "piweb-pack-fixture", version: "0.0.0", files,
		}));
		await extra(root);
		return root;
	}

	it("passes for a package that ships a complete build", async () => {
		const root = await fakePackage([".next"], (dir) => writeBuild(dir));
		const result = await verifyPackedPackage(root, { log: () => {} });
		expect(result.buildId).toBe("build-id");
		expect(result.files).toContain(".next/required-server-files.json");
	}, 60_000);

	it("fails when the whitelist omits a runtime manifest (the 0.3.7 bug)", async () => {
		const root = await fakePackage([".next/BUILD_ID", ".next/server"], (dir) => writeBuild(dir));
		await expect(async () => verifyPackedPackage(root, { log: () => {} })).rejects.toThrow(/incomplete production build/);
	}, 60_000);

	it("fails when the build cache sneaks into the tarball", async () => {
		const root = await fakePackage([".next"], async (dir) => {
			await writeBuild(dir);
			await fs.mkdir(path.join(dir, ".next", "cache"), { recursive: true });
			await fs.writeFile(path.join(dir, ".next", "cache", "blob"), "x");
		});
		await expect(async () => verifyPackedPackage(root, { log: () => {} })).rejects.toThrow(/build cache/);
	}, 60_000);
});
