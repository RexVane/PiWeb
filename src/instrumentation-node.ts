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

	// 延迟启动检查：避免在冷启动阶段导入更新模块或发起网络查询，优先保障首屏就绪。
	if (process.env.PI_WEB_UPDATE_CHECK !== "0") {
		const updateTimer = setTimeout(() => {
			void import("./lib/update/startup-check").then(({ ensureStartupCheck }) => ensureStartupCheck()).catch(() => {});
		}, 2500);
		updateTimer.unref?.();
	}

	// 生产模式下等健康检查就绪并拉起浏览器后，在后台预热会话/工作区/模型目录，与浏览器加载并行。
	if (process.env.NODE_ENV === "production" && !process.env.VITEST && process.env.PIWEB_SKIP_WARMUP !== "1") {
		const warmTimer = setTimeout(() => {
			void Promise.allSettled([
				import("./lib/session-reader").then(({ listSessions }) => listSessions()),
				import("./lib/workspace-store").then(({ getWorkspaceRegistry }) => getWorkspaceRegistry()),
				import("./lib/models-service").then(({ listModelsForPiWeb }) => listModelsForPiWeb()),
			]);
		}, 80);
		warmTimer.unref?.();
	}

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

	void ensureRemoteAccess().then((state) => {
		if (state.lan.running) {
			console.log(`[远程连接] 局域网已就绪，公网正在自动准备：${state.lan.urls.join("  ")}`);
		} else {
			console.warn(`[远程连接] 局域网入口启动失败：${state.lan.error}`);
		}
	}).catch((error) => {
		console.warn(`[远程连接] 局域网入口启动失败：${error instanceof Error ? error.message : String(error)}`);
	});
}
