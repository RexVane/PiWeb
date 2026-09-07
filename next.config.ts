import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Keep dev output separate so `next build` cannot invalidate a running dev server.
	distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
	// pi SDK 与其动态加载的扩展都运行在服务端（Node runtime），不对客户端打包
	serverExternalPackages: ["@earendil-works/pi-coding-agent"],
};

export default nextConfig;
