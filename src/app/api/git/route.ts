import { NextResponse } from "next/server";
import { BoundaryError } from "@/lib/path-security";
import { gitDiff, gitInfo, gitShow } from "@/lib/git-service";

export const dynamic = "force-dynamic";

/**
 * 工作区 Git 只读接口：
 * ?cwd=                       状态（分支、上游、ahead/behind、变更文件、最近提交）
 * ?cwd=&diff=<path>&mode=     单文件差异（mode: staged | worktree | untracked）
 * ?cwd=&show=<hash>           单次提交内容
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const cwd = url.searchParams.get("cwd");
	try {
		const diff = url.searchParams.get("diff");
		if (diff !== null) {
			return NextResponse.json({ success: true, data: await gitDiff(cwd, diff, url.searchParams.get("mode") ?? "worktree") });
		}
		const show = url.searchParams.get("show");
		if (show !== null) {
			return NextResponse.json({ success: true, data: await gitShow(cwd, show) });
		}
		return NextResponse.json({ success: true, data: await gitInfo(cwd) });
	} catch (err: any) {
		return NextResponse.json(
			{ success: false, error: String(err?.message ?? err) },
			{ status: err instanceof BoundaryError ? 400 : 500 },
		);
	}
}
