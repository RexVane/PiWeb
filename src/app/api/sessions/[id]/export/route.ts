import { NextResponse } from "next/server";
import { exportSession, getManaged } from "@/lib/agent-manager";
import { BoundaryError, resolveSessionPath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const format = new URL(req.url).searchParams.get("format") === "html" ? "html" : "jsonl";
	try {
		const m = getManaged(await resolveSessionPath(id));
		const { filename, content, contentType } = await exportSession(m, format);
		return new Response(content, {
			headers: {
				"Content-Type": `${contentType}; charset=utf-8`,
				"Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
			},
		});
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError ? 400 : 500 },
		);
	}
}
