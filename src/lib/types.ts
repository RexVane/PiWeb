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
	/** Historical shell output contained irreversible Unicode replacement characters. */
	encodingLoss?: boolean;
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
	/** assistant：生成结束的时刻（热会话由 message_end 打点；冷会话没有，回落到 timestamp） */
	endedAt?: number;
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
	| { type: "toolResult"; toolCallId?: string; text: string; isError?: boolean; title?: string; encodingLoss?: boolean; patch?: string };

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
			encodingLoss?: boolean;
			/** edit/write 工具附带的 unified patch（pi 的 details.patch），前端渲染红绿 diff */
			patch?: string;
			ts: number;
	  }
	| { type: "status"; isStreaming: boolean; state: string; ts: number }
	| { type: "queue"; steering: string[]; followUp: string[]; ts: number }
	| {
			type: "model";
			provider?: string;
			model?: string;
			thinkingLevel?: string;
			/** 当前模型支持的档位；切模型后随之更新，否则前端菜单停留在旧模型的档位 */
			thinkingLevels?: string[];
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
	| {
			/** 资源（扩展/技能/模板/命令）重载后的新清单；前端据此刷新 / 菜单与设置面板 */
			type: "resources";
			skills: WebSnapshot["skills"];
			promptTemplates: WebSnapshot["promptTemplates"];
			extensionCommands: WebSnapshot["extensionCommands"];
			projectTrust: WebSnapshot["projectTrust"];
			resourceDiagnostics: WebSnapshot["resourceDiagnostics"];
			ts: number;
	  }
	| {
			/** 扩展请求界面交互（对应 pi RPC 模式的 extension_ui_request）：select/confirm/input 需要浏览器应答 */
			type: "extension_ui";
			id: string;
			method: "select" | "confirm" | "input" | "notify" | "setStatus" | "setWorkingMessage";
			title?: string;
			message?: string;
			options?: string[];
			placeholder?: string;
			notifyType?: "info" | "warning" | "error";
			statusKey?: string;
			statusText?: string;
			timeout?: number;
			ts: number;
	  }
	| { type: "error"; message: string; ts: number };

export interface WebStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	llmMs: number;
	toolMs: number;
	ttftMs: number;
	ttftSteps: number;
	decodeMs: number;
	decodeTokens: number;
}

export interface ContextResource {
	/** Human-readable producer path reported by Pi's resource loader. */
	path: string;
	/** Exact text appended to the model context. */
	content: string;
	/** Whether Pi discovered the file directly or an extension appended it. */
	source: "project" | "extension";
}

/** SSE 连接建立时先发的完整快照 */
export interface WebSnapshot {
	seq: number;
	sessionPath: string;
	cwd: string;
	name: string;
	/** 兼容旧版 Web 客户端的上下文路径列表。 */
	contextFiles: string[];
	/** 注入的上下文资源（AGENTS.md 与扩展附加 prompt，来自 Pi 资源加载器）。 */
	contextResources: ContextResource[];
	/** 斜杠命令数据源：技能 */
	skills: { name: string; description: string }[];
	/** 斜杠命令数据源：提示模板（~/.pi/agent/prompts、<cwd>/.pi/prompts 里的 .md） */
	promptTemplates: { name: string; description: string; argumentHint?: string }[];
	/** 斜杠命令数据源：扩展注册的命令（只有热会话才有） */
	extensionCommands: { name: string; description: string; source: string }[];
	/** 项目信任：目录含 .pi/extensions 等需要信任的资源时，pi 只在受信任时才加载它们 */
	projectTrust: { required: boolean; trusted: boolean; source: string };
	/** 资源诊断：扩展加载失败、技能/模板解析警告（来自 pi 资源加载器） */
	resourceDiagnostics: { kind: "extension" | "skill" | "prompt" | "command"; path?: string; message: string }[];
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
		| "clearQueue"
		| "setActiveTools"
		| "extensionUiResponse"
		| "reload";
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
	/** setActiveTools：目标激活的工具名列表（与可用集求交集） */
	names?: string[];
	/** extensionUiResponse：对应 extension_ui 事件的 id 与应答 */
	requestId?: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}
