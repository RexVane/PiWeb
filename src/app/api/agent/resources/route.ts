import { NextResponse } from "next/server";
import { loadWorkspaceResources } from "@/lib/agent-manager";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

/** 新会话/冷会话的补全数据；不建会话、不启动 MCP。 */
export async function GET(req: Request) {
	try {
		const cwd = await resolveWorkspacePath(new URL(req.url).searchParams.get("cwd"));
		return NextResponse.json({ success: true, data: await loadWorkspaceResources(cwd) });
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError ? 400 : 500 },
		);
	}
}
