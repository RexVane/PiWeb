import { NextResponse } from "next/server";
import { readSandboxConfig, writeSandboxConfig } from "@/lib/sandbox/config";
import { probeSandboxSupport } from "@/lib/sandbox/manager";
import { BoundaryError } from "@/lib/path-security";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** 沙箱能力 + 「工作区内修改」档的额外可写目录 */
export async function GET() {
	try {
		const [supported, config] = await Promise.all([probeSandboxSupport(), readSandboxConfig()]);
		return NextResponse.json({ success: true, data: { supported, ...config } }, { headers });
	} catch (err: any) {
		return NextResponse.json({ success: false, ...apiError(err, "权限配置读取失败，请重试。") }, { status: 500, headers });
	}
}

export async function PUT(req: Request) {
	try {
		const body = await req.json();
		const config = await writeSandboxConfig(body);
		// 新目录在下一次建沙箱时生效；已经建好的会话沙箱保持原授权（与 pi 的 shellPath 同一条规则）
		return NextResponse.json({ success: true, data: config }, { headers });
	} catch (err: any) {
		return NextResponse.json({ success: false, ...apiError(err, "权限配置保存失败，请重试。") },
			{ status: err instanceof SyntaxError || err instanceof BoundaryError ? 400 : 500, headers });
	}
}
