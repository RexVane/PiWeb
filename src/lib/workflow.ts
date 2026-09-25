import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkflowMode, WorkflowState } from "./types";

export type { WorkflowMode, WorkflowState } from "./types";

const ENTRY_TYPE = "piweb.workflow.v1";
const DEFAULT_STATE: WorkflowState = { mode: "agent", planStatus: "idle", goal: "" };

export function isWorkflowMode(value: unknown): value is WorkflowMode {
	return value === "agent" || value === "plan" || value === "goal";
}

export function readWorkflow(sm: SessionManager): WorkflowState {
	for (const entry of sm.getBranch().slice().reverse()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as Partial<WorkflowState> | undefined;
		if (!data || !isWorkflowMode(data.mode)) break;
		return {
			mode: data.mode,
			planStatus: data.mode === "plan" && data.planStatus === "ready" ? "ready" : "idle",
			planId: data.mode === "plan" && typeof data.planId === "string" ? data.planId : undefined,
			goal: data.mode === "goal" && typeof data.goal === "string" ? data.goal.slice(0, 8_000) : "",
		};
	}
	return { ...DEFAULT_STATE };
}

export function saveWorkflow(sm: SessionManager, state: WorkflowState): void {
	sm.appendCustomEntry(ENTRY_TYPE, state);
}

/** 最近一条工作流记录之后还没有用户消息：下一条（含编辑重发的）用户消息就是 Goal 的目标。 */
export function awaitingGoalMessage(sm: SessionManager): boolean {
	for (const entry of sm.getBranch().slice().reverse()) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) return true;
		if (entry.type === "message" && entry.message.role === "user") return false;
	}
	return true;
}

export function workflowInstruction(state: WorkflowState): string {
	if (state.mode === "plan") {
		return state.planStatus === "executing"
			? "The user approved the plan in this conversation. Execute it now, verify the result, and report any unfinished work. Respect the active tool permissions."
			: "Planning mode: investigate using read-only tools. Do not edit files, run commands, or cause side effects. Produce a concrete implementation plan with verification steps, then stop and wait for explicit approval in PiWeb.";
	}
	if (state.mode === "goal") {
		return `Goal mode: work toward the user's objective, verify the result before claiming completion, and clearly report blockers or unverified assumptions. Do not silently change the objective. Objective: ${state.goal || "Use the next user message as the objective."}`;
	}
	return "";
}

export function planCanRun(state: WorkflowState): boolean {
	return state.mode === "plan" && state.planStatus === "ready";
}
