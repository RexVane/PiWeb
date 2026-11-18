import { createHash } from "node:crypto";
import { after, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { sortArchivedSessions } from "@/lib/archived-sessions-sort";
import { listSessions } from "@/lib/session-reader";
import { activeStatus, warmSessionResources } from "@/lib/agent-manager";
import { canonicalWorkspacePath, getWorkspaceRegistry } from "@/lib/workspace-store";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	try {
		const params = new URL(req.url).searchParams;
		const q = params.get("q") ?? undefined;
		const offset = params.has("offset") ? Number(params.get("offset")) : 0;
		const limit = params.has("limit") ? Number(params.get("limit")) : null;
		if (!Number.isSafeInteger(offset) || offset < 0 || (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))) {
			return NextResponse.json({ success: false, error: "invalid session pagination", errorCode: "VALIDATION_ERROR" }, { status: 400, headers: { "Cache-Control": "no-store" } });
		}
		const listed = await listSessions(q);
		// canonicalWorkspacePath 是异步的：必须在这里解析完再放进响应，否则 JSON 会把
		// Promise 序列化成 `{}`（侧栏随后在 cwd.replace 上崩溃）。
		const cwds = new Map(await Promise.all(
			[...new Set(listed.map((session) => session.cwd))].map(async (cwd) => [cwd, await canonicalWorkspacePath(cwd)] as const),
		));
		// CLI 会话头保留启动时的符号链接拼写；只统一列表身份，不改原始 JSONL。
		const sessions = listed.map((session) => ({ ...session, cwd: cwds.get(session.cwd)! }));
		const recentCwds = sessions.slice(0, 1).map((session) => session.cwd);
		const workspaceRegistry = await getWorkspaceRegistry();
		// CLI-discovered workspaces belong in this response without forcing a
		// GET request to acquire a write lock or modify the user's registry.
		const keyOf = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
		const removed = new Set(workspaceRegistry.removedWorkspaces.map(keyOf));
		const known = new Set(workspaceRegistry.workspaces.map(keyOf));
		workspaceRegistry.workspaces = [...workspaceRegistry.workspaces];
		for (const session of sessions) if (session.cwd && !removed.has(keyOf(session.cwd)) && !known.has(keyOf(session.cwd))) {
			known.add(keyOf(session.cwd)); workspaceRegistry.workspaces.push(session.cwd);
		}
		// 侧栏每 3 秒轮询：内容没变就 304，浏览器复用缓存体（no-cache = 每次都回源校验，不会用陈旧数据）
		const keyOfSession = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
		const archived = new Set(workspaceRegistry.archivedSessions.map(keyOfSession));
		const scope = params.get("archived");
		const archiveFilter = scope === "only" || scope === "exclude";
		const visible = scope === "only"
			? sortArchivedSessions(
				sessions.filter((session) => archived.has(keyOfSession(session.path))),
				workspaceRegistry.archivedAt,
				workspaceRegistry.archivedSessions,
			)
			: scope === "exclude" ? sessions.filter((session) => !archived.has(keyOfSession(session.path))) : sessions;
		// 分页参数透传给 session-reader（不传 limit 时它返回全量，默认行为不变）。
		// 普通视图可以直接在 lib 层分页；归档视图必须先按归档状态过滤再分页，所以仍在这里切片。
		// 上面的全量 listSessions 结果还要用于工作区发现与 total，下面的调用命中它 1.2s 的列表缓存，不会重复扫盘。
		const page = limit === null
			? visible
			: archiveFilter
				? visible.slice(offset, offset + limit)
				: (await listSessions(q, { limit, offset })).map((session) => ({ ...session, cwd: cwds.get(session.cwd)! }));
		const nextOffset = limit !== null && offset + limit < visible.length ? offset + limit : null;
		const body = JSON.stringify({
			success: true,
			data: {
				sessions: page,
				running: activeStatus(),
				workspaceRegistry,
				...(limit !== null ? { total: visible.length, nextOffset } : {}),
			},
		});
		const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
		// Resource discovery can load extensions and read many source files. Start
		// it after the sidebar response is sent, not while computing that response.
		after(() => warmSessionResources(recentCwds));
		if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
		return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", ETag: etag, "Cache-Control": "private, no-cache" } });
	} catch (err: any) {
		return NextResponse.json({ success: false, ...apiError(err, "会话列表读取失败，请重试。") }, { status: 500, headers: { "Cache-Control": "no-store" } });
	}
}
