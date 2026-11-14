import { NextResponse } from "next/server";
import { getManaged, growthConsent, growthRecord, updateRecordingForWorkspace } from "@/lib/agent-manager";
import { GrowthError, changesBetween, fileContent, filePatch, isAvailable, listTree, readRounds } from "@/lib/growth-service";
import { BoundaryError, resolveSessionPath, resolveWorkspacePath } from "@/lib/path-security";
import { getGrowthInitConsent, setGrowthInitConsent } from "@/lib/workspace-store";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

function status(err: unknown): number {
	if (err instanceof BoundaryError) return 400;
	if (err instanceof GrowthError) return err.code === "not-found" ? 404 : err.code === "unavailable" ? 503 : err.code === "too-large" ? 413 : err.code === "needs-consent" ? 409 : 500;
	return 500;
}

function growthFailure(error: unknown) {
	const fallback = error instanceof GrowthError && error.code === "unavailable"
		? "Git 暂时不可用，请确认已安装 Git 且工作区可写后重试。"
		: "工作区历史操作失败，请检查 Git 和文件权限后重试；现有历史已保留。";
	const result = apiError(error, fallback, error instanceof GrowthError && status(error) < 500);
	return error instanceof GrowthError ? { ...result, errorCode: `GROWTH_${error.code.replace(/-/g, "_").toUpperCase()}` } : result;
}

/**
 * 项目生长（每轮一个 git commit）只读接口：
 * ?cwd=&session=<jsonl 路径>        本会话的轮次（省略 session = 工作区全部 commit）
 * ?cwd=&tree=<hash>&list=1           某一轮的文件清单
 * ?cwd=&from=<tree>&to=<tree>&changes=1   两轮之间的变更清单
 * ?cwd=&from=&to=&path=[&renamedFrom=]    单文件整文件上下文的 unified diff
 * ?cwd=&tree=&path=&content=1        某一轮里单文件全文
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const q = (k: string) => url.searchParams.get(k);
	try {
		const cwd = await resolveWorkspacePath(q("cwd"));
		if (q("consent") === "1") return NextResponse.json({ success: true, data: { consent: await getGrowthInitConsent(cwd) } }, { headers: { "Cache-Control": "no-store" } });
		if (q("list") === "1") return NextResponse.json({ success: true, data: { files: await listTree(cwd, q("tree")) } });
		if (q("changes") === "1") return NextResponse.json({ success: true, data: { changes: await changesBetween(cwd, q("from"), q("to")) } });
		if (q("content") === "1") return NextResponse.json({ success: true, data: await fileContent(cwd, q("tree"), q("path")) });
		if (q("path") !== null) return NextResponse.json({ success: true, data: await filePatch(cwd, q("from"), q("to"), q("path"), q("renamedFrom") ?? undefined) });
		const available = await isAvailable();
		if (!available) return NextResponse.json({ success: true, data: { available: false, rounds: [] } });
		return NextResponse.json({ success: true, data: { available: true, rounds: await readRounds(cwd, q("session") ?? undefined) } });
	} catch (err: unknown) {
		return NextResponse.json({ success: false, ...growthFailure(err) }, { status: status(err) });
	}
}

/**
 * POST { action: "record", session: <会话 id> }：立即记录，把当前改动提交为「你的修改」（并广播给会话订阅者）
 * POST { action: "consent", session, allow: boolean }：回答「要不要在工作区建 git 仓库」；同意时立即拍基线
 */
export async function POST(req: Request) {
	try {
		const body = (await req.json()) as { action?: string; session?: unknown; allow?: unknown; cwd?: unknown };
		if (body.action === "setRecording") {
			if (typeof body.allow !== "boolean") return NextResponse.json({ success: false, error: "allow must be a boolean" }, { status: 400 });
			const cwd = await resolveWorkspacePath(body.cwd);
			await setGrowthInitConsent(cwd, body.allow);
			await updateRecordingForWorkspace(cwd, body.allow);
			return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
		}
		if (body.action !== "record" && body.action !== "consent") return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
		if (body.action === "consent" && typeof body.allow !== "boolean") return NextResponse.json({ success: false, error: "allow must be a boolean" }, { status: 400 });
		const sessionPath = await resolveSessionPath(String(body.session ?? ""), { allowPending: true });
		const m = getManaged(sessionPath);
		const round = body.action === "consent" ? await growthConsent(m, body.allow as boolean) : await growthRecord(m);
		return NextResponse.json({ success: true, data: { round } });
	} catch (err: unknown) {
		return NextResponse.json({ success: false, ...growthFailure(err) }, { status: err instanceof SyntaxError ? 400 : status(err) });
	}
}
