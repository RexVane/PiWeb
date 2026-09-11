import { NextResponse } from "next/server";
import { execute, getManaged } from "@/lib/agent-manager";
import { parseAgentCommand } from "@/lib/command-validation";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const sessionPath = await resolveSessionPath(id, { allowPending: true });
		const parsed = parseAgentCommand(await req.json());
		if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
		const result = await execute(getManaged(sessionPath), parsed.command);
		if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 });
		return NextResponse.json({ success: true, data: result.data ?? {} });
	} catch (error) {
		const message = error instanceof Error ? error.message : "request failed";
		return NextResponse.json(
			{ success: false, error: message },
			{ status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500 },
		);
	}
}
