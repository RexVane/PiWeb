import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { resolveBuildOutput } from "./scripts/build-output.mjs";

export default (phase: string): NextConfig => {
	const development = phase === PHASE_DEVELOPMENT_SERVER;
	const devAssetId = process.env.PIWEB_DEV_ASSET_ID ?? "unversioned";
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
