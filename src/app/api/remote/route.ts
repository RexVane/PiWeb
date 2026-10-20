/**
 * 「远程连接」内置插件的控制接口。
 *
 * GET    当前状态（插件开关 + 局域网入口 + 公网入口 + 拼登录链接用的启动令牌）
 * POST   { action: "start" | "stop" | "start-lan" | "stop-lan" | "set-plugin" }
 * DELETE 全停
 *
 * 「谁能调这个接口」由 proxy.ts 把关；但「现在能不能开入口」必须在这里再看一次：
 * 认证没开时 proxy 一律放行，这时开出去的局域网 / 公网入口就是一个免密 shell。
 */
import { NextResponse } from "next/server";
import { refreshPublicStatus, remoteBlocked, remoteLanEnabled, remoteStatus, setRemotePluginEnabled, startLan, startPublic, stopAll, stopLan, stopPublic } from "@/lib/remote/supervisor";
import { authEnabled } from "@/lib/web-auth";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 本次启动的令牌：设置页拿它拼带令牌的入口链接，手机打开就直接登录，不用再去终端里抄。
 * 能调到这个接口的已经是登录过的设备（proxy.ts 把关），它们本来就有完整权限，拿到令牌不多出任何能力；
 * 认证没开时没有令牌这回事。
 */
function loginToken(): string | null {
	return authEnabled() ? process.env.PI_WEB_LAUNCH_TOKEN || null : null;
}

function respond() {
	return NextResponse.json({ success: true, data: { ...remoteStatus(), loginToken: loginToken() } }, { headers: NO_STORE });
}

function bad(error: string, status = 400) {
	return NextResponse.json({ success: false, error }, { status, headers: NO_STORE });
}

export async function GET() {
	await refreshPublicStatus();
	return respond();
}

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return bad("invalid JSON body");
	}
	const action = typeof body === "object" && body !== null && !Array.isArray(body)
		? (body as { action?: unknown }).action
		: undefined;
	if (action === "start" || action === "start-lan") {
		const blocked = remoteBlocked();
		if (blocked === "auth") return bad("remote access requires authentication (PI_WEB_AUTH=1)", 409);
		if (blocked === "dev") return bad("remote access is disabled in development mode", 409);
	}
	switch (action) {
		case "start":
			await startLan();
			await startPublic();
			return respond();
		case "stop":
			await stopPublic();
			return respond();
		case "start-lan":
			await startLan();
			return respond();
		// 只停局域网入口。原先这里调的是 stopAll()，会连公网隧道一起杀掉——
		// 与动作名不符，也让「只关局域网」变得做不到。
		case "stop-lan":
			await stopLan();
			return respond();
		case "set-plugin": {
			// 内置插件总开关。关掉后：不再注入手机排版、公网入口也必须停（它依赖插件）；
			// 局域网入口**保留**，退化成纯转发，自建反代指向同一个端口照旧可用。
			const enabled = (body as { enabled?: unknown }).enabled;
			if (typeof enabled !== "boolean") return bad("enabled must be a boolean");
			const before = remoteStatus();
			setRemotePluginEnabled(enabled);
			if (!enabled) await stopPublic();
			// 注入资源是在建监听时就烧进去的，所以必须重建监听，开关才真正生效；
			// 重建只在「原监听需要换模式」时做，避免白断一次连接。
			if (before.lan.running && before.lan.styled !== enabled) await stopLan();
			// 起监听与启动时（instrumentation-node）同一道闸：认证没开 / 开发模式 / PIWEB_REMOTE_LAN=0 时
			// 只存开关，不开局域网入口——否则拨一下开关就绕过 start-lan 的检查开出一个免密入口。
			if (remoteBlocked() === null && remoteLanEnabled()) await startLan();
			return respond();
		}
		default:
			return bad("unknown action");
	}
}

export async function DELETE() {
	await stopAll();
	return respond();
}
