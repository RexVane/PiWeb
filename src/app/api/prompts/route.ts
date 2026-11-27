import { NextResponse } from "next/server";
import { readPromptSource } from "@/lib/prompt-sources";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";
import { APP_ROOT } from "@/lib/app-root";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/**
 * 提示词与技能文档的只读内容接口：
 * - POST { action: "read", filePath, cwd?, sourcePath? }：按已发现来源边界安全读取单个文件
 * 只读，不改动任何提示词内容。
 */
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
