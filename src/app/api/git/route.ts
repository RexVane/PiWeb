import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { isSafeOrigin } from "@/lib/auth";
import { BoundaryError } from "@/lib/path-security";
import { gitDiff, gitInfo, gitShow } from "@/lib/git-service";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

function errorStatus(err: unknown): number {
	if (err instanceof BoundaryError || err instanceof SyntaxError) return 400;
	if (err && typeof err === "object" && (err as { name?: string }).name === "GitActionError") {
		const status = (err as { status?: number }).status;
		return typeof status === "number" && status >= 400 && status < 600 ? status : 400;
	}
	return 500;
}

function errorPayload(err: unknown) {
	if (err && typeof err === "object" && (err as { name?: string }).name === "GitActionError") {
		return apiError(err, "Git 操作失败", true);
	}
	return apiError(err);
}

/**
 * 工作区 Git 只读接口：
 * ?cwd=                                     状态（分支、上游、ahead/behind、变更文件、最近提交）
 * ?cwd=&diff=<path>&mode=[&full=1][&hash=][&from=]  单文件差异（mode: staged | worktree | untracked | commit）
 * ?cwd=&show=<hash>                         单次提交完整补丁（旧兼容）
 * ?cwd=&commitFiles=<hash>                  单次提交改动文件列表
 * ?cwd=&cat=<path>&rev=<hash|INDEX|HEAD>    指定 Git 对象版本中的文件内容
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
		const commitFiles = url.searchParams.get("commitFiles");
		if (commitFiles !== null) {
			const { gitCommitFiles } = await import("@/lib/git-service");
			return NextResponse.json({ success: true, data: await gitCommitFiles(cwd, commitFiles) }, { headers });
		}
		const catPath = url.searchParams.get("cat");
		if (catPath !== null) {
			const { gitFileContent } = await import("@/lib/git-service");
			return NextResponse.json({ success: true, data: await gitFileContent(cwd, catPath, url.searchParams.get("rev")) }, { headers });
		}
		const diff = url.searchParams.get("diff");
		if (diff !== null) {
			const fullContext = url.searchParams.get("full") === "1";
			const hash = url.searchParams.get("hash") ?? undefined;
			const from = url.searchParams.get("from") ?? undefined;
			const opts = (fullContext || hash || from) ? { fullContext, hash, from } : undefined;
			return NextResponse.json({ success: true, data: await gitDiff(cwd, diff, url.searchParams.get("mode") ?? "worktree", opts) }, { headers });
		}
		const show = url.searchParams.get("show");
		if (show !== null) {
			return NextResponse.json({ success: true, data: await gitShow(cwd, show) }, { headers });
		}
		const summary = url.searchParams.get("summary");
		if (summary === "1" || summary === "lines") {
			const { getGrowthInitConsent, isHomeWorkspace } = await import("@/lib/workspace-store");
			if (cwd && await isHomeWorkspace(cwd) && !await getGrowthInitConsent(cwd)) {
				return NextResponse.json({ success: true, data: null }, { headers });
			}
			return NextResponse.json({ success: true, data: await gitInfo(cwd, summary === "lines" ? "lines" : true) }, { headers });
		}
		return NextResponse.json({ success: true, data: await gitInfo(cwd) }, { headers });
	} catch (err: unknown) {
		return NextResponse.json(
			{ success: false, ...errorPayload(err) },
			{ status: errorStatus(err), headers },
		);
	}
}

/**
 * 工作区 Git 写接口（均需通过 isSafeOrigin 同源校验与仓库路径边界检查）：
 * - stage / unstage: { action, cwd, all?: boolean, paths?: string[], path?: string }
 * - stageHunk / unstageHunk: { action, cwd, path, mode?, blockIndex, anchor? }
 * - commit: { action: "commit", cwd, message, push?: boolean }
 * - push / pull: { action: "push" | "pull", cwd }
 */
export async function POST(req: Request) {
	if (!isSafeOrigin(req)) {
		return NextResponse.json({ success: false, error: "cross-origin request rejected" }, { status: 403, headers });
	}
	try {
		const body = (await req.json()) as {
			action?: unknown;
			cwd?: unknown;
			all?: unknown;
			paths?: unknown;
			path?: unknown;
			mode?: unknown;
			blockIndex?: unknown;
			anchor?: unknown;
			message?: unknown;
			push?: unknown;
		};
		const { gitCommit, gitHunkAction, gitPull, gitPush, gitStage, gitUnstage } = await import("@/lib/git-service");
		if (body.action === "stage" || body.action === "unstage") {
			const target: "all" | string[] = body.all === true
				? "all"
				: Array.isArray(body.paths)
					? body.paths.filter((p): p is string => typeof p === "string")
					: typeof body.path === "string"
						? [body.path]
						: [];
			if (body.action === "stage") await gitStage(body.cwd, target);
			else await gitUnstage(body.cwd, target);
			return NextResponse.json({ success: true, data: { info: await gitInfo(body.cwd) } }, { headers });
		}
		if (body.action === "stageHunk" || body.action === "unstageHunk") {
			const blockIndex = typeof body.blockIndex === "number" ? body.blockIndex : -1;
			const anchor = body.anchor && typeof body.anchor === "object" ? body.anchor as Record<string, unknown> : undefined;
			const parsedAnchor = anchor ? {
				...(typeof anchor.oldAnchor === "number" ? { oldAnchor: anchor.oldAnchor } : {}),
				...(typeof anchor.newAnchor === "number" ? { newAnchor: anchor.newAnchor } : {}),
				...(typeof anchor.delCount === "number" ? { delCount: anchor.delCount } : {}),
				...(typeof anchor.addCount === "number" ? { addCount: anchor.addCount } : {}),
			} : undefined;
			await gitHunkAction(body.cwd, body.path, body.action, body.mode, blockIndex, parsedAnchor);
			return NextResponse.json({ success: true, data: { info: await gitInfo(body.cwd) } }, { headers });
		}
		if (body.action === "commit") {
			const res = await gitCommit(body.cwd, body.message, { push: body.push === true });
			return NextResponse.json({ success: true, data: { ...res, info: await gitInfo(body.cwd) } }, { headers });
		}
		if (body.action === "push") {
			const res = await gitPush(body.cwd);
			return NextResponse.json({ success: true, data: { ...res, info: await gitInfo(body.cwd) } }, { headers });
		}
		if (body.action === "pull") {
			const res = await gitPull(body.cwd);
			return NextResponse.json({ success: true, data: { ...res, info: await gitInfo(body.cwd) } }, { headers });
		}
		return NextResponse.json({ success: false, error: "unknown action" }, { status: 400, headers });
	} catch (err: unknown) {
		return NextResponse.json(
			{ success: false, ...errorPayload(err) },
			{ status: errorStatus(err), headers },
		);
	}
}
