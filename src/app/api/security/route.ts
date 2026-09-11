import { NextResponse } from "next/server";
import type { ProjectTrust } from "@/lib/security-service";
import { getSecurity, setProjectTrust } from "@/lib/security-service";
import { reloadLoader, setProjectTrust as setProjectTrustDecision } from "@/lib/pi";
import { reloadSessionsForCwd } from "@/lib/agent-manager";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		return NextResponse.json({ success: true, data: await getSecurity() });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}

export async function PUT(req: Request) {
	try {
		const body = (await req.json()) as { defaultProjectTrust?: ProjectTrust; projectTrust?: { cwd?: unknown; decision?: unknown } };
		// 按目录记住信任决定（写 ~/.pi/agent/trust.json，与 pi 终端共用）
		if (body.projectTrust) {
			const cwd = await resolveWorkspacePath(body.projectTrust.cwd);
			const decision = body.projectTrust.decision;
			if (decision !== true && decision !== false && decision !== null)
				return NextResponse.json({ success: false, error: "decision must be true / false / null" }, { status: 400 });
			const state = setProjectTrustDecision(cwd, decision);
			// 让该目录的加载器按新信任态重新发现资源，活跃会话重建扩展运行时，页面拿到新清单
			await reloadLoader(cwd);
			await reloadSessionsForCwd(cwd);
			return NextResponse.json({ success: true, data: state });
		}
		const v = body.defaultProjectTrust;
		if (v !== "ask" && v !== "always" && v !== "never")
			return NextResponse.json({ success: false, error: "bad value" }, { status: 400 });
		await setProjectTrust(v);
		return NextResponse.json({ success: true });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: err instanceof BoundaryError ? 400 : 500 });
	}
}
