import { NextResponse } from "next/server";
import { loadWorkspaceResources } from "@/lib/agent-manager";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** 新会话/冷会话的补全数据；不建会话、不启动 MCP。 */
export async function GET(req: Request) {
	try {
		const cwd = await resolveWorkspacePath(new URL(req.url).searchParams.get("cwd"));
		return NextResponse.json({ success: true, data: await loadWorkspaceResources(cwd) }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "工作区技能、插件和提示词读取失败，请检查配置后重试。") },
			{ status: error instanceof BoundaryError ? 400 : 500, headers: { "Cache-Control": "no-store" } },
		);
	}
}
