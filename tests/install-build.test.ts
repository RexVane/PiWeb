/**
 * install-build 的 staging 目录布局：必须逃出所有 node_modules 路径段。
 * Next.js 排除 node_modules 下的源码（不转译 TS、不解析 @/* 别名），
 * scoped 全局安装（~/.local/lib/node_modules/@rexvane/piweb）的祖先目录
 * 就是 node_modules，staging 若落在那里构建必败（Mac 0.3.4 的现场）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertStagingOutsideNodeModules } from "../scripts/install-build.mjs";

describe("install-build staging layout", () => {
	const layouts: Array<[string, string]> = [
		["mac scoped global", "/Users/kaijimima/.local/lib/node_modules/@rexvane/piweb"],
		["win scoped global", "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@rexvane\\piweb"],
		["pnpm deep nesting", "/home/u/proj/node_modules/.pnpm/@rexvane+piweb@0.3.4/node_modules/@rexvane/piweb"],
		["unscoped project dep", "/home/u/proj/node_modules/piweb"],
		["repo checkout", "/home/u/PiWeb"],
	];

	it("places the staging directory outside every node_modules for all install layouts", () => {
		for (const [name, root] of layouts) {
			const parent = assertStagingOutsideNodeModules(root);
			expect(parent.split(/[\\/]/), name).not.toContain("node_modules");
		}
	});

	it("falls back to the OS temp dir when the computed parent is not writable", () => {
		// 根分区不可写（如 /proc）：candidate 创建失败时退回 tmpdir
		const parent = assertStagingOutsideNodeModules("/proc/node_modules/@rexvane/piweb");
		expect(parent.split(/[\\/]/)).not.toContain("node_modules");
	});

	it("keeps staging on the package's own volume (cross-volume links break webpack)", () => {
		// 跨卷的 node_modules 链接会让 webpack 解析出 "./D:/..." 这种模块路径，构建必败
		// （Windows 全局装到 D: 而 staging 落到 C:\...\Temp 的现场）。
		const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-staging-"));
		try {
			const parent = assertStagingOutsideNodeModules(path.join(prefix, "node_modules", "@rexvane", "piweb"));
			expect(parent).toBe(prefix);
			expect(path.parse(parent).root).toBe(path.parse(prefix).root);
			expect(parent.split(/[\\/]/)).not.toContain("node_modules");
		} finally {
			fs.rmSync(prefix, { recursive: true, force: true });
		}
	});

	it("does not create directories for simulated foreign layouts", () => {
		// 测试夹具里的路径并不存在：stagingParent 只挑选已存在的可写目录，不能 mkdir。
		const ghost = "/piweb-staging-does-not-exist-2f4c/node_modules/@rexvane/piweb";
		const parent = assertStagingOutsideNodeModules(ghost);
		expect(parent).not.toBe(ghost);
		expect(fs.existsSync(ghost)).toBe(false);
		expect(parent.split(/[\\/]/)).not.toContain("node_modules");
	});
});
