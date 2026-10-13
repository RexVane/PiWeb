/** Shared side-chat data. Main session messages never contain these records. */
export interface SideChatHistoryMessage {
	role: "user" | "assistant";
	text: string;
}

export interface SideChatRequest {
	requestId: string;
	threadId: string;
	text: string;
	history: SideChatHistoryMessage[];
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
	contextTruncated?: boolean;
	lengthLimited?: boolean;
}

export const SIDE_CHAT_BODY_LIMIT = 2 * 1024 * 1024;
export const SIDE_CHAT_TEXT_LIMIT = 100_000;
export const SIDE_CHAT_HISTORY_LIMIT = 1000;
export const isSideChatId = (value: unknown): value is string =>
	typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
