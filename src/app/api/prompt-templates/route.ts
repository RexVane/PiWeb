import { NextResponse } from "next/server";
import { BoundaryError, resolveWorkspacePath } from "@/lib/path-security";
import { APP_ROOT } from "@/lib/app-root";
import { apiError } from "@/lib/api-error";
import { SettingsWriteBusyError } from "@/lib/settings-write-lock";
import { deletePromptTemplate, listPromptTemplates, previewDeletePromptTemplate, readPromptTemplate, setPromptTemplateDisabled } from "@/lib/prompt-templates-service";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

function failure(error: unknown) {
	const busy = error instanceof SettingsWriteBusyError;
	return NextResponse.json({ success: false, ...apiError(error, "提示词模板操作失败，请检查文件权限或稍后重试。") }, {
		status: busy ? 409 : error instanceof BoundaryError || error instanceof SyntaxError ? 400 : 500,
		headers: { ...headers, ...(busy ? { "Retry-After": String(error.retryAfterSeconds) } : {}) },
	});
}

export async function GET(req: Request) {
	try {
		const cwd = await resolveWorkspacePath(new URL(req.url).searchParams.get("cwd") || APP_ROOT);
		return NextResponse.json({ success: true, data: { templates: await listPromptTemplates(cwd) } }, { headers });
	} catch (error) { return failure(error); }
}

export async function POST(req: Request) {
	try {
		const body: unknown = await req.json();
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoundaryError("Expected an object body.");
		const { action, filePath, disabled, cwd: rawCwd, expectedPath } = body as Record<string, unknown>;
		if (rawCwd !== undefined && typeof rawCwd !== "string") throw new BoundaryError("Invalid workspace path.");
		const cwd = await resolveWorkspacePath(rawCwd || APP_ROOT);
		if (typeof filePath !== "string" || !filePath || filePath.length > 4096) throw new BoundaryError("Missing or invalid template path.");
		let data: unknown;
		switch (action) {
			case "read": data = { content: await readPromptTemplate(filePath, cwd) }; break;
			case "toggle":
				if (typeof disabled !== "boolean") throw new BoundaryError("Missing disabled state.");
				data = await setPromptTemplateDisabled(filePath, disabled, cwd);
				break;
			case "previewDelete": data = await previewDeletePromptTemplate(filePath, cwd); break;
			case "delete":
				if (typeof expectedPath !== "string" || !expectedPath || expectedPath.length > 4096) throw new BoundaryError("Review the removal path before deleting.");
				data = await deletePromptTemplate(filePath, cwd, expectedPath);
				break;
			default: throw new BoundaryError("Unknown template action.");
		}
		return NextResponse.json({ success: true, data }, { headers });
	} catch (error) { return failure(error); }
}
