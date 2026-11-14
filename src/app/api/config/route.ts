import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@/lib/pi";

export const dynamic = "force-dynamic";

/** 下载 ~/.pi/agent/settings.json（对应 dsh 设置里的「打开配置文件」） */
export async function GET() {
	try {
		const file = path.join(getAgentDir(), "settings.json");
		const content = await fs.readFile(file, "utf8");
		return new Response(content, {
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Content-Disposition": 'attachment; filename="settings.json"',
				"Cache-Control": "no-store",
			},
		});
	} catch (err: any) {
		console.error("[config] Could not read configuration:", err);
		return NextResponse.json({ success: false, error: "configuration is unavailable" }, { status: 500, headers: { "Cache-Control": "no-store" } });
	}
}
