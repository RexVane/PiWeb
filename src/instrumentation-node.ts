/**
 * 服务启动钩子的 Node 部分（只由 instrumentation.ts 在 nodejs 运行时引入）。
 *
 * 这里用到 node:child_process 等模块，edge 运行时编不过；放在单独文件里，
 * edge 那份编译就整段跳过了（见 instrumentation.ts）。
 */
export async function registerNode() {
	// 构建期也会实例化服务，别在构建机上开监听
	if (process.env.NEXT_PHASE === "phase-production-build") return;

	// 再次运行启动器时要能找回本实例的登录链接（见 publishLaunchToken）
	const { authEnabled } = await import("./lib/web-auth");
	if (authEnabled()) (await import("./lib/web-launch-token")).publishLaunchToken();

	const { remoteBlocked, remoteLanEnabled, startLan } = await import("./lib/remote/supervisor");
	if (!remoteLanEnabled()) return;

	// 局域网入口会把 PiWeb 暴露给同网段的所有设备：没认证、或是开发模式，都绝不能开。
	const blocked = remoteBlocked();
	if (blocked === "auth") {
		console.warn("[远程连接] 已跳过局域网入口：认证没开。请设 PI_WEB_AUTH=1。");
		return;
	}
	if (blocked === "dev") {
		console.warn("[远程连接] 已跳过局域网入口：开发模式只服务本机（认证保护不了 Next 开发工具端点）。");
		return;
	}

	const state = await startLan();
	if (state.running) {
		console.log(`[远程连接] 局域网入口已就绪：${state.urls.join("  ")}`);
	} else {
		console.warn(`[远程连接] 局域网入口启动失败：${state.error}`);
	}
}
