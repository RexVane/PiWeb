import { NextResponse } from "next/server";
import { exportSession, getManaged } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

/**
 * 下载文件名：filename= 里放 ASCII 兜底，filename*= 按 RFC 6266/5987 放 UTF-8 原名。
 * 只写百分号编码的 filename= 时浏览器不解码，中文会话名下载下来就是一串 %E4%BD%A0…
 */
function attachmentDisposition(filename: string): string {
	const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "session";
	const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const format = new URL(req.url).searchParams.get("format") === "html" ? "html" : "jsonl";
	try {
		// 与 /api/agent/[id] 同一种解析（allowPending 返回原写法而不是 realpath）：会话表按路径字符串做键，
		// ~/.pi 经过 junction / 符号链接时两种写法不同，导出 HTML 就会给同一个文件再起一个 agent
		const m = getManaged(await resolveSessionPath(id, { allowPending: true }));
		const { filename, content, contentType } = await exportSession(m, format);
		return new Response(content, {
			headers: {
				"Content-Type": `${contentType}; charset=utf-8`,
				"Content-Disposition": attachmentDisposition(filename),
			},
		});
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError ? 400 : 500 },
		);
	}
}
