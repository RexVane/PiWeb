import { NextResponse } from "next/server";
import { deleteSkill, previewDeleteSkill, listSkills, readSkillFile, setSkillDisabled } from "@/lib/skills-service";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";
import { APP_ROOT } from "@/lib/app-root";
import { apiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	try {
		const rawCwd = new URL(req.url).searchParams.get("cwd");
		const cwd = await resolveWorkspacePath(rawCwd || APP_ROOT);
		const skills = await listSkills(cwd);
		return NextResponse.json({ success: true, data: { skills } });
	} catch (err: unknown) {
		return NextResponse.json({ success: false, ...apiError(err, "读取技能失败，请检查文件权限或稍后重试。") }, { status: err instanceof BoundaryError ? 400 : 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as { action: "toggle" | "read" | "delete" | "previewDelete"; filePath?: string; disabled?: boolean; cwd?: string; expectedPath?: string };
		const cwd = await resolveWorkspacePath(body.cwd || APP_ROOT);
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
		if (body.action === "delete") {
			if (!body.filePath) return NextResponse.json({ success: false, error: "missing filePath" }, { status: 400 });
			const r = await deleteSkill(body.filePath, cwd, body.expectedPath);
			return NextResponse.json({ success: true, data: r });
		}
		if (body.action === "previewDelete") {
			if (!body.filePath) return NextResponse.json({ success: false, error: "missing filePath" }, { status: 400 });
			return NextResponse.json({ success: true, data: await previewDeleteSkill(body.filePath, cwd) });
		}
		return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "技能操作失败，请检查文件权限或稍后重试。") },
			{ status: error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500 },
		);
	}
}
