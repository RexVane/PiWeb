import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { AgentCommand, ImageAttachment, ToolPreset, WebEvent, WebSnapshot } from "../types";

/** Shared side-chat data. Main session messages never contain these records. */
export interface SideChatHistoryMessage {
	role: "user" | "assistant";
	text: string;
}

/**
 * 本地 id 生成。crypto.randomUUID 只在安全上下文（https / localhost）存在，
 * 而手机经「远程连接」访问的是局域网 http —— 那里 `crypto.randomUUID` 是 undefined，
 * 直接调用会让整个旁聊面板渲染时抛错、整块打不开。
 * 退回 getRandomValues（非安全上下文也有）拼 UUID v4；两者都没有才会走到最后的随机串。
 */
export function sideChatId(): string {
	const web = globalThis.crypto as Crypto | undefined;
	if (typeof web?.randomUUID === "function") return web.randomUUID();
	if (typeof web?.getRandomValues === "function") {
		const bytes = web.getRandomValues(new Uint8Array(16));
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
		return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
	}
	return `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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
	kind?: "prepare";
	retry?: boolean;
	text: string;
	history: SideChatHistoryMessage[];
	images?: ImageAttachment[];
	entries?: FileEntry[];
	leafId?: string;
	thinkingLevel?: string;
	toolPreset?: ToolPreset;
	activeTools?: string[];
	/** Omitted means follow the main conversation's current model. */
	model?: SideChatModel;
}

/**
 * 一次旁聊回答的最后一轮模型请求的真实用量（不是估算）。
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
	/** 拼这次上下文时的真实字符数（分项用；系统提示词 + 引用的主会话背景） */
	characters?: { systemPrompt: number; background: number; systemTools?: number };
	/** The currently executing tool; null clears a prior tool status. */
	activeTool?: string | null;
	/** Ordered events use the same protocol as the main conversation. */
	events?: WebEvent[];
	snapshot?: WebSnapshot;
	extensionUiRequests?: WebSnapshot["extensionUiRequests"];
	entries?: FileEntry[];
	leafId?: string;
	contextTruncated?: boolean;
	lengthLimited?: boolean;
}

export const SIDE_CHAT_BODY_LIMIT = 272 * 1024 * 1024;
export const SIDE_CHAT_HISTORY_BODY_LIMIT = 2 * 1024 * 1024;
export const SIDE_CHAT_ENTRIES_LIMIT = 16 * 1024 * 1024;
export const SIDE_CHAT_TEXT_LIMIT = 100_000;
export const SIDE_CHAT_HISTORY_LIMIT = 1000;
export const isSideChatId = (value: unknown): value is string =>
	typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);

export interface SideChatControl extends Omit<SideChatRequest, "requestId" | "text" | "history"> { history?: SideChatHistoryMessage[]; command: AgentCommand; }
export interface SideChatControlResult { snapshot: WebSnapshot; entries: FileEntry[]; leafId?: string; commandData?: Record<string, unknown>; }
