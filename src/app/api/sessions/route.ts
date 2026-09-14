import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { listSessions } from "@/lib/session-reader";
import { activeStatus } from "@/lib/agent-manager";
import { getWorkspaceRegistry, registerCwds } from "@/lib/workspace-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	try {
		const q = new URL(req.url).searchParams.get("q") ?? undefined;
		const sessions = await listSessions(q);
		await registerCwds(sessions.map((session) => session.cwd));
		const workspaceRegistry = await getWorkspaceRegistry();
		// 侧栏每 3 秒轮询：内容没变就 304，浏览器复用缓存体（no-cache = 每次都回源校验，不会用陈旧数据）
		const body = JSON.stringify({ success: true, data: { sessions, running: activeStatus(), workspaceRegistry } });
		const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
		if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
		return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", ETag: etag, "Cache-Control": "no-cache" } });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}
