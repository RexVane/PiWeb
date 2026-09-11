import { NextResponse } from "next/server";
import { BoundaryError } from "@/lib/path-security";
import { listWorkspaceDir, openInEditor, readWorkspaceFile } from "@/lib/files-service";

export const dynamic = "force-dynamic";

/** 工作区文件浏览：?cwd=&path=（目录列表）；?read=1&cwd=&path=（文本预览） */
export async function GET(req: Request) {
	const url = new URL(req.url);
	try {
		if (url.searchParams.get("read") === "1") {
			return NextResponse.json({ success: true, data: await readWorkspaceFile(url.searchParams.get("cwd"), url.searchParams.get("path")) });
		}
		return NextResponse.json({ success: true, data: await listWorkspaceDir(url.searchParams.get("cwd"), url.searchParams.get("path")) });
	} catch (err: any) {
		return NextResponse.json(
			{ success: false, error: String(err?.message ?? err) },
			{ status: err instanceof BoundaryError ? 400 : 500 },
		);
	}
}

/** POST { action: "open", cwd, path, line? }：在本机编辑器打开文件 */
export async function POST(req: Request) {
	try {
		const body = (await req.json()) as { action?: string; cwd?: unknown; path?: unknown; line?: unknown };
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
