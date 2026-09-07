import { NextResponse } from "next/server";
import { createNewSession } from "@/lib/agent-manager";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as { cwd?: unknown };
		const cwd = await resolveWorkspacePath(body.cwd ?? process.cwd());
		const { sessionPath } = await createNewSession(cwd);
		return NextResponse.json({ success: true, data: { sessionPath } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500 },
		);
	}
}
