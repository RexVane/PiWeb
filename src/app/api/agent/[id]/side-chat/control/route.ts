import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { parseAgentCommand } from "@/lib/command-validation";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";
import { parseSideChatRequest } from "@/lib/side-chat/context";
import { controlSideChat } from "@/lib/side-chat/runtime";
import type { SideChatControl } from "@/lib/side-chat/types";
export const dynamic = "force-dynamic";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const sessionPath = await resolveSessionPath(id, { allowPending: true });
		const body = await req.json();
		const parsed = parseAgentCommand(body?.command);
		if (!parsed.ok) throw new BoundaryError(parsed.error);
		const request = parseSideChatRequest({ ...body, kind: "prepare", requestId: randomUUID(), text: "", history: body?.history ?? [] });
		const data = await controlSideChat(sessionPath, { ...request, command: parsed.command } as SideChatControl);
		return NextResponse.json({ success: true, data });
	} catch (error) {
		return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "side-chat command failed" }, { status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500 });
	}
}
