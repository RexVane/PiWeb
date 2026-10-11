/**
 * 「远程连接」内置插件的控制接口。
 *
 * GET    当前状态（局域网入口 + 公网入口）
 * POST   { action: "start" | "stop" | "start-lan" | "stop-lan" }
 * DELETE 全停
 *
 * 认证不在这里重复做：proxy.ts 已经统一把关，公网一开就必须登录才能拿到这个接口。
 */
import { NextResponse } from "next/server";
import { remoteStatus, startLan, startPublic, stopAll, stopPublic } from "@/lib/remote/supervisor";

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
