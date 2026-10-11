/**
 * 「远程连接」内置插件的控制接口。
 *
 * GET    当前状态（局域网入口 + 公网入口）
 * POST   { action: "start" | "stop" | "start-lan" | "stop-lan" }
 * DELETE 全停
 *
 * 「谁能调这个接口」由 proxy.ts 把关；但「现在能不能开入口」必须在这里再看一次：
 * 认证没开时 proxy 一律放行，这时开出去的局域网 / 公网入口就是一个免密 shell。
 */
import { NextResponse } from "next/server";
import { remoteBlocked, remoteStatus, startLan, startPublic, stopAll, stopPublic } from "@/lib/remote/supervisor";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function respond() {
	return NextResponse.json({ success: true, data: remoteStatus() }, { headers: NO_STORE });
}

function bad(error: string, status = 400) {
	return NextResponse.json({ success: false, error }, { status, headers: NO_STORE });
}

export async function GET() {
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
		case "stop-lan":
			await stopAll();
			return respond();
		default:
			return bad("unknown action");
	}
}

export async function DELETE() {
	await stopAll();
	return respond();
}
