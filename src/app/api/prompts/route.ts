import { NextResponse } from "next/server";
import { listPromptSources, readPromptSource } from "@/lib/prompt-sources";
import { getManaged } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

/**
 * 提示词来源面板的数据口：
 * - GET  ?cwd=<工作区>&session=<会话 id>：列出所有提示词来源；会话已热时附带"组装后的系统提示词"与工具定义
 * - POST { action: "read", filePath }：按需读取单个来源的内容
 * 只读，不改动任何提示词内容。
 */
async function hotSession(cwd: string, sessionId: string | null) {
	if (!sessionId) return null;
	try {
		// sessionId 是客户端已有的 base64url 编码 id（与 /api/agent/<id> 同一套），不要再编码一次
		const sessionPath = await resolveSessionPath(sessionId, { allowPending: true });
		const managed = getManaged(sessionPath);
		return managed.session ?? null;
	} catch {
		// 会话路径不合法或已消失：退化为"只列文件来源"，不因此让整个面板失败
		return null;
	}
}

export async function GET(req: Request) {
	try {
		const url = new URL(req.url);
		const cwd = await resolveWorkspacePath(url.searchParams.get("cwd") || process.cwd());
		const sessionId = url.searchParams.get("session");
		const data = await listPromptSources({ cwd, session: await hotSession(cwd, sessionId) });
		return NextResponse.json({ success: true, data });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ success: false, error: message }, { status: err instanceof BoundaryError ? 400 : 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as { action?: string; filePath?: string; cwd?: string };
		if (body.action !== "read") return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
		if (!body.filePath) return NextResponse.json({ success: false, error: "missing filePath" }, { status: 400 });
		const cwd = await resolveWorkspacePath(body.cwd || process.cwd());
		return NextResponse.json({ success: true, data: { content: await readPromptSource(body.filePath, cwd) } });
	} catch (err) {
		const message = err instanceof Error ? err.message : "request failed";
		return NextResponse.json({ success: false, error: message }, { status: err instanceof BoundaryError ? 400 : 500 });
	}
}
