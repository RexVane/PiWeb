import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { isSafeOrigin } from "@/lib/auth";
import { BoundaryError } from "@/lib/path-security";
import { gitDiff, gitInfo, gitShow } from "@/lib/git-service";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/**
 * 工作区 Git 只读接口：
 * ?cwd=                       状态（分支、上游、ahead/behind、变更文件、最近提交）
 * ?cwd=&diff=<path>&mode=     单文件差异（mode: staged | worktree | untracked）
 * ?cwd=&show=<hash>           单次提交内容
 */
export async function GET(req: Request) {
	// Git 状态会起子进程探测仓库（有副作用且泄露本地路径）：GET 也要过跨站校验。
	// 浏览器跨站请求必带 Origin/Sec-Fetch-Site；curl/服务端调用没有 Origin，照旧放行。
	if (!isSafeOrigin(req)) {
		return NextResponse.json({ success: false, error: "cross-origin request rejected" }, { status: 403, headers });
	}
	const url = new URL(req.url);
	const cwd = url.searchParams.get("cwd");
	try {
		const diff = url.searchParams.get("diff");
		if (diff !== null) {
			return NextResponse.json({ success: true, data: await gitDiff(cwd, diff, url.searchParams.get("mode") ?? "worktree") }, { headers });
		}
		const show = url.searchParams.get("show");
		if (show !== null) {
			return NextResponse.json({ success: true, data: await gitShow(cwd, show) }, { headers });
		}
		return NextResponse.json({ success: true, data: await gitInfo(cwd) }, { headers });
	} catch (err: any) {
		return NextResponse.json(
			{ success: false, ...apiError(err) },
			{ status: err instanceof BoundaryError ? 400 : 500, headers },
		);
	}
}
