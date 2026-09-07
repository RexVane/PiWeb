import { NextResponse } from "next/server";
import { listSessions } from "@/lib/session-reader";
import { activeStatus } from "@/lib/agent-manager";
import { getWorkspaceRegistry, registerCwds } from "@/lib/workspace-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	try {
		const q = new URL(req.url).searchParams.get("q") ?? undefined;
		const sessions = await listSessions(q);
		await registerCwds(sessions.map((session) => session.cwd));
		const workspaceRegistry = await getWorkspaceRegistry();
		return NextResponse.json({ success: true, data: { sessions, running: activeStatus(), workspaceRegistry } });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}
