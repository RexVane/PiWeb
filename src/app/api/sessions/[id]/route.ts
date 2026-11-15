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
		await deleteSession(sessionPath);
		await forgetSession(sessionPath);
		return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "会话删除失败，原会话已保留。") },
			{ status: error instanceof BoundaryError ? 400 : 500, headers: { "Cache-Control": "no-store" } },
		);
	}
}
