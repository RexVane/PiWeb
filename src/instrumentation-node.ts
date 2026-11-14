/**
 * 服务启动钩子的 Node 部分（只由 instrumentation.ts 在 nodejs 运行时引入）。
 *
 * 这里用到 node:child_process 等模块，edge 运行时编不过；放在单独文件里，
 * edge 那份编译就整段跳过了（见 instrumentation.ts）。
 */
export async function registerNode() {
	// 构建期也会实例化服务，别在构建机上开监听
	if (process.env.NEXT_PHASE === "phase-production-build") return;

	// 直接使用 Next 启动时也常设认证；启动器已经提供的凭据保持不变。
	if (!process.env.PI_WEB_AUTH?.trim()) process.env.PI_WEB_AUTH = "1";
	// 再次运行启动器时要能找回本实例的登录链接（见 publishLaunchToken）
	const { authEnabled } = await import("./lib/web-auth");
	if (authEnabled()) {
		process.env.PI_WEB_LAUNCH_TOKEN ||= (await import("node:crypto")).randomBytes(32).toString("base64url");
		(await import("./lib/web-launch-token")).publishLaunchToken();
	}

	// 每次启动检查一次 PiWeb / pi 有没有新版本：不等结果，查到了在终端打一行，页面右下角也会提醒
	void (await import("./lib/update/startup-check")).ensureStartupCheck().catch(() => {});

	// 自动化任务调度器：按调度规则在后台为启用任务拉起独立会话执行
	(await import("./lib/automations/runner")).startAutomationScheduler();

	const { remoteBlocked, remoteLanEnabled, ensureRemoteAccess } = await import("./lib/remote/supervisor");
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

	const state = await ensureRemoteAccess();
	if (state.lan.running) {
		console.log(`[远程连接] 局域网已就绪，公网正在自动准备：${state.lan.urls.join("  ")}`);
	} else {
		console.warn(`[远程连接] 局域网入口启动失败：${state.lan.error}`);
	}
}
