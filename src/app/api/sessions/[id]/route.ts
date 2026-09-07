import { NextResponse } from "next/server";
import { deleteSession, readSession } from "@/lib/session-reader";
import { disposeSessionPath } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";
import { forgetSession } from "@/lib/workspace-store";

export const dynamic = "force-dynamic";

/** 冷读取（不启动 agent） */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const data = await readSession(await resolveSessionPath(id));
		return NextResponse.json({ success: true, data });
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError ? 400 : 500 },
		);
	}
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const sessionPath = await resolveSessionPath(id);
		await disposeSessionPath(sessionPath);
		await deleteSession(sessionPath);
		await forgetSession(sessionPath);
		return NextResponse.json({ success: true });
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError ? 400 : 500 },
		);
	}
}
