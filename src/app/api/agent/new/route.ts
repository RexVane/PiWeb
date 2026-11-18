import { NextResponse } from "next/server";
import { createNewSession } from "@/lib/agent-manager";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";
import { APP_ROOT } from "@/lib/app-root";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			cwd?: unknown;
			provider?: unknown;
			modelId?: unknown;
			thinking?: unknown;
		};
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoundaryError("请提供有效的会话参数。");
		let provider: string | undefined;
		let modelId: string | undefined;
		if (body.provider !== undefined || body.modelId !== undefined) {
			if (typeof body.provider !== "string" || !body.provider.trim() || typeof body.modelId !== "string" || !body.modelId.trim()) {
				throw new BoundaryError("请提供完整的模型参数。");
			}
			provider = body.provider.trim();
			modelId = body.modelId.trim();
		}
		let thinking: string | undefined;
		if (body.thinking !== undefined && body.thinking !== null) {
			if (typeof body.thinking !== "string") throw new BoundaryError("请提供有效的思考级别。");
			const trimmed = body.thinking.trim();
			if (trimmed) thinking = trimmed;
		}
		const cwd = await resolveWorkspacePath(body.cwd ?? APP_ROOT);
		const hasSetupOptions = Boolean((provider && modelId) || thinking);
		const { sessionPath, setupApplied } = await createNewSession(
			cwd,
			hasSetupOptions ? { provider, modelId, thinking } : undefined,
		);
		return NextResponse.json(
			{ success: true, data: { sessionPath, ...(setupApplied ? { setupApplied: true } : {}) } },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "创建会话失败，请检查工作区权限后重试。") },
			{ status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500, headers: { "Cache-Control": "no-store" } },
		);
	}
}
