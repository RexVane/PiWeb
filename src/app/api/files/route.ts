import { NextResponse } from "next/server";
import { BoundaryError } from "@/lib/path-security";
import { listWorkspaceDir, openInEditor, parseUploadLength, readWorkspaceFile, saveUploadStream } from "@/lib/files-service";

export const dynamic = "force-dynamic";

/** 工作区文件浏览：?cwd=&path=（目录列表）；?read=1&cwd=&path=（文本预览） */
export async function GET(req: Request) {
	const url = new URL(req.url);
	try {
		if (url.searchParams.get("read") === "1") {
			return NextResponse.json({ success: true, data: await readWorkspaceFile(url.searchParams.get("cwd"), url.searchParams.get("path")) });
		}
		return NextResponse.json({ success: true, data: await listWorkspaceDir(url.searchParams.get("cwd"), url.searchParams.get("path"), url.searchParams.get("offset")) });
	} catch (err: any) {
		return NextResponse.json(
			{ success: false, error: String(err?.message ?? err) },
			{ status: err instanceof BoundaryError ? 400 : 500 },
		);
	}
}

/** POST ?action=upload&name= streams bytes; POST { action: "open", cwd, path, line? } opens an editor. */
export async function POST(req: Request) {
	try {
		const url = new URL(req.url);
		if (url.searchParams.get("action") === "upload") {
			const declared = req.headers.get("x-upload-size");
			const contentLength = req.headers.get("content-length");
			const expectedSize = parseUploadLength(declared ?? contentLength);
			if (declared !== null && contentLength !== null && parseUploadLength(contentLength) !== expectedSize) {
				throw new BoundaryError("conflicting upload sizes");
			}
			return NextResponse.json({ success: true, data: await saveUploadStream(url.searchParams.get("name"), req.body, expectedSize) });
		}
		const reader = req.body?.getReader();
		if (!reader) throw new BoundaryError("missing request body");
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > 64 * 1024) throw new BoundaryError("request body too large");
				chunks.push(value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { action?: string; cwd?: unknown; path?: unknown; line?: unknown; name?: unknown };
		if (body.action === "open") {
			return NextResponse.json({ success: true, data: await openInEditor(body.cwd, body.path, body.line) });
		}
		return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
	} catch (err: any) {
		return NextResponse.json(
			{ success: false, error: String(err?.message ?? err) },
			{ status: err instanceof BoundaryError || err instanceof SyntaxError ? 400 : 500 },
		);
	}
}
