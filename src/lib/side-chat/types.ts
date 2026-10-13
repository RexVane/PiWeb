/** Shared side-chat data. Main session messages never contain these records. */
export interface SideChatHistoryMessage {
	role: "user" | "assistant";
	text: string;
}

export interface SideChatModel {
	provider: string;
	id: string;
}

export function isSideChatModel(value: unknown): value is SideChatModel {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const model = value as Record<string, unknown>;
	return [model.provider, model.id].every((part) => typeof part === "string" && part.trim().length > 0 && part.length <= 512);
}

export interface SideChatRequest {
	requestId: string;
	threadId: string;
	text: string;
	history: SideChatHistoryMessage[];
	/** Omitted means follow the main conversation's current model. */
	model?: SideChatModel;
}

/**
 * 一次旁聊回答的真实用量，直接来自模型响应（不是估算）。
 * 它同时就是「这次问出去多少上下文」——input + 缓存读写就是发出去的 prompt 大小。
 */
export interface SideChatUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface SideChatProgress {
	requestId: string;
	revision: number;
	text: string;
	/** Poll responses may replace the text from this UTF-16 offset, avoiding repeated full answers. */
	textOffset?: number;
	done: boolean;
	aborted: boolean;
	error?: string;
	model?: string;
	/** 该回答用的模型上下文窗口；拿不到就不写，界面宁可什么都不显示也不显示假数字 */
	contextWindow?: number;
	usage?: SideChatUsage;
	contextTruncated?: boolean;
	lengthLimited?: boolean;
}

export const SIDE_CHAT_BODY_LIMIT = 2 * 1024 * 1024;
export const SIDE_CHAT_TEXT_LIMIT = 100_000;
export const SIDE_CHAT_HISTORY_LIMIT = 1000;
export const isSideChatId = (value: unknown): value is string =>
	typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
