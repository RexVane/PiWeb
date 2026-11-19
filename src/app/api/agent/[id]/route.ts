import { NextResponse } from "next/server";
import { execute, getManaged } from "@/lib/agent-manager";
import { parseAgentCommand } from "@/lib/command-validation";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const sessionPath = await resolveSessionPath(id, { allowPending: true });
		const parsed = parseAgentCommand(await req.json());
		if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
		const result = await execute(getManaged(sessionPath), parsed.command);
		if (!result.ok) return NextResponse.json({ success: false, ...apiError(new BoundaryError(result.error ?? "操作未完成，请重试。", result.errorCode)), ...(result.data ? { data: result.data } : {}) }, { status: result.errorCode === "QUEUE_CHANGED" ? 409 : 400, headers: { "Cache-Control": "no-store" } });
		return NextResponse.json({ success: true, data: result.data ?? {} }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "会话操作失败，请检查配置或稍后重试。") },
			{ status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500, headers: { "Cache-Control": "no-store" } },
		);
	}
}
