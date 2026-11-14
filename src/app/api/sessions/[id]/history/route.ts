import { NextResponse } from "next/server";
import { getManaged, getSessionHistory } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

function offset(value: string | null): number | undefined {
	if (value === null) return undefined;
	if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new BoundaryError("invalid history cursor");
	return Number(value);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const query = new URL(req.url).searchParams;
		const before = offset(query.get("before")); const after = offset(query.get("after"));
		const limit = offset(query.get("limit")) ?? 100;
		if ((before !== undefined && after !== undefined) || limit < 1 || limit > 100) throw new BoundaryError("invalid history page");
		const sessionPath = await resolveSessionPath(id);
		const data = await getSessionHistory(getManaged(sessionPath), { before, after, limit });
		return NextResponse.json({ success: true, data }, { headers });
	} catch (error) {
		return NextResponse.json({ success: false, error: error instanceof BoundaryError ? "无法读取这页聊天记录，请重新打开会话。" : "聊天记录暂时无法读取，请稍后重试。" }, { status: error instanceof BoundaryError ? 400 : 500, headers });
	}
}
