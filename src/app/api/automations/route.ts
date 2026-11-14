import { NextResponse } from "next/server";
import { BoundaryError } from "@/lib/path-security";
import { AutomationConflictError, ensureAutomationSchedulerStarted, getAutomationsSnapshot, runAutomationNow } from "@/lib/automations/runner";
import {
	AutomationNotFoundError,
	AutomationValidationError,
	createAutomationTask,
	deleteAutomationTask,
	updateAutomationTask,
	requestAutomationStop,
	repairAutomationStore,
} from "@/lib/automations/store";
import type { AutomationModelRef, AutomationSchedule } from "@/lib/automations/types";
import type { ToolPreset } from "@/lib/types";
import { apiError } from "@/lib/api-error";
import { publicDiagnostic } from "@/lib/public-diagnostic";

export const dynamic = "force-dynamic";

function mapErrorStatus(err: unknown): number {
	if (err instanceof AutomationValidationError || err instanceof BoundaryError || err instanceof SyntaxError) {
		return 400;
	}
	if (err instanceof AutomationNotFoundError) {
		return 404;
	}
	if (err instanceof AutomationConflictError) {
		return 409;
	}
	return 500;
}

export async function GET() {
	try {
		ensureAutomationSchedulerStarted();
		const data = await getAutomationsSnapshot();
		const safeData = { ...data, runs: data.runs.map((run) => run.error ? { ...run, error: publicDiagnostic(run.error, "自动化执行失败，请打开相关会话查看详情后重试。") } : run),
			...(data.storeError ? { storeError: { ...data.storeError, message: apiError(new Error(data.storeError.message), "自动化数据无法读取，已有数据已保留。请查看恢复选项或检查文件权限。").error } } : {}) };
		return NextResponse.json({ success: true, data: safeData }, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		const status = mapErrorStatus(err);
		return NextResponse.json({ success: false, ...apiError(err, "读取自动化失败，请检查文件权限后重试；已有任务数据已保留。", status < 500) }, { status });
	}
}

export async function POST(req: Request) {
	try {
		ensureAutomationSchedulerStarted();
		const raw: unknown = await req.json();
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AutomationValidationError("Expected an automation request object");
		const body = raw as {
			action?: string;
			id?: string;
			name?: string;
			prompt?: string;
			cwd?: string;
			schedule?: AutomationSchedule;
			enabled?: boolean;
			toolPreset?: ToolPreset;
			model?: AutomationModelRef | null;
			mode?: "salvage" | "restore" | "reset";
			expectedHash?: string;
		};

		switch (body.action) {
			case "repairStore": {
				if (!body.mode || !["salvage", "restore", "reset"].includes(body.mode) || typeof body.expectedHash !== "string") throw new AutomationValidationError("invalid recovery request");
				return NextResponse.json({ success: true, data: await repairAutomationStore(body.mode, body.expectedHash) });
			}
			case "stop": {
				if (typeof body.id !== "string") throw new AutomationValidationError("missing task id");
				return NextResponse.json({ success: true, data: await requestAutomationStop(body.id) });
			}
			case "create": {
				const task = await createAutomationTask({
					name: body.name ?? "",
					prompt: body.prompt ?? "",
					cwd: body.cwd ?? "",
					schedule: body.schedule as AutomationSchedule,
					enabled: body.enabled,
					toolPreset: body.toolPreset,
					model: body.model ?? undefined,
				});
				return NextResponse.json({ success: true, data: { task } });
			}
			case "update": {
				const id = typeof body.id === "string" ? body.id.trim() : "";
				if (!id) throw new AutomationValidationError("Missing automation task id");
				const patch: Parameters<typeof updateAutomationTask>[1] = {};
				if (body.name !== undefined) patch.name = body.name;
				if (body.prompt !== undefined) patch.prompt = body.prompt;
				if (body.cwd !== undefined) patch.cwd = body.cwd;
				if (body.schedule !== undefined) patch.schedule = body.schedule;
				if (body.enabled !== undefined) patch.enabled = body.enabled;
				if (body.toolPreset !== undefined) patch.toolPreset = body.toolPreset;
				if (Object.prototype.hasOwnProperty.call(body, "model")) patch.model = body.model;
				const task = await updateAutomationTask(id, patch);
				return NextResponse.json({ success: true, data: { task } });
			}
			case "toggle": {
				const id = typeof body.id === "string" ? body.id.trim() : "";
				if (!id) throw new AutomationValidationError("Missing automation task id");
				if (typeof body.enabled !== "boolean") throw new AutomationValidationError("Missing enabled flag");
				const task = await updateAutomationTask(id, { enabled: body.enabled });
				return NextResponse.json({ success: true, data: { task } });
			}
			case "delete": {
				const id = typeof body.id === "string" ? body.id.trim() : "";
				if (!id) throw new AutomationValidationError("Missing automation task id");
				const res = await deleteAutomationTask(id);
				return NextResponse.json({ success: true, data: res });
			}
			case "runNow": {
				const id = typeof body.id === "string" ? body.id.trim() : "";
				if (!id) throw new AutomationValidationError("Missing automation task id");
				const { run } = await runAutomationNow(id);
				return NextResponse.json({ success: true, data: { run } });
			}
			default:
				return NextResponse.json({ success: false, error: "未知的自动化操作。" }, { status: 400 });
		}
	} catch (err) {
		const status = mapErrorStatus(err);
		return NextResponse.json({ success: false, ...apiError(err, "自动化操作失败，请检查文件权限后重试；已有任务数据已保留。", status < 500) }, { status });
	}
}
