import { NextResponse } from "next/server";
import type { ProjectTrust } from "@/lib/security-service";
import { getSecurity, setProjectTrust } from "@/lib/security-service";
import { reloadLoader, setProjectTrust as setProjectTrustDecision } from "@/lib/pi";
import { reloadSessionsForCwd } from "@/lib/agent-manager";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
	try {
		return NextResponse.json({ success: true, data: await getSecurity() }, { headers });
	} catch (err: any) {
		return NextResponse.json({ success: false, ...apiError(err, "信任设置读取失败，请重试。") }, { status: 500, headers });
	}
}

export async function PUT(req: Request) {
	try {
		const body = (await req.json()) as { defaultProjectTrust?: ProjectTrust; projectTrust?: { cwd?: unknown; decision?: unknown } };
		if (!body || typeof body !== "object" || Array.isArray(body)
			|| (body.projectTrust !== undefined && (!body.projectTrust || typeof body.projectTrust !== "object" || Array.isArray(body.projectTrust)))) {
			throw new BoundaryError("invalid trust settings");
		}
		// 按目录记住信任决定（写 ~/.pi/agent/trust.json，与 pi 终端共用）
		if (body.projectTrust) {
			const cwd = await resolveWorkspacePath(body.projectTrust.cwd);
			const decision = body.projectTrust.decision;
			if (decision !== true && decision !== false && decision !== null)
				return NextResponse.json({ success: false, error: "decision must be true / false / null", errorCode: "VALIDATION_ERROR" }, { status: 400, headers });
			const state = setProjectTrustDecision(cwd, decision);
			// 让该目录的加载器按新信任态重新发现资源，活跃会话重建扩展运行时，页面拿到新清单
			await reloadLoader(cwd);
			await reloadSessionsForCwd(cwd);
			return NextResponse.json({ success: true, data: state }, { headers });
		}
		const v = body.defaultProjectTrust;
		if (v !== "ask" && v !== "always" && v !== "never")
			return NextResponse.json({ success: false, error: "bad value", errorCode: "VALIDATION_ERROR" }, { status: 400, headers });
		await setProjectTrust(v);
		return NextResponse.json({ success: true }, { headers });
	} catch (err: any) {
		return NextResponse.json({ success: false, ...apiError(err, "信任设置保存失败，请重试。") },
			{ status: err instanceof BoundaryError || err instanceof SyntaxError ? 400 : 500, headers });
	}
}
