import { NextResponse } from "next/server";
import { createNewSession } from "@/lib/agent-manager";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";
import { APP_ROOT } from "@/lib/app-root";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as { cwd?: unknown };
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoundaryError("请提供有效的会话参数。");
		const cwd = await resolveWorkspacePath(body.cwd ?? APP_ROOT);
		const { sessionPath } = await createNewSession(cwd);
		return NextResponse.json({ success: true, data: { sessionPath } }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "创建会话失败，请检查工作区权限后重试。") },
			{ status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500, headers: { "Cache-Control": "no-store" } },
		);
	}
}
