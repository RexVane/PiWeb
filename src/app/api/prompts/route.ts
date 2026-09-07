import { NextResponse } from "next/server";
import { listPrompts, readPrompt } from "@/lib/prompts-service";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	try {
		const cwd = await resolveWorkspacePath(new URL(req.url).searchParams.get("cwd") || process.cwd());
		return NextResponse.json({ success: true, data: { prompts: await listPrompts(cwd) } });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as { filePath?: string; cwd?: string };
		if (!body.filePath) return NextResponse.json({ success: false, error: "missing filePath" }, { status: 400 });
		const cwd = await resolveWorkspacePath(body.cwd || process.cwd());
		return NextResponse.json({ success: true, data: { content: await readPrompt(body.filePath, cwd) } });
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError ? 400 : 500 },
		);
	}
}
