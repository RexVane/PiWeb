/**
 * 客户端 / 服务端共享类型：Web 事件协议、轨迹账本、会话视图模型。
 * 服务端把 pi 的 AgentSessionEvent 翻译成这里的渲染级事件，浏览器只消费这些。
 */

// ---------- 会话元信息 ----------

export interface SessionSummary {
	/** 会话 JSONL 文件的绝对路径（Base64url 编码后作为 URL id） */
	path: string;
	name?: string;
	cwd: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

// ---------- 轨迹账本 ----------

export type TrajKind = "system" | "context" | "user" | "message" | "tool" | "compacted";

export interface TrajTokens {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface TrajEntry {
	seq: number;
	kind: TrajKind;
	ts: number;
	/** 标题行（工具名 / 摘要等） */
	title?: string;
	/** 预览文本（markdown） */
	preview?: string;
	/** 完整内容（记录 inspector 展开） */
	detail?: string;
	thinking?: string;
	tokens?: TrajTokens;
	isError?: boolean;
	toolName?: string;
	toolCallId?: string;
	timing?: { ttftMs?: number; decodeMs?: number; durationMs?: number };
	/** UI-derived turn number; omitted in the persisted event ledger. */
	turn?: number;
}

// ---------- 服务器 → 浏览器 事件 ----------

/** 消息在客户端渲染时的统一形状（pi AgentMessage 的投影） */
export interface WebMessage {
	id?: string;
	role: "user" | "assistant" | "toolResult" | "custom" | "other";
	content: WebContent[];
	timestamp?: number;
	stopReason?: string;
	errorMessage?: string;
	/** assistant：模型/用量/思考级别等元信息 */
	usage?: TrajTokens & { cost?: { total?: number } };
	model?: string;
	provider?: string;
	thinkingLevel?: string;
}

export type WebContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: unknown }
	| { type: "toolResult"; toolCallId?: string; text: string; isError?: boolean; title?: string };

export type WebEvent =
	| { type: "delta"; kind: "text" | "thinking"; contentIndex: number; delta: string; ts: number }
	| { type: "message"; message: WebMessage; phase: "start" | "end"; ts: number }
	| {
			type: "tool";
			id: string;
			name: string;
			args: unknown;
			state: "running" | "done";
			partialResult?: string;
			result?: string;
			isError?: boolean;
			ts: number;
	  }
	| { type: "status"; isStreaming: boolean; state: string; ts: number }
	| { type: "queue"; steering: string[]; followUp: string[]; ts: number }
	| {
			type: "model";
			provider?: string;
			model?: string;
			thinkingLevel?: string;
			ts: number;
	  }
	| {
			type: "usage";
			stats: WebStats | null;
			contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
			ts: number;
	  }
	| { type: "compaction"; phase: "start" | "end"; reason?: string; errorMessage?: string; ts: number }
	| { type: "traj"; entry: TrajEntry; ts: number }
	| { type: "name"; name: string; ts: number }
	| { type: "tools"; active: string[]; all: string[]; ts: number }
	| { type: "error"; message: string; ts: number };

export interface WebStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
}

/** SSE 连接建立时先发的完整快照 */
export interface WebSnapshot {
	seq: number;
	sessionPath: string;
	cwd: string;
	name: string;
	/** 注入的上下文文件（AGENTS.md 等，来自 pi 资源加载器） */
	contextFiles: string[];
	/** 斜杠命令数据源：prompt 模板与技能 */
	promptTemplates: { name: string; description: string }[];
	skills: { name: string; description: string }[];
	messages: WebMessage[];
	model?: { provider: string; id: string; name: string };
	thinkingLevel?: string;
	thinkingLevels: string[];
	tools: { active: string[]; all: { name: string; description?: string }[] };
	stats: WebStats | null;
	contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
	queue: { steering: string[]; followUp: string[] };
	trajectory: TrajEntry[];
	isStreaming: boolean;
}

// ---------- 浏览器 → 服务器 命令 ----------

export type ToolPreset = "readonly" | "standard" | "full";

export interface ImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
}

export interface AgentCommand {
	cmd:
		| "prepare"
		| "prompt"
		| "steer"
		| "followUp"
		| "abort"
		| "compact"
		| "setModel"
		| "setThinkingLevel"
		| "setToolPreset"
		| "rename"
		| "fork"
		| "cycleModel"
		| "navigate"
		| "clearQueue";
	text?: string;
	images?: ImageAttachment[];
	instructions?: string;
	provider?: string;
	modelId?: string;
	level?: string;
	preset?: ToolPreset;
	entryId?: string;
	behavior?: "steer" | "followUp";
	direction?: "forward" | "backward";
}
