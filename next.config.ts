import type { NextConfig } from "next";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { resolveBuildOutput } from "./scripts/build-output.mjs";

/**
 * 让构建期的文件追踪看不到用户主目录。
 *
 * next-trace-entrypoints-plugin 会调 @vercel/nft 静态分析服务端代码，把
 * `fs.readdir()` 的实参求值成绝对路径：session-import 的 `path.join(os.homedir(), ".grok", "sessions")`
 * 一类写法于是变成真实路径，整个 ~/.grok、~/.claude、~/.agents、~/.pi 目录被当成构建资产递归遍历。后果：
 *   1. 目录里任何一个文件读不了（权限/ACL 损坏、被独占）都会让构建以 EPERM 直接失败；
 *   2. 这些绝对路径被写进 .next/**\/*.nft.json，而 .next 随 npm 包一起发布，
 *      等于把构建者的用户名与目录布局发给了所有用户。
 * 构建期把主目录指向一个空目录即可根治：nft 解析出的路径下什么都没有，也就无从追踪。
 *
 * 只在 PHASE_PRODUCTION_BUILD 生效。`next start` 与 `next dev` 必须用真实主目录读取
 * 用户的 pi 配置与会话；dev 也不加载该追踪插件（webpack-config 里限定 !dev）。
 */
function isolateHomeFromTracing(): void {
	try {
		const isolated = path.join(os.tmpdir(), "piweb-build-home");
		fs.mkdirSync(isolated, { recursive: true });
		process.env.HOME = isolated;
		process.env.USERPROFILE = isolated;
	} catch {
		// 建不出隔离目录就维持原样：追踪照旧会扫用户目录，构建可能因不可读文件失败。
	}
}

export default (phase: string): NextConfig => {
	const development = phase === PHASE_DEVELOPMENT_SERVER;
	const devAssetId = process.env.PIWEB_DEV_ASSET_ID ?? "unversioned";
	if (phase === PHASE_PRODUCTION_BUILD) isolateHomeFromTracing();
	const buildDir = development ? ".next-dev-webpack" : resolveBuildOutput(process.cwd(), process.env.PIWEB_BUILD_DIR);
	return {
		// Keep dev output separate so `next build` cannot invalidate a running dev server.
		distDir: buildDir,
		typescript: buildDir.startsWith(".next-releases/") ? { tsconfigPath: ".next-releases/tsconfig.json" } : undefined,
		// Webpack's dev chunk names are stable. A per-process prefix prevents an older
		// browser cache entry from hydrating HTML emitted by a newer dev server.
		assetPrefix: development ? `/_piweb-dev/${devAssetId}` : undefined,
		// pi SDK 与其动态加载的扩展都运行在服务端（Node runtime），不对客户端打包
		serverExternalPackages: ["@earendil-works/pi-coding-agent"],
		// Image prompts allow 268 MB of base64 plus text and JSON framing.
		experimental: { proxyClientMaxBodySize: "272mb" },
	};
};
