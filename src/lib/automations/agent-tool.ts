/**
 * manage_automation: PiWeb built-in tool for listing, creating, updating, and deleting
 * scheduled automation tasks directly from chat sessions.
 */
import { Type } from "typebox";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	createAutomationTask,
	defaultAutomationsStorePath,
	deleteAutomationTask,
	listAutomations,
	updateAutomationTask,
} from "./store";
import type { AutomationSchedule, AutomationTask } from "./types";
import { validateSchedule } from "./schedule";

export const MANAGE_AUTOMATION_TOOL = "manage_automation";

const ScheduleSchema = Type.Object(
	{
		kind: Type.Union([
			Type.Literal("interval"),
			Type.Literal("daily"),
			Type.Literal("weekly"),
			Type.Literal("cron"),
		], { description: "Schedule type: interval, daily, weekly, or cron." }),
		every: Type.Optional(Type.Integer({ minimum: 1, description: "Required for interval: positive integer interval count." })),
		unit: Type.Optional(Type.Union([Type.Literal("minutes"), Type.Literal("hours")], { description: "Required for interval: 'minutes' or 'hours'." })),
		time: Type.Optional(Type.String({ description: "Required for daily or weekly: 24-hour HH:MM in the PiWeb server's local timezone, e.g. '09:00'." })),
		days: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { description: "Required for weekly: weekday indices 0 (Sun) through 6 (Sat)." })),
		expr: Type.Optional(Type.String({ description: "Required for cron: 5-field cron expression or @daily/@hourly/@weekly/@monthly." })),
	},
	{ description: "Execution schedule configuration." },
);

const ManageAutomationParams = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("create"),
		Type.Literal("update"),
		Type.Literal("delete"),
	], { description: "Operation to perform on PiWeb automation tasks." }),
	id: Type.Optional(Type.String({ description: "Target task ID (required for update and delete)." })),
	name: Type.Optional(Type.String({ description: "Short, descriptive task title (required for create)." })),
	prompt: Type.Optional(Type.String({ description: "Full instructions Pi should execute on each scheduled run (required for create)." })),
	cwd: Type.Optional(Type.String({ description: "Target workspace directory path. Defaults to the current session workspace when creating." })),
	schedule: Type.Optional(ScheduleSchema),
	enabled: Type.Optional(Type.Boolean({ description: "Whether scheduled execution is enabled (default true on create)." })),
});

const DESCRIPTION = [
	"List, create, update, or delete PiWeb scheduled automation tasks.",
	"Use this when the user asks to create or manage a scheduled/recurring automation task in conversation.",
	"If key details (what prompt to run, schedule frequency/time, or target workspace if ambiguous) are missing, clarify concisely or call ask_user_question before creating.",
].join(" ");

export interface ManageAutomationToolOptions {
	defaultCwd: string;
	storePath?: string;
	onMutated?: () => void | Promise<void>;
}

function buildScheduleInput(raw: Record<string, unknown> | undefined): AutomationSchedule | undefined {
	return raw === undefined ? undefined : validateSchedule(raw);
}

type AutomationToolDetails =
	| { action: "list"; count: number; tasks: AutomationTask[] }
	| { action: "create" | "update"; task: AutomationTask }
	| { action: "delete"; id: string; deleted: boolean };

function formatScheduleSummary(schedule: AutomationSchedule): string {
	switch (schedule.kind) {
		case "interval":
			return `every ${schedule.every} ${schedule.unit}`;
		case "daily":
			return `daily at ${schedule.time}`;
		case "weekly":
			return `weekly on [${schedule.days.join(",")}] at ${schedule.time}`;
		case "cron":
			return `cron (${schedule.expr})`;
	}
}

function formatTaskSummary(task: AutomationTask): string {
	const next = task.nextRunAt ? new Date(task.nextRunAt).toISOString() : "none";
	return `- ${task.name} (id=${task.id}, enabled=${task.enabled}, cwd=${task.cwd}, schedule=${formatScheduleSummary(task.schedule)}, nextRunAt=${next})`;
}

/** Factory for PiWeb's built-in automation management custom tool. */
export function createManageAutomationTool(options: ManageAutomationToolOptions) {
	const storePath = options.storePath ?? defaultAutomationsStorePath();
	return defineTool({
		name: MANAGE_AUTOMATION_TOOL,
		label: "Manage automation",
		description: DESCRIPTION,
		promptSnippet: "List, create, update, or delete PiWeb scheduled automation tasks",
		parameters: ManageAutomationParams,
		executionMode: "sequential",
		async execute(_toolCallId, params): Promise<AgentToolResult<AutomationToolDetails>> {
			switch (params.action) {
				case "list": {
					const snapshot = await listAutomations(storePath);
					const lines = snapshot.tasks.length > 0
						? snapshot.tasks.map(formatTaskSummary)
						: ["No automation tasks configured."];
					return {
						content: [{
							type: "text",
							text: `Default workspace: ${options.defaultCwd}\nAutomation tasks (${snapshot.tasks.length}):\n${lines.join("\n")}`,
						}],
						details: { action: "list", count: snapshot.tasks.length, tasks: snapshot.tasks },
					};
				}
				case "create": {
					const name = typeof params.name === "string" ? params.name.trim() : "";
					const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
					const schedule = buildScheduleInput(params.schedule as Record<string, unknown> | undefined);
					if (!name) throw new Error("Creating an automation requires a non-empty 'name'.");
					if (!prompt) throw new Error("Creating an automation requires a non-empty 'prompt'.");
					if (!schedule) throw new Error("Creating an automation requires 'schedule'.");
					const cwd = (typeof params.cwd === "string" && params.cwd.trim()) ? params.cwd.trim() : options.defaultCwd;
					const task = await createAutomationTask(
						{
							name,
							prompt,
							cwd,
							schedule,
							enabled: params.enabled,
						},
						storePath,
					);
					await options.onMutated?.();
					return {
						content: [{
							type: "text",
							text: `Created automation task:\n${formatTaskSummary(task)}`,
						}],
						details: { action: "create", task },
					};
				}
				case "update": {
					const id = typeof params.id === "string" ? params.id.trim() : "";
					if (!id) throw new Error("Updating an automation requires 'id'.");
					const schedule = buildScheduleInput(params.schedule as Record<string, unknown> | undefined);
					const task = await updateAutomationTask(
						id,
						{
							...(params.name !== undefined ? { name: params.name } : {}),
							...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
							...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
							...(schedule !== undefined ? { schedule } : {}),
							...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
						},
						storePath,
					);
					await options.onMutated?.();
					return {
						content: [{
							type: "text",
							text: `Updated automation task:\n${formatTaskSummary(task)}`,
						}],
						details: { action: "update", task },
					};
				}
				case "delete": {
					const id = typeof params.id === "string" ? params.id.trim() : "";
					if (!id) throw new Error("Deleting an automation requires 'id'.");
					const res = await deleteAutomationTask(id, storePath);
					await options.onMutated?.();
					return {
						content: [{
							type: "text",
							text: `Deleted automation task ${id}.`,
						}],
						details: { action: "delete", id, ...res },
					};
				}
			}
		},
	});
}
