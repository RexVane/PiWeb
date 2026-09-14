import { NextResponse } from "next/server";
import { getManaged, growthSnapshot } from "@/lib/agent-manager";
import { GrowthError, changesBetween, fileContent, filePatch, isAvailable, listTree, readSteps } from "@/lib/growth-service";
import { BoundaryError, resolveSessionPath, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

function status(err: unknown): number {
	if (err instanceof BoundaryError) return 400;
	if (err instanceof GrowthError) return err.code === "not-found" ? 404 : err.code === "unavailable" ? 503 : err.code === "too-large" ? 413 : 500;
	return 500;
}

/**
 * 项目生长（影子仓库快照）只读接口：
 * ?cwd=&session=<jsonl 路径>        本会话的步（省略 session = 工作区全部步）
 * ?cwd=&tree=<hash>&list=1           某一步的文件清单
 * ?cwd=&from=<tree>&to=<tree>&changes=1   两步之间的变更清单
 * ?cwd=&from=&to=&path=[&renamedFrom=]    单文件整文件上下文的 unified diff
 * ?cwd=&tree=&path=&content=1        某一步里单文件全文
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const q = (k: string) => url.searchParams.get(k);
	try {
		const cwd = await resolveWorkspacePath(q("cwd"));
		if (q("list") === "1") return NextResponse.json({ success: true, data: { files: await listTree(cwd, q("tree")) } });
		if (q("changes") === "1") return NextResponse.json({ success: true, data: { changes: await changesBetween(cwd, q("from"), q("to")) } });
		if (q("content") === "1") return NextResponse.json({ success: true, data: await fileContent(cwd, q("tree"), q("path")) });
		if (q("path") !== null) return NextResponse.json({ success: true, data: await filePatch(cwd, q("from"), q("to"), q("path"), q("renamedFrom") ?? undefined) });
		const available = await isAvailable();
		if (!available) return NextResponse.json({ success: true, data: { available: false, steps: [] } });
		return NextResponse.json({ success: true, data: { available: true, steps: await readSteps(cwd, q("session") ?? undefined) } });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: status(err) });
	}
}

/** POST { action: "snapshot", session: <会话 id>, label? }：手动拍一张快照（记步并广播给会话订阅者） */
export async function POST(req: Request) {
	try {
		const body = (await req.json()) as { action?: string; session?: unknown; label?: unknown };
		if (body.action !== "snapshot") return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
		const sessionPath = await resolveSessionPath(String(body.session ?? ""), { allowPending: true });
		const step = await growthSnapshot(getManaged(sessionPath), typeof body.label === "string" ? body.label : "");
		return NextResponse.json({ success: true, data: { step } });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: err instanceof SyntaxError ? 400 : status(err) });
	}
}
