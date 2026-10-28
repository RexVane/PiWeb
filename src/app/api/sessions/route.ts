import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { listSessions } from "@/lib/session-reader";
import { activeStatus, warmSessionResources } from "@/lib/agent-manager";
import { canonicalWorkspacePath, getWorkspaceRegistry, registerCwds } from "@/lib/workspace-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	try {
		const q = new URL(req.url).searchParams.get("q") ?? undefined;
		const listed = await listSessions(q);
		const cwds = new Map([...new Set(listed.map((session) => session.cwd))].map((cwd) => [cwd, canonicalWorkspacePath(cwd)]));
		// CLI 会话头保留启动时的符号链接拼写；只统一列表身份，不改原始 JSONL。
		const sessions = await Promise.all(listed.map(async (session) => ({ ...session, cwd: await cwds.get(session.cwd)! })));
		// 侧栏一拿到列表就预热最近那个工作区的资源发现（约 140ms），别等用户点开会话才做
		warmSessionResources(sessions.slice(0, 1).map((session) => session.cwd));
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
