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
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveReleaseRoot } from "../scripts/release.mjs";
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

/**
 * 预构建产物把「构建机」的东西一起带给了用户，这类问题只在真实安装里才暴露：
 * Next 的 server bundle 会把 import.meta.url 替换成构建时源文件的 URL，于是 0.3.8 的
 * /api/update 在 Windows 上启动即抛 ERR_INVALID_FILE_URL_PATH（CI 的 POSIX 路径放进
 * file URL 没有盘符）。这里钉住「被 src 打进 bundle 的脚本不许用 import.meta.url 定位
 * 磁盘路径」，以及根目录解析在任何平台上都不会抛。
 */
describe("bundled scripts must not depend on the build machine's paths", () => {
	/** src/ 直接 import 的脚本，以及它们互相 import 的脚本（都会进 server bundle）。 */
	async function bundledScripts() {
		const found = new Set<string>();
		const pending = [...(await fs.readFile(path.join(repoRoot, "src", "lib", "update-service.ts"), "utf8")).matchAll(/from "\.\.\/\.\.\/scripts\/([\w.-]+\.mjs)"/g)].map((m) => m[1]);
		while (pending.length) {
			const name = pending.pop() as string;
			if (found.has(name)) continue;
			found.add(name);
			const source = await fs.readFile(path.join(repoRoot, "scripts", name), "utf8");
			for (const match of source.matchAll(/from "\.\/([\w.-]+\.mjs)"/g)) pending.push(match[1]);
		}
		return [...found];
	}

	it("imports the release scripts through src/ (fixture sanity)", async () => {
		const scripts = await bundledScripts();
		expect(scripts).toContain("release.mjs");
		expect(scripts).toContain("build-output.mjs");
	});

	it("never turns import.meta.url into a filesystem path unvalidated", async () => {
		// 注释里提到这个名字是解释，不是代码；只检查真正的调用。
		const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		const unvalidated = /fileURLToPath\(\s*import\.meta\.url|dirname\(\s*import\.meta\.url|dirname\(\s*fileURLToPath\(\s*import\.meta\.url|new URL\([^)]{0,40}import\.meta\.url/;
		for (const name of await bundledScripts()) {
			const code = stripComments(await fs.readFile(path.join(repoRoot, "scripts", name), "utf8"));
			expect(code, `${name}: 打包后 import.meta.url 是构建机路径，须经 resolveReleaseRoot 校验`).not.toMatch(unvalidated);
		}
	});

	it("resolves the installation root without the module URL when it is foreign", async () => {
		const cwd = await tempDir("piweb-root-");
		const opts = { cwd, moduleUrl: "file:///home/runner/work/PiWeb/PiWeb/scripts/release.mjs" };
		// Windows: fileURLToPath 直接抛 ERR_INVALID_FILE_URL_PATH；POSIX: 路径不存在。
		expect(resolveReleaseRoot({ env: {}, ...opts })).toBe(path.resolve(cwd));
		expect(resolveReleaseRoot({ env: { PI_WEB_ROOT: cwd }, ...opts })).toBe(path.resolve(cwd));
	});

	it("still resolves a real checkout from the module URL", async () => {
		const root = await tempDir("piweb-checkout-");
		await fs.mkdir(path.join(root, "scripts"), { recursive: true });
		await fs.writeFile(path.join(root, "scripts", "release.mjs"), "");
		const moduleUrl = pathToFileURL(path.join(root, "scripts", "release.mjs")).href;
		expect(resolveReleaseRoot({ env: {}, cwd: os.tmpdir(), moduleUrl })).toBe(path.resolve(root));
	});
});
