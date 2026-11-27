import { NextResponse } from "next/server";
import { getEffectiveContext, getManaged } from "@/lib/agent-manager";
import { apiError } from "@/lib/api-error";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 读取当前会话「真正有效」的上下文内容明细（按 ContextMeter 11 类整理）：
 * 直接基于 Pi SDK 的 buildSessionProjection() 与当前会话注入状态，只读不落盘。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const sessionPath = await resolveSessionPath(id, { allowPending: true });
		const data = await getEffectiveContext(getManaged(sessionPath));
		return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		return NextResponse.json(
			{ success: false, ...apiError(err, "有效上下文读取失败，请检查会话状态后重试。") },
			{ status: err instanceof BoundaryError ? 400 : 500, headers: { "Cache-Control": "no-store" } },
		);
	}
}
