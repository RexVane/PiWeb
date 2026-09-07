import { NextResponse } from "next/server";
import { listSkills, readSkillFile, setSkillDisabled } from "@/lib/skills-service";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	try {
		const rawCwd = new URL(req.url).searchParams.get("cwd");
		const cwd = await resolveWorkspacePath(rawCwd || process.cwd());
		const skills = await listSkills(cwd);
		return NextResponse.json({ success: true, data: { skills } });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as { action: "toggle" | "read"; filePath?: string; disabled?: boolean; cwd?: string };
		const cwd = await resolveWorkspacePath(body.cwd || process.cwd());
		if (body.action === "toggle") {
			if (!body.filePath || typeof body.disabled !== "boolean")
				return NextResponse.json({ success: false, error: "missing fields" }, { status: 400 });
			const r = await setSkillDisabled(body.filePath, body.disabled, cwd);
			return NextResponse.json({ success: true, data: r });
		}
		if (body.action === "read") {
			if (!body.filePath) return NextResponse.json({ success: false, error: "missing filePath" }, { status: 400 });
			return NextResponse.json({ success: true, data: { content: await readSkillFile(body.filePath, cwd) } });
		}
		return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
	} catch (error) {
		return NextResponse.json(
			{ success: false, error: error instanceof Error ? error.message : "request failed" },
			{ status: error instanceof BoundaryError ? 400 : 500 },
		);
	}
}
