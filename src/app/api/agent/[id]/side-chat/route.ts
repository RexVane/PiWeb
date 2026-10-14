import { NextResponse } from "next/server";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";
import { parseSideChatRequest } from "@/lib/side-chat/context";
import { pollSideChat, startSideChat, stopSideChat } from "@/lib/side-chat/service";
import { isSideChatId, SIDE_CHAT_BODY_LIMIT } from "@/lib/side-chat/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type RouteParams = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "no-store" };

function failure(error: unknown): NextResponse {
	return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "side-chat request failed" }, {
		status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500, headers,
	});
}

async function readBody(req: Request): Promise<unknown> {
	if (!req.body) throw new BoundaryError("missing side-chat request");
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > SIDE_CHAT_BODY_LIMIT) {
				await reader.cancel();
				throw new BoundaryError("side-chat history is too large; start a new side chat");
			}
			chunks.push(chunk.value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		reader.releaseLock();
	}
}

export async function POST(req: Request, { params }: RouteParams) {
	try {
		const { id } = await params;
		const sessionPath = await resolveSessionPath(id, { allowPending: true });
		const request = parseSideChatRequest(await readBody(req));
		if (req.signal.aborted) throw new BoundaryError("side-chat request was cancelled");
		return NextResponse.json({ success: true, data: startSideChat(sessionPath, request) }, { headers });
	} catch (error) {
		return failure(error);
	}
}

export async function GET(req: Request, { params }: RouteParams) {
	try {
		const { id } = await params;
		const sessionPath = await resolveSessionPath(id, { allowPending: true });
		const query = new URL(req.url).searchParams;
		const requestId = query.get("requestId");
		const after = Number(query.get("after") ?? "-1");
		if (!isSideChatId(requestId) || !Number.isSafeInteger(after) || after < -1) throw new BoundaryError("invalid side-chat cursor");
		return NextResponse.json({ success: true, data: await pollSideChat(sessionPath, requestId, after, req.signal) }, { headers });
	} catch (error) {
		return failure(error);
	}
}

export async function DELETE(req: Request, { params }: RouteParams) {
	try {
		const { id } = await params;
		const sessionPath = await resolveSessionPath(id, { allowPending: true });
		const requestId = new URL(req.url).searchParams.get("requestId");
		if (!isSideChatId(requestId)) throw new BoundaryError("invalid side-chat id");
		const data = await stopSideChat(sessionPath, requestId);
		return NextResponse.json({ success: true, data }, { headers });
	} catch (error) {
		return failure(error);
	}
}
