/**
 * install-build 的 staging 目录布局：必须逃出所有 node_modules 路径段。
 * Next.js 排除 node_modules 下的源码（不转译 TS、不解析 @/* 别名），
 * scoped 全局安装（~/.local/lib/node_modules/@rexvane/piweb）的祖先目录
 * 就是 node_modules，staging 若落在那里构建必败（Mac 0.3.4 的现场）。
 */
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
});
