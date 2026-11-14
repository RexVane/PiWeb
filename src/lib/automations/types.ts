import type { ToolPreset } from "../types";

export type AutomationSchedule =
	| { kind: "interval"; every: number; unit: "minutes" | "hours" }
	| { kind: "daily"; time: string }
	| { kind: "weekly"; days: number[]; time: string }
	| { kind: "cron"; expr: string };

export interface AutomationModelRef {
	provider: string;
	id: string;
}

export interface AutomationSchedulePreview {
	nextRunAt: number | null;
	timeZone: string;
	computedAt: number;
}

export type AutomationRunStatus = "running" | "success" | "error" | "skipped";

export interface AutomationTask {
	id: string;
	name: string;
	prompt: string;
	cwd: string;
	schedule: AutomationSchedule;
	enabled: boolean;
	toolPreset: ToolPreset;
	model?: AutomationModelRef;
	createdAt: number;
	updatedAt: number;
	nextRunAt: number | null;
	/** Last scheduler observation while this occurrence was queued behind active work. */
	waitingSeenAt?: number;
	scheduledClaim?: { id: string; dueAt: number; ownerPid: number; ownerBirth?: string; ownerInstance: string };
	lastRunAt?: number;
	lastRunStatus?: AutomationRunStatus;
	lastSessionPath?: string;
}

export interface AutomationRun {
	ownerInstance?: string;
	ownerBirth?: string;
	heartbeatAt?: number;
	cancelRequestedAt?: number;
	id: string;
	taskId: string;
	taskName: string;
	cwd: string;
	trigger: "schedule" | "manual";
	status: AutomationRunStatus;
	startedAt: number;
	/** Process that owns this in-flight run; used only for local instance coordination. */
	ownerPid?: number;
	finishedAt?: number;
	sessionPath?: string;
	summary?: string;
	error?: string;
}

export interface AutomationTaskInput {
	name: string;
	prompt: string;
	cwd: string;
	schedule: AutomationSchedule;
	enabled?: boolean;
	toolPreset?: ToolPreset;
	model?: AutomationModelRef;
}

export interface AutomationsStateSnapshot {
	storeError?: { message: string; expectedHash: string; canSalvage: boolean; canRestore: boolean };
	tasks: AutomationTask[];
	runs: AutomationRun[];
	activeTaskIds: string[];
	schedulerStarted: boolean;
}
