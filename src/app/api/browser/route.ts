import { NextResponse } from "next/server";
import { getManaged } from "@/lib/agent/agent-manager";
import { BrowserUnavailableError } from "@/lib/browser/manager";
import { captureForPicking, NoBrowserPageError, NoElementError, pickElementAt } from "@/lib/browser/pick";
import { BoundaryError, resolveSessionPath } from "@/lib/security/path-security";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;

async function readJson(req: Request): Promise<Record<string, unknown>> {
	const reader = req.body?.getReader();
	if (!reader) throw new BoundaryError("missing request body");
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_BODY_BYTES) throw new BoundaryError("request body too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoundaryError("expected an object body");
	return body as Record<string, unknown>;
}

function status(error: unknown): number {
	if (error instanceof BoundaryError || error instanceof SyntaxError) return 400;
	if (error instanceof NoElementError) return 404;
	if (error instanceof NoBrowserPageError) return 409;
	if (error instanceof BrowserUnavailableError) return 503;
	return 500;
}

/**
 * 截图上点选元素（只操作 pi 这个会话已打开的浏览器标签页）：
 * POST { action: "capture", session }        重新截一张当前页面
 * POST { action: "pick", session, x, y }     取视口坐标处的元素并定位源码（x / y 为 CSS 像素）
 */
export async function POST(req: Request) {
	try {
		const body = await readJson(req);
		const sessionPath = await resolveSessionPath(String(body.session ?? ""));
		if (body.action === "capture") {
			return NextResponse.json({ success: true, data: await captureForPicking(sessionPath) });
		}
		if (body.action === "pick") {
			if (typeof body.x !== "number" || typeof body.y !== "number") throw new BoundaryError("x and y must be numbers");
			const { cwd } = getManaged(sessionPath);
			return NextResponse.json({ success: true, data: await pickElementAt(sessionPath, cwd, body.x, body.y) });
		}
		return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
	} catch (error) {
		return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: status(error) });
	}
}
