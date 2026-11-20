import { NextResponse } from "next/server";
import { deleteSession, readSession } from "@/lib/session-reader";
import { disposeSessionPath } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";
import { forgetSession } from "@/lib/workspace-store";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** 冷读取（不启动 agent） */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const data = await readSession(await resolveSessionPath(id));
		return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "会话读取失败，请重试。") },
			{ status: error instanceof BoundaryError ? 400 : 500, headers: { "Cache-Control": "no-store" } },
		);
	}
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const sessionPath = await resolveSessionPath(id, { allowPending: true });
		await disposeSessionPath(sessionPath);
		const recycled = await deleteSession(sessionPath);
		let warning = recycled?.warning;
		try { await forgetSession(sessionPath); }
		catch { warning = "会话已移到系统回收站，但会话列表状态未能全部更新，请刷新列表。"; }
		return NextResponse.json({ success: true, ...(warning ? { data: { warning, warningCode: "SESSION_DELETE_PARTIAL" } } : {}) }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "会话删除失败，原会话已保留。") },
			{ status: error instanceof BoundaryError ? 400 : 500, headers: { "Cache-Control": "no-store" } },
		);
	}
}
