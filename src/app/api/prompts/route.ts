import { NextResponse } from "next/server";
import { listPromptSources, readPromptSource } from "@/lib/prompt-sources";
import { getManaged } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath, resolveWorkspacePath } from "@/lib/path-security";
import { APP_ROOT } from "@/lib/app-root";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/**
 * 提示词来源面板的数据口：
 * - GET  ?cwd=<工作区>&session=<会话 id>：列出所有提示词来源；会话已热时附带"组装后的系统提示词"与工具定义
 * - POST { action: "read", filePath }：按需读取单个来源的内容
 * 只读，不改动任何提示词内容。
 */
async function promptSession(sessionId: string | null) {
	if (!sessionId) return {};
	try {
		// sessionId 是客户端已有的 base64url 编码 id（与 /api/agent/<id> 同一套），不要再编码一次
		const sessionPath = await resolveSessionPath(sessionId, { allowPending: true });
		const managed = getManaged(sessionPath);
		return { session: managed.session, sessionManager: managed.sm };
	} catch {
		// 会话路径不合法或已消失：退化为"只列文件来源"，不因此让整个面板失败
		return {};
	}
}

export async function GET(req: Request) {
	try {
		const url = new URL(req.url);
		const cwd = await resolveWorkspacePath(url.searchParams.get("cwd") || APP_ROOT);
		const session = await promptSession(url.searchParams.get("session"));
		const data = await listPromptSources({ cwd, ...session });
		return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		return NextResponse.json({ success: false, ...apiError(err, "提示词来源读取失败，请检查配置后重试。") }, { status: err instanceof BoundaryError ? 400 : 500, headers: { "Cache-Control": "no-store" } });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as { action?: string; filePath?: string; cwd?: string; sourcePath?: string };
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoundaryError("请提供有效的提示词读取参数。");
		if (body.action !== "read") return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
		if (!body.filePath) return NextResponse.json({ success: false, error: "missing filePath" }, { status: 400 });
		const cwd = await resolveWorkspacePath(body.cwd || APP_ROOT);
		return NextResponse.json({ success: true, data: { content: await readPromptSource(body.filePath, cwd, body.sourcePath) } }, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		return NextResponse.json({ success: false, ...apiError(err, "提示词正文读取失败，请检查文件后重试。") }, { status: err instanceof BoundaryError || err instanceof SyntaxError ? 400 : 500, headers: { "Cache-Control": "no-store" } });
	}
}
