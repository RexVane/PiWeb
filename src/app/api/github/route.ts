import { NextResponse } from "next/server";
import { repoRoot } from "@/lib/git-service";
import { awaitGithubIdentity } from "@/lib/github-identity";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

/**
 * Git 面板头部的 GitHub 身份（头像 + 账号）。
 *
 * 与 /api/git 分开：身份要走网络（gh / 头像），不该拖慢分支与文件状态那条纯本地读取。
 * 取不到就回 identity: null，前端只显示分支信息，不报错。
 */
export async function GET(req: Request) {
	const cwd = new URL(req.url).searchParams.get("cwd");
	try {
		const resolved = await resolveWorkspacePath(cwd);
		const { root } = await repoRoot(resolved);
		if (!root) return NextResponse.json({ success: true, data: { identity: null } });
		return NextResponse.json({ success: true, data: { identity: await awaitGithubIdentity(root) } });
	} catch (err: any) {
		if (err instanceof BoundaryError) return NextResponse.json({ success: false, error: err.message }, { status: 400 });
		// 身份只是装饰：任何失败都不该让面板变红
		return NextResponse.json({ success: true, data: { identity: null } });
	}
}
