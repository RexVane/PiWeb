/**
 * request_permission：模型在「沙箱拒绝了一次写入/命令」之后，带理由申请**一次**更宽的执行范围。
 *
 * 对齐 DSH 的升权模型：不是整档切换，而是「最小范围 + 一句理由 + 明确只这一次」，
 * 由用户当场点头。批准后用 `consumeGrant()` 消耗掉，下一条命令就回到原档位。
 *
 * 为什么做成工具而不是自动弹窗：自动弹窗会在模型每次被拒时打扰用户；
 * 让模型自己判断"这真的需要"再请求，用户拿到的理由也更具体。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AskOutcome, AskQuestion } from "./ask-user";
import type { EscalationScope } from "./sandbox/bash-operations";
import type { PermissionAuditEvent } from "./permission-audit";
import { REQUEST_PERMISSION_TOOL } from "./permission-request";
import { toolPresetLabel } from "./tool-preset";
import type { ToolPreset } from "./types";
import { permissionActionDescription, type PermissionAction } from "./permission-action";

export { REQUEST_PERMISSION_TOOL };

const APPROVE = "允许一次（推荐）";
const DENY = "拒绝";

const Params = Type.Object({
	reason: Type.String({
		description: "One sentence in the user's language explaining exactly why this command needs more access and what it will touch.",
	}),
	scope: Type.Union([Type.Literal("workspace"), Type.Literal("full")], {
		description:
			'"workspace" allows one write inside the workspace (use it when the current preset is read-only); ' +
			'"full" allows one command to run without the sandbox (use it when a write outside the workspace is genuinely required).',
	}),
	deniedToolCallId: Type.Optional(Type.String({ description: "The ID of the blocked tool call being approved. Omit only to use the most recently blocked call." })),
});

const DESCRIPTION = [
	"Ask the user to approve exactly one wider-scoped action after the sandbox blocked a command or a write.",
	"Use it only after a real denial: quote what was blocked and why the task needs it. The approval covers ONE command and expires immediately after it runs.",
	"Never retry the same command before the user answers, and never ask again for the same command unless something changed.",
].join(" ");

export interface PermissionRequestContext {
	ask: (questions: AskQuestion[], signal?: AbortSignal) => Promise<AskOutcome>;
	/** 记下一次性的批准 */
	grant: (scope: EscalationScope, action: PermissionAction) => void;
	deniedAction: (toolCallId?: string) => PermissionAction | undefined;
	/** 当前档位（用来在理由里说清"从哪一档升到哪一档"，也进审计） */
	preset: () => ToolPreset;
	/** 审计：决定写进会话 JSONL（批准/拒绝/没应答） */
	record?: (event: PermissionAuditEvent) => void;
}

interface PermissionRequestDetails {
	outcome?: AskOutcome;
	granted: EscalationScope | null;
	permissionOutcome: string;
	action?: PermissionAction;
}

export function createPermissionRequestTool(context: PermissionRequestContext) {
	return defineTool({
		name: REQUEST_PERMISSION_TOOL,
		label: "Request permission",
		description: DESCRIPTION,
		promptSnippet: "Ask the user to approve one wider-scoped command after a sandbox denial",
		parameters: Params,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const scope = params.scope;
			const reason = String(params.reason ?? "").trim();
			const preset = context.preset();
			const action = context.deniedAction(params.deniedToolCallId);
			if (!action) return { content: [{ type: "text" as const, text: "No blocked action is available to approve. Attempt the required action within the current boundary first; no permission was granted." }], details: { granted: null, permissionOutcome: "unanswered" } as PermissionRequestDetails };
			const label = scope === "full" ? "完全权限（不经过沙箱，只这一次）" : "工作区内修改（可写工作区，只这一次）";
			const outcome: AskOutcome = await context.ask([
				{
					question: `当前档位是「${toolPresetLabel(preset)}」。模型请求放宽到「${label}」，理由：${reason || "（未给出）"}。批准只适用于这次完整调用：\n${permissionActionDescription(action)}\n是否允许这一次？`,
					header: "权限申请",
					options: [
						{ label: APPROVE, description: "仅允许上面展示的工具和全部参数，执行一次后失效。" },
						{ label: DENY, description: "维持当前档位；模型需要换一种不需要越界的做法。" },
					],
				},
			], signal);

			const decided = outcome.status === "answered"
				? (outcome.answers[0]?.selected ?? []).some((entry) => entry.startsWith("允许")) ? "approved" : "denied"
				: "unanswered";
			context.record?.({
				kind: "decision", approved: decided === "approved", outcome: decided, scope, preset, reason, at: Date.now(),
			});

			// details 显式标注：三个分支的 outcome 收窄类型不同，不标注会被 infer 成第一个分支
			const details: PermissionRequestDetails = { outcome, granted: null, permissionOutcome: decided, action };
			if (decided === "unanswered") {
				return {
					content: [{ type: "text", text: "The user did not answer, so nothing was approved. Keep the current preset and do not retry the blocked command." }],
					details,
				};
			}
			if (decided === "approved") {
				if (signal?.aborted || context.preset() !== preset) return { content: [{ type: "text" as const, text: "The permission preset changed or this request was cancelled. Nothing was approved." }], details: { ...details, permissionOutcome: "unanswered" } };
				context.grant(scope, action);
				details.granted = scope;
				return {
					content: [{ type: "text", text: `Approved for one action at scope "${scope}". Run exactly what you described; the grant is consumed by the next escalated command or write.` }],
					details,
				};
			}
			return {
				content: [{ type: "text", text: "The user declined. Do not retry the blocked command or look for another way around the boundary; report what is blocked and continue with what you can do." }],
				details,
			};
		},
	});
}
