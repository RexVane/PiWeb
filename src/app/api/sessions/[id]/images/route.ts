import { NextResponse } from "next/server";
import { getManaged, readSessionImage } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const query = new URL(req.url).searchParams;
		const entry = query.get("entry"); const rawPart = query.get("part");
		if (!entry || entry.length > 256 || !rawPart || !/^(?:0|[1-9]\d*)$/.test(rawPart) || !Number.isSafeInteger(Number(rawPart))) throw new BoundaryError("invalid image reference");
		const sessionPath = await resolveSessionPath(id);
		const image = await readSessionImage(getManaged(sessionPath), entry, Number(rawPart));
		if (!/^image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)$/i.test(image.mimeType)) throw new BoundaryError("unsupported image type");
		return new Response(new Uint8Array(image.data), { headers: { ...headers, "Content-Type": image.mimeType, "Content-Length": String(image.data.byteLength) } });
	} catch (error) {
		return NextResponse.json({ success: false, error: "图片暂时无法读取，请重新打开聊天记录。" }, { status: error instanceof BoundaryError ? 400 : 500, headers });
	}
}
