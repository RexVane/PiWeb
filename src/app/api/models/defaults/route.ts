import { NextResponse } from "next/server";
import { newSessionDefaults } from "@/lib/model-defaults";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

/** 新会话页的默认模型与思考档位：按工作区读 pi 的设置 */
export async function GET(req: Request) {
	try {
		const cwd = await resolveWorkspacePath(new URL(req.url).searchParams.get("cwd"));
		return NextResponse.json({ success: true, data: await newSessionDefaults(cwd) });
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError ? 400 : 500 },
		);
	}
}
