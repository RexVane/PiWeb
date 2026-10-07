import { NextResponse } from "next/server";
import { locateSource } from "@/lib/dev-inspect-service";
import { BoundaryError } from "@/lib/path-security";

export const dynamic = "force-dynamic";

/**
 * 开发者模式：元素 → 源码定位。
 * POST { cwd, text?, attrs? } → { results: SourceHit[], searchedFiles, truncated? }
 * text 为预览页面点击元素的可见文本；attrs 为构建期注入的 data-source 类属性。
 */
export async function POST(req: Request) {
	try {
		const reader = req.body?.getReader();
		if (!reader) throw new BoundaryError("missing request body");
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.length;
				if (length > 32 * 1024) throw new BoundaryError("request body too large");
				chunks.push(value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { cwd?: unknown; text?: unknown; attrs?: unknown };
		const data = await locateSource(body.cwd, { text: body.text, attrs: body.attrs });
		return NextResponse.json({ success: true, data });
	} catch (err: any) {
		return NextResponse.json(
			{ success: false, error: String(err?.message ?? err) },
			{ status: err instanceof BoundaryError || err instanceof SyntaxError ? 400 : 500 },
		);
	}
}
