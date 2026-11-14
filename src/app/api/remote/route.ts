/**
 * 「远程连接」内置插件的控制接口。
 *
 * GET    当前连接状态
 * POST   { action: "connect" } 自动准备局域网与公网；旧控制动作保留兼容。
 * DELETE 全停
 *
 * 「谁能调这个接口」由 proxy.ts 把关；但「现在能不能开入口」必须在这里再看一次：
 * 认证没开时 proxy 一律放行，这时开出去的局域网 / 公网入口就是一个免密 shell。
 */
import { NextResponse } from "next/server";
import { ensureRemoteAccess, refreshPublicStatus, remoteBlocked, remoteLanEnabled, remoteStatus, setRemotePluginEnabled, startLan, startPublic, stopAll, stopLan, stopPublic } from "@/lib/remote/supervisor";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function respond() {
	return NextResponse.json({ success: true, data: remoteStatus() }, { headers: NO_STORE });
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
	if (action === "connect" || action === "start" || action === "start-lan") {
		const blocked = remoteBlocked();
		if (blocked === "auth") return bad("remote access requires authentication (PI_WEB_AUTH=1)", 409);
		if (blocked === "dev") return bad("remote access is disabled in development mode", 409);
	}
	switch (action) {
		case "connect":
			await ensureRemoteAccess();
			return respond();
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
			// 旧接口只控制手机排版注入；统一连接不再依赖插件开关。
			const enabled = (body as { enabled?: unknown }).enabled;
			if (typeof enabled !== "boolean") return bad("enabled must be a boolean");
			const before = remoteStatus();
			setRemotePluginEnabled(enabled);
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
