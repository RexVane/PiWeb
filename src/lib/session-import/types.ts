/**
 * 本地会话导入：外部工具的对话 → pi 会话。
 *
 * 这里定义"中间层"的形状——它刻意贴着 pi 的会话 schema（角色、content 块、
 * 时间戳、用量），而不是拍平成纯文本：思考、工具调用/结果、图片、用量都要能带过去。
 * 每个来源只负责把自己的格式解析成这些类型，写入合法性由 writer 统一保证。
 */

/** 支持导入的来源 */
export type ImportSource = "claude" | "codex" | "grok" | "zcode" | "dsh" | "opencode";

export const IMPORT_SOURCES: ImportSource[] = ["claude", "codex", "grok", "zcode", "dsh", "opencode"];

export interface ImportedUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	totalTokens?: number;
}

/** 与 pi 的 content 块对齐（够用即可：其余类型在读取时被忽略） */
export type ImportedBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments?: unknown }
	| { type: "image"; data: string; mimeType: string };

export type ImportedMessage =
	| { role: "user"; content: ImportedBlock[]; timestamp: number }
	| {
			role: "assistant";
			content: ImportedBlock[];
			timestamp: number;
			api?: string;
			provider?: string;
			model?: string;
			usage?: ImportedUsage;
			stopReason?: string;
			errorMessage?: string;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName?: string;
			content: ImportedBlock[];
			isError?: boolean;
			timestamp: number;
	  };

export type ImportedEntry =
	| { type: "message"; message: ImportedMessage }
	| { type: "session_info"; name: string }
	| { type: "model_change"; provider: string; modelId: string };

/** 扫描结果里的一行（会发给前端；location 属服务端内部信息，路由层要剥掉） */
export interface ExternalSessionSummary {
	source: ImportSource;
	/** 源里的稳定标识（文件名/uuid/DB 行 id）：幂等键的一半 */
	externalId: string;
	title?: string;
	/** 源会话原本的项目目录（本机存在就导入回该工作区） */
	projectPath?: string;
	provider?: string;
	model?: string;
	createdAt?: number;
	updatedAt?: number;
	/** 未统计时为 undefined（界面显示 —） */
	messageCount?: number;
	/** 服务端内部定位信息（文件路径 / 库+id），不下发 */
	location: string;
}

export interface ImportedSession {
	summary: ExternalSessionSummary;
	entries: ImportedEntry[];
	/** 跳过内容的原因（侧链、合成消息等），用于导入报告 */
	skipped?: string[];
}

export interface ScanOptions {
	/**
	 * 每个来源最多返回多少条（按最近活动倒序）。界面只列最近的若干条，所以扫描阶段就该停手：
	 * 文件类的来源按 mtime 排序后只读前若干个头，SQLite 类的直接 LIMIT，不把上千个会话全读一遍。
	 * 传 0 或省略表示不限（导入时按 id 反查需要看到全部）。
	 */
	limit?: number;
}

export interface ImportSourceModule {
	id: ImportSource;
	/** 列出该来源在本机可导入的会话（只读扫描） */
	scan(options?: ScanOptions): Promise<ExternalSessionSummary[]>;
	/** 读取单个会话并转成 pi 条目；读不到返回 null */
	read(summary: ExternalSessionSummary): Promise<ImportedSession | null>;
}

/** 时间戳容错：非法值不回落到"现在"（那会伪造历史），由调用方决定兜底值 */
export function toEpochMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		// 秒级时间戳（如 1789273099）按秒理解
		return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return toEpochMs(numeric);
	}
	return undefined;
}

/** 文本块：空串直接丢掉，避免产出空 content */
export function textBlock(value: unknown): ImportedBlock | null {
	if (typeof value !== "string") return null;
	return value.trim() ? { type: "text", text: value } : null;
}

export function compactBlocks(blocks: Array<ImportedBlock | null | undefined>): ImportedBlock[] {
	return blocks.filter((block): block is ImportedBlock => Boolean(block));
}

/** 工具返回值可能是字符串、对象或数组，统一成内容块 */
export function outputBlocks(value: unknown): ImportedBlock[] {
	if (typeof value === "string") return compactBlocks([textBlock(value)]);
	if (Array.isArray(value)) return compactBlocks(value.flatMap((item) => outputBlocks(item)));
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") return compactBlocks([textBlock(record.text)]);
		if (typeof record.content === "string") return compactBlocks([textBlock(record.content)]);
		try {
			return compactBlocks([textBlock(JSON.stringify(value, null, 2))]);
		} catch {
			return [];
		}
	}
	return [];
}

/** 参数可能是 JSON 字符串（codex/dsh 就是），尽量还原成对象 */
export function parseArguments(value: unknown): unknown {
	if (typeof value !== "string") return value ?? {};
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** 标题候选：源标题 → 首条用户消息前 48 字 */
export function fallbackTitle(entries: ImportedEntry[], explicit?: string): string {
	const trimmed = explicit?.replace(/\s+/g, " ").trim();
	if (trimmed) return trimmed.slice(0, 120);
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join(" ").replace(/\s+/g, " ").trim();
		if (text) return text.slice(0, 48);
	}
	return "";
}

/** 标题上限：列表只用来辨认会话，几百字的提示词原样塞进接口响应只是浪费带宽 */
export const TITLE_LIMIT = 120;

/** 把任意来源的标题字段压成一行、限长；空串按"没有标题"处理 */
export function cleanTitle(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const flat = value.replace(/\s+/g, " ").trim();
	return flat ? flat.slice(0, TITLE_LIMIT) : undefined;
}
