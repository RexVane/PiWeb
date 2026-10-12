import { NextResponse } from "next/server";
import { completeFiles } from "@/lib/file-completion-service";
import { BoundaryError } from "@/lib/path-security";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	try {
		const body = await req.json();
		return NextResponse.json({ success: true, data: await completeFiles(body.cwd, body.text, body.cursor, req.signal) });
	} catch (error) {
		return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, {
			status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500,
		});
	}
}
