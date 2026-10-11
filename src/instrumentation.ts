/**
 * 服务启动钩子：「远程连接」内置插件的局域网入口在这里拉起。
 *
 * 为什么必须在这里：局域网入口要「默认就在跑」（手机连同一个 WiFi 就能用），
 * 而 Next 的请求处理里没有「服务刚起来」这个时机 —— instrumentation 的 register()
 * 是官方给的入口，而且它返回前服务不会开始处理请求。
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	// 构建期也会实例化服务，别在构建机上开监听
	if (process.env.NEXT_PHASE === "phase-production-build") return;

	const { remoteLanEnabled, remoteLanPort, startLan } = await import("./lib/remote/supervisor");
	if (!remoteLanEnabled()) return;

	const { authEnabled } = await import("./lib/web-auth");
	if (!authEnabled()) {
		// 局域网入口会把 PiWeb 暴露给同网段的所有设备，没认证就绝不能开。
		console.warn("[远程连接] 已跳过局域网入口：认证没开。请设 PI_WEB_AUTH=1。");
		return;
	}

	const state = await startLan(remoteLanPort());
	if (state.running) {
		console.log(`[远程连接] 局域网入口已就绪：${state.urls.join("  ")}`);
	} else {
		console.warn(`[远程连接] 局域网入口启动失败：${state.error}`);
	}
}
