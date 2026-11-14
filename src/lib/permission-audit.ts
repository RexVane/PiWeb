/**
 * permission-audit：把「升权请求 / 决定 / 实际使用」写进会话 JSONL。
 *
 * 用 pi 的 custom entry（`type: "custom"`, `customType: "piweb_permission"`）：
 *   - 它随会话走，导出、归档、换机器都还在；
 *   - 官方明确它**不参与 LLM 上下文**（`buildSessionContext` 会忽略），所以不会污染对话；
 *   - 与 pi 自己的 session 格式同一套，不需要另建一个审计文件。
 *
 * 记录三类事：
 *   - decision：模型申请了更宽的范围，用户批准/拒绝/没应答（带理由与当时档位）；
 *   - used：批准后的那一条命令真的跑了（带命令原文与范围）。
 *
 * 写失败只告警不抛：审计不该让一次已经批准的命令执行失败。
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EscalationScope } from "./sandbox/bash-operations";
import type { ToolPreset } from "./types";

export const PERMISSION_AUDIT_TYPE = "piweb_permission";

export type PermissionAuditEvent =
	| { kind: "blocked"; preset: ToolPreset; toolName: string; command: string; reason: string; at: number }
	| {
		kind: "decision";
		approved: boolean;
		outcome: "approved" | "denied" | "unanswered";
		scope: EscalationScope;
		preset: ToolPreset;
		reason: string;
		at: number;
	}
	| {
		kind: "used";
		scope: EscalationScope;
		preset: ToolPreset;
		command: string;
		at: number;
	};

/** 写入会话审计。签名收窄成只需要 appendCustomEntry，便于测试注入。 */
export function appendPermissionAudit(
	sm: Pick<SessionManager, "appendCustomEntry"> | null | undefined,
	event: PermissionAuditEvent,
): void {
	if (!sm) return;
	try {
		sm.appendCustomEntry(PERMISSION_AUDIT_TYPE, event);
	} catch (error) {
		console.warn(`[piweb] 权限审计写入失败：${(error as Error)?.message ?? error}`);
	}
}
