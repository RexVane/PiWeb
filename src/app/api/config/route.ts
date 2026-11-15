import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@/lib/pi";
import { redactSecrets } from "@/lib/secret-redaction";

export const dynamic = "force-dynamic";

/**
 * 下载 ~/.pi/agent/settings.json（对应 dsh 设置里的「打开配置文件」）。
 *
 * 默认脱敏：settings.json 里可能带 httpProxy 的 userinfo 口令、provider key、
 * 遥测 trackingId 等；直接回原文等于把这些凭据交给浏览器下载目录。
 * 需要完整原文（例如手工编辑后逐字节比对）时显式加 `?raw=1`。
 */
export async function GET(req: Request) {
	const raw = new URL(req.url).searchParams.get("raw");
	const exposeRaw = raw === "1" || raw === "true";
	try {
		const file = path.join(getAgentDir(), "settings.json");
		const content = await fs.readFile(file, "utf8");
		return new Response(exposeRaw ? content : redactSecrets(content), {
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Content-Disposition": 'attachment; filename="settings.json"',
				"Cache-Control": "no-store",
				...(exposeRaw ? {} : { "X-PiWeb-Redacted": "1" }),
			},
		});
	} catch (err: any) {
		console.error("[config] Could not read configuration:", err);
		return NextResponse.json({ success: false, error: "configuration is unavailable" }, { status: 500, headers: { "Cache-Control": "no-store" } });
	}
}
