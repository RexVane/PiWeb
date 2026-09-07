import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default (phase: string): NextConfig => {
	const development = phase === PHASE_DEVELOPMENT_SERVER;
	const devAssetId = process.env.PIWEB_DEV_ASSET_ID ?? "unversioned";
	return {
		// Keep dev output separate so `next build` cannot invalidate a running dev server.
		distDir: development ? ".next-dev-webpack" : ".next",
		// Webpack's dev chunk names are stable. A per-process prefix prevents an older
		// browser cache entry from hydrating HTML emitted by a newer dev server.
		assetPrefix: development ? `/_piweb-dev/${devAssetId}` : undefined,
		// pi SDK 与其动态加载的扩展都运行在服务端（Node runtime），不对客户端打包
		serverExternalPackages: ["@earendil-works/pi-coding-agent"],
	};
};
