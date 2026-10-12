import { calculateContextTokens, estimateTokens, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { WebSnapshot } from "../types";

/** 冷会话沿用 SDK 的投影口径：API usage + 尾部估算；压缩 / 编辑后不信旧 usage。 */
export function projectedContextUsage(
	projection: ReturnType<SessionManager["buildSessionProjection"]>,
	branch: ReturnType<SessionManager["getBranch"]>,
	contextWindow: number,
): WebSnapshot["contextUsage"] {
	if (contextWindow <= 0) return null;
	let lastUsage: { tokens: number; messageIndex: number; branchIndex: number } | undefined;
	let messageIndex = 0;
	for (const entry of projection.entries) {
		for (const message of entry.messages) {
			if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && message.usage) {
				const tokens = calculateContextTokens(message.usage);
				if (tokens > 0) lastUsage = { tokens, messageIndex, branchIndex: branch.findIndex((raw) => raw.id === entry.sourceEntry.id) };
			}
			messageIndex++;
		}
	}
	const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
	if (compactionIndex >= 0 && (!lastUsage || lastUsage.branchIndex <= compactionIndex)) {
		return { tokens: null, contextWindow, percent: null };
	}
	const invalidatingIndex = branch.findLastIndex((entry) => entry.type === "compaction" || entry.type === "context_edit");
	const tokens = lastUsage && lastUsage.branchIndex > invalidatingIndex
		? lastUsage.tokens + projection.messages.slice(lastUsage.messageIndex + 1).reduce((sum, message) => sum + estimateTokens(message), 0)
		: projection.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	return { tokens, contextWindow, percent: tokens / contextWindow * 100 };
}
