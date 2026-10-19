/**
 * agent-manager：AgentSession 池 + pi 事件 → Web 事件翻译 + SSE 订阅管理。
 * 打开会话即惰性冷启动（createAgentSession），空闲回收，事件先快照后增量。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ExtensionRunner, ModelRegistry, formatSkillsForPrompt, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import {
	getResourceLoader,
	createSessionResourceLoader,
	resourceLoaderVersion,
	resourceLoaderIsStale,
	getSettingsManager,
	getAgentDir,
	loadProjectContextFiles,
	peekResourceLoader,
	refreshResourceLoaderIfStale,
	resolveProjectTrust,
	resourceLoaderReady,
	withResourceLock,
	TOOL_PRESETS,
	presetAllowsTool,
	SessionManager,
	createAgentSession,
	getModelRuntime,
	refreshModelRuntime,
	openSessionManager,
} from "./pi";
import { createExtensionUiBridge, type ExtensionUiBridge } from "./extension-ui";
import { createAskUserTool } from "./ask-user-tool";
import { createGrowthTracker, GROWTH_TRACKER_VERSION, type GrowthTracker } from "./growth-tracker";
import { userTurnsFromEntries } from "./growth-turns";
import { projectedContextUsage } from "./session/metrics";
import { TrajLedger, buildTrajectoryFromEntries, toolStepPreview, toTrajTokens } from "./trajectory";
import { startArchivedSessionRetention } from "./session-retention";
import { sanitizeToolOutput } from "./text-sanitize";
import { BoundaryError } from "./path-security";
import { newSessionThinkingLevel } from "./thinking-level";
import { getGrowthInitConsent, setGrowthInitConsent } from "./workspace-store";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
	AgentCommand,
	ContextBreakdown,
	ContextResource,
	GrowthRound,
	TrajEntry,
	ToolPreset,
	WebEvent,
	WebMessage,
	WebSnapshot,
	WebStats,
} from "./types";

const IDLE_MS = 10 * 60 * 1000;
const MAX_ACTIVE = 6;
const BUFFER_CAP = 400;
const SHUTDOWN_TIMEOUT_MS = 5_000;
/** 外来写入重载后，这么久之内连上的快照都带着提示 */
const EXTERNAL_RELOAD_NOTICE_MS = 60_000;

interface Managed {
	viewerAvailable?: () => boolean;
	sessionPath: string;
	cwd: string;
	sm: SessionManager;
	session: AgentSession | null;
	creating: Promise<AgentSession> | null;
	subscribers: Set<(seq: number, json: string) => void>;
	/** 长轮询的浏览器在两次请求之间没有订阅，到这个时间点之前仍算有人在看（见 holdViewer） */
	viewerGraceUntil?: number;
	/** 本轮已排队推送上下文分项（publishContextBreakdown 合并同一轮的多次触发） */
	breakdownQueued?: boolean;
	/** 首次运行后 pi 才会把系统分段持久化，届时用它把分类从差分换成投影口径，只换一次 */
	breakdownProjected?: boolean;
	buffer: { seq: number; json: string }[];
	seq: number;
	/**
	 * 这一份 Managed 的身份，拼进 SSE 事件 id（`<epoch>.<seq>`）。
	 * seq 每次重新注册（服务重启、空闲回收后再打开）都从 0 数起，光凭 seq 续传
	 * 会把旧连接的 Last-Event-ID 对到新一轮的事件上。
	 */
	epoch: string;
	ledger: TrajLedger;
	lastActive: number;
	toolPreset: ToolPreset;
	/** 显式逐项选择优先于 preset；保留失效名称以便资源重新启用后恢复用户选择。 */
	customActiveTools?: string[];
	/**
	 * SDK / 扩展要求打开的工具（defaultTools 里的 +codemode、MCP 打开的 codemode、tool_search 载入的工具…）。
	 * 档位过滤会把它们从激活集里拿掉，记在这里，换到放行它们的档位时才能恢复。
	 */
	requestedTools: Set<string>;
	resourceVersion: number;
	resourceReloadPending: boolean;
	resourceReloading: boolean;
	promptSubmitting: boolean;
	runActive: boolean;
	disposed: boolean;
	inflightId?: string;
	inflightIndex?: number;
	messageIds: WeakMap<object, string>;
	/** 用户在本会话里最后一次显式选择的思考级别；切模型后按新模型就近钳制重新应用，不让选择被 SDK 带丢 */
	desiredThinkingLevel?: string;
	/** 正在流式生成、尚未进入 session.messages 的助手消息（SDK 的共享 partial 对象）；中途订阅的快照要带上它 */
	inflight: unknown | null;
	/** 扩展界面请求桥（select/confirm/input/notify → 浏览器） */
	ui: ExtensionUiBridge | null;
	/** 项目生长：影子仓库快照的触发器（首个会话事件时创建，dispose 时释放） */
	growth: GrowthTracker | null;
	/** JSONL 已核对到的字节位置（总在整行末尾）；之后多出来的行要看是不是别的进程写的（见 externalEntryCount） */
	diskSize: number;
	/** 已发现、还没重载进来的外来条目数（终端 pi 同时在写这个会话） */
	externalEntries: number;
	/** 这一份是因外来写入从磁盘重载出来的：快照带上，前端提示一次 */
	externalReload?: { entries: number; at: number };
}

const globalForAgentManager = globalThis as typeof globalThis & {
	__piWebSessions?: Map<string, Managed>;
};
const sessions = globalForAgentManager.__piWebSessions ??= new Map<string, Managed>();

// ---------- 消息投影 ----------

function textOf(content: any): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(textOf).join("");
	if (typeof content === "object") {
		if (typeof content.text === "string") return content.text;
		if (typeof content.thinking === "string") return content.thinking;
	}
	return "";
}

export function toWebMessage(m: any, entryId?: string): WebMessage {
	if (!m || typeof m !== "object") return { role: "other", content: [] };
	const out: WebMessage = { role: "other", content: [] };
	if (entryId) out.id = entryId;
	else if (typeof m.id === "string") out.id = m.id;
	if (typeof m.timestamp === "number") out.timestamp = m.timestamp;
	const items: WebMessage["content"] = [];
	const content = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
	for (const c of content) {
		if (!c || typeof c !== "object") continue;
		if (c.type === "text" && typeof c.text === "string") items.push({ type: "text", text: c.text });
		else if (c.type === "thinking" && typeof c.thinking === "string")
			items.push({ type: "thinking", thinking: c.thinking });
		else if (c.type === "toolCall")
			items.push({ type: "toolCall", id: String(c.id ?? ""), name: String(c.name ?? ""), arguments: c.arguments });
		else if (c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string")
			items.push({ type: "image", data: c.data, mimeType: c.mimeType });
	}
	out.content = items;
	if (m.role === "user") out.role = "user";
	else if (m.role === "assistant") {
		out.role = "assistant";
		out.stopReason = m.stopReason;
		out.errorMessage = m.errorMessage ?? undefined;
		out.usage = toTrajTokens(m.usage);
		if (m.usage?.cost?.total != null) out.usage = { ...out.usage, cost: { total: m.usage.cost.total } };
		out.model = typeof m.model === "string" ? m.model : undefined;
		out.provider = typeof m.provider === "string" ? m.provider : undefined;
	} else if (m.role === "toolResult") {
		out.role = "toolResult";
		const result = sanitizeToolOutput(textOf(m.content));
		out.content = [{
			type: "toolResult",
			toolCallId: m.toolCallId,
			text: result.text,
			isError: m.isError === true,
			encodingLoss: result.encodingLoss || undefined,
			patch: patchOf(m.details),
		}];
	} else if (m.role === "compactionSummary" || m.role === "branchSummary") {
		out.role = "summary";
		out.summaryKind = m.role === "branchSummary" ? "branch" : "compaction";
		out.summary = typeof m.summary === "string" ? m.summary : "";
		if (typeof m.tokensBefore === "number" && Number.isFinite(m.tokensBefore)) out.tokensBefore = m.tokensBefore;
	}
	return out;
}

/** 会话条目 → 显示消息：消息照常投影，压缩 / 分支摘要投影成摘要卡，其余条目（切模型、自定义状态等）不显示 */
function entryToWebMessage(entry: any): WebMessage | null {
	if (entry?.type === "message" && entry.message) return toWebMessage(entry.message, entry.id);
	if (entry?.type !== "compaction" && !(entry?.type === "branch_summary" && entry.summary)) return null;
	const timestamp = Date.parse(entry.timestamp);
	return toWebMessage({
		role: entry.type === "compaction" ? "compactionSummary" : "branchSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
	}, entry.id);
}

/**
 * 被压缩掉的历史：当前分支上已不在模型上下文里的条目，按原顺序照常显示（可编辑、可分叉）。
 * 每张压缩卡挪到它保留的第一条（firstKeptEntryId）前面，和上下文部分「摘要在前、保留消息在后」一致；
 * 这样卡片以上就是模型只看得到摘要的内容。
 */
function compactedHistory(sm: Pick<SessionManager, "getBranch">, context: any[]): WebMessage[] {
	if (context[0]?.type !== "compaction") return [];
	const inContext = new Set(context.map((entry) => entry.id));
	const entries = (sm.getBranch() as any[]).filter((entry) => !inContext.has(entry.id));
	const position = new Map(entries.map((entry, index) => [entry.id, index]));
	const markersBefore = new Map<string, WebMessage[]>();
	const moved = new Set<string>();
	entries.forEach((entry, index) => {
		if (entry.type !== "compaction") return;
		const at = position.get(entry.firstKeptEntryId);
		if (at === undefined || at >= index) return;
		const marker = entryToWebMessage(entry)!;
		markersBefore.set(entry.firstKeptEntryId, [...(markersBefore.get(entry.firstKeptEntryId) ?? []), marker]);
		moved.add(entry.id);
	});
	const out: WebMessage[] = [];
	for (const entry of entries) {
		out.push(...(markersBefore.get(entry.id) ?? []));
		if (moved.has(entry.id)) continue;
		const message = entryToWebMessage(entry);
		if (message) out.push(message);
	}
	return out;
}

/** 冷会话 / 只读接口的消息列表：被压缩掉的历史 + 当前上下文（最新一次压缩投影成分隔卡） */
export function sessionDisplayMessages(sm: Pick<SessionManager, "getBranch" | "buildContextEntries">): WebMessage[] {
	const context = sm.buildContextEntries() as any[];
	const current = context.flatMap((entry, index) => {
		// 保留区里更早的压缩条目不进模型上下文（SDK 投影只取下标 0 的那次），这里同样跳过
		if (entry.type === "compaction" && index > 0) return [];
		const message = entryToWebMessage(entry);
		return message ? [message] : [];
	});
	return [...compactedHistory(sm, context), ...current];
}

/**
 * 压缩刚完成（SDK 先写条目再发 compaction_end）：分隔卡 + 它该插在哪条消息前。
 * 取保留下来的第一条用户 / 助手消息，和快照里「卡片在保留消息之前」的位置一致；没有保留消息就追加。
 */
function compactionMarker(m: Managed): { marker?: WebMessage; beforeId?: string; beforeStreamId?: string } {
	try {
		const context = m.sm.buildContextEntries() as any[];
		if (context[0]?.type !== "compaction") return {};
		const kept = context.find((entry) => entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"));
		return {
			marker: entryToWebMessage(context[0]) ?? undefined,
			beforeId: kept?.id,
			beforeStreamId: kept ? m.messageIds?.get(kept.message) : undefined,
		};
	} catch {
		return {};
	}
}

/** 热会话里摘要消息（SDK 每次投影新建的对象）对应的条目 ID：压缩取上下文首条，分支摘要按 fromId + 时间匹配 */
function summaryEntryId(context: any[], message: any): string | undefined {
	if (message?.role === "compactionSummary") return context[0]?.type === "compaction" ? context[0].id : undefined;
	return context.find((entry) => entry.type === "branch_summary" && entry.fromId === message?.fromId && Date.parse(entry.timestamp) === message?.timestamp)?.id;
}

/** 消息对象 → 持久化条目 ID 的索引；条目数一变就重建（会话只追加，改写分支时条目数也会变） */
const entryIdIndexes = new WeakMap<SessionManager, { count: number; ids: WeakMap<object, string> }>();

function entryIdForMessage(sm: SessionManager, message: any): string | undefined {
	// SDK 持久化保存同一对象引用。role+timestamp 并不唯一（同毫秒的 queued user/assistant）。
	// 不能每条消息都扫一遍：getEntries() 本身就复制整个会话，快照逐条投影时会退化成 O(n²)。
	if (!message || typeof message !== "object") return undefined;
	const counter = (sm as unknown as { getEntryCount?: () => number }).getEntryCount;
	const entries = counter ? null : (sm.getEntries() as any[]);
	const count = counter ? counter.call(sm) : entries!.length;
	let index = entryIdIndexes.get(sm);
	if (!index || index.count !== count) {
		index = { count, ids: new WeakMap() };
		for (const entry of entries ?? (sm.getEntries() as any[])) {
			if (entry?.type === "message" && entry.message && typeof entry.message === "object") index.ids.set(entry.message, entry.id);
		}
		entryIdIndexes.set(sm, index);
	}
	return index.ids.get(message);
}

function messageStreamId(m: Managed, message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	m.messageIds ??= new WeakMap();
	let id = m.messageIds.get(message);
	if (!id) {
		id = randomUUID();
		m.messageIds.set(message, id);
	}
	return id;
}

function projectMessage(m: Managed, message: unknown): WebMessage {
	return { ...toWebMessage(message, entryIdForMessage(m.sm, message)), streamId: messageStreamId(m, message) };
}

/** SDK 在 await 扩展 message_end 前先把 final 放入 messages；按 start 时的位置关联而非时间戳。 */
function linkInflightFinal(m: Managed, session: AgentSession): boolean {
	if (!m.inflightId || m.inflightIndex === undefined) return false;
	const final = session.messages[m.inflightIndex];
	if (!final || final.role !== "assistant") return false;
	m.messageIds.set(final, m.inflightId);
	return true;
}

/** edit/write 工具在 details.patch 里带 unified patch；限长避免撑爆 SSE 帧 */
function patchOf(details: unknown): string | undefined {
	const patch = (details as { patch?: unknown } | undefined)?.patch;
	return typeof patch === "string" && patch.trim() ? patch.slice(0, 60_000) : undefined;
}

/**
 * write 工具不产 patch（SDK 的 write.js 里没有 patch 字段），覆盖已有文件时前端只能把
 * 全部内容当新增行——删掉的行永远不会标红。这里在工具开始执行（文件还没被写）时读一份
 * 旧内容，结束时用 SDK 的 generateUnifiedPatch 生成和 edit 同格式的 patch，
 * 于是「新增绿 / 删除红」在两条写入路径上一致。新文件没有旧内容，仍按新增行展示。
 */
const WRITE_BASE_MAX_BYTES = 512 * 1024;
const writeBases = new Map<string, string>();

function writeArgsOf(args: unknown): { target: string; content: string | undefined } {
	const a = args as { path?: unknown; file_path?: unknown; content?: unknown } | undefined;
	const target = typeof a?.path === "string" ? a.path : typeof a?.file_path === "string" ? a.file_path : "";
	return { target, content: typeof a?.content === "string" ? a.content : undefined };
}

export function captureWriteBase(cwd: string, sessionPath: string, toolCallId: string, args: unknown): void {
	const { target } = writeArgsOf(args);
	if (!target) return;
	try {
		const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
		const stat = statSync(abs);
		if (!stat.isFile() || stat.size > WRITE_BASE_MAX_BYTES) return;
		const previous = readFileSync(abs, "utf8");
		if (previous.includes("\u0000")) return; // 二进制不做行级 diff
		// 只淘汰最早的一条：整表清空会把其它会话里正在执行的 write 的旧内容一起丢掉
		if (writeBases.size >= 256) writeBases.delete(writeBases.keys().next().value!);
		writeBases.set(`${sessionPath}\u0000${toolCallId}`, previous);
	} catch {
		/* 新文件或读不到：没有旧内容，走全绿兜底 */
	}
}

export function takeWritePatch(cwd: string, sessionPath: string, toolCallId: string, args: unknown): string | undefined {
	const key = `${sessionPath}\u0000${toolCallId}`;
	const previous = writeBases.get(key);
	writeBases.delete(key);
	if (previous === undefined) return undefined;
	const { target, content } = writeArgsOf(args);
	if (content === undefined || content === previous) return undefined;
	try {
		return generateUnifiedPatch(target, previous, content).slice(0, 60_000);
	} catch {
		return undefined;
	}
}

function coercePartial(p: unknown): string | undefined {
	if (p == null) return undefined;
	if (typeof p === "string") return p.slice(-4000);
	if (Array.isArray(p)) return p.map(textOf).join("").slice(-4000) || undefined;
	if (typeof p === "object") {
		const obj = p as any;
		const t = textOf(obj.content);
		if (t) return t.slice(-4000);
		try {
			return JSON.stringify(p).slice(-4000);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

// ---------- 事件翻译与广播 ----------

interface QueuedPublish {
	events: WebEvent[] | null;
}

const publishQueues = new WeakMap<Managed, QueuedPublish[]>();

function flushPublishes(m: Managed): void {
	const queue = publishQueues.get(m);
	if (!queue) return;
	while (queue.length > 0 && queue[0].events !== null) {
		for (const evt of queue.shift()!.events!) publishImmediate(m, evt);
	}
	if (queue.length === 0) publishQueues.delete(m);
}

function publishImmediate(m: Managed, evt: WebEvent): void {
	if (m.disposed) return;
	m.seq += 1;
	const json = JSON.stringify(evt);
	m.buffer.push({ seq: m.seq, json });
	if (m.buffer.length > BUFFER_CAP) m.buffer.shift();
	for (const send of m.subscribers) {
		try {
			send(m.seq, json);
		} catch {
			m.subscribers.delete(send);
		}
	}
}

function publish(m: Managed, evt: WebEvent): void {
	const queue = publishQueues.get(m);
	if (!queue) return publishImmediate(m, evt);
	queue.push({ events: [evt] });
	flushPublishes(m);
}

function deferPublish(m: Managed, events: () => WebEvent[]): void {
	const queue = publishQueues.get(m) ?? [];
	const entry: QueuedPublish = { events: null };
	queue.push(entry);
	publishQueues.set(m, queue);
	queueMicrotask(() => {
		entry.events = events();
		flushPublishes(m);
	});
}

/** 模型/档位变化统一广播：同时带上新模型支持的档位，前端菜单据此刷新 */
function publishModelState(m: Managed, session: AgentSession): void {
	const model: any = session.model;
	publish(m, {
		type: "model",
		provider: model ? String(model.provider ?? "") : undefined,
		model: model ? String(model.id ?? "") : undefined,
		thinkingLevel: String(session.thinkingLevel ?? ""),
		thinkingLevels: session.getAvailableThinkingLevels() as unknown as string[],
		ts: Date.now(),
	});
}

/**
 * 切模型后恢复用户显式选过的级别（按新模型钳制）。
 * 只记进本会话（SDK 会写 thinking_level_change 条目），不写全局默认：
 * ~/.pi/agent/settings.json 与终端 pi 共用，在 PiWeb 里切一下档位不该改掉终端 pi 的默认值。
 */
function reapplyDesiredLevel(m: Managed, session: AgentSession): void {
	if (!m.desiredThinkingLevel) return;
	const target = clampThinkingLevel(session.model as any, m.desiredThinkingLevel as any);
	if (target !== session.thinkingLevel) session.setThinkingLevel(target as never);
}

/**
 * 新会话页选定模型后的思考档位：与界面显示的生效值同一规则（每模型覆盖 → 设置默认 → medium，再按模型能力钳制）。
 * SDK 切换模型时会沿用会话原来的档位，新会话不能沿用：那个档位是 SDK 按它自己的初始模型定的。
 */
function applyNewSessionThinking(m: Managed, session: AgentSession): void {
	const model = session.model;
	if (!model) return;
	const settings = getSettingsManager(m.cwd);
	const level = newSessionThinkingLevel({
		supported: session.getAvailableThinkingLevels() as unknown as string[],
		modelOverride: settings.getModelThinkingLevel(model.provider, model.id),
		defaultLevel: settings.getDefaultThinkingLevel(),
	});
	if (level !== session.thinkingLevel) session.setThinkingLevel(level as never);
}

function publishTraj(m: Managed): void {
	for (const entry of m.ledger.drainDirty()) {
		publish(m, { type: "traj", entry, ts: Date.now() });
	}
}

function timingStats(m: Managed): Pick<WebStats, "llmMs" | "toolMs" | "ttftMs" | "ttftSteps" | "decodeMs" | "decodeTokens" | "llmTimedSteps" | "toolTimedCalls" | "decodeSteps"> {
	let llmMs = 0;
	let toolMs = 0;
	let ttftMs = 0;
	let ttftSteps = 0;
	let decodeMs = 0;
	let decodeTokens = 0;
	let llmTimedSteps = 0;
	let toolTimedCalls = 0;
	let decodeSteps = 0;
	for (const entry of m.ledger.entries) {
		if (entry.kind === "tool") {
			if (entry.timing?.durationMs !== undefined) toolTimedCalls++;
			toolMs += Math.max(0, entry.timing?.durationMs ?? 0);
			continue;
		}
		if (entry.kind !== "message") continue;
		if (entry.timing?.durationMs !== undefined) llmTimedSteps++;
		llmMs += Math.max(0, entry.timing?.durationMs ?? 0);
		if (entry.timing?.ttftMs !== undefined) {
			ttftMs += Math.max(0, entry.timing.ttftMs);
			ttftSteps += 1;
		}
		if ((entry.timing?.decodeMs ?? 0) > 0 && entry.tokens?.output !== undefined) {
			decodeSteps++;
			decodeMs += Math.max(0, entry.timing?.decodeMs ?? 0);
			decodeTokens += Math.max(0, entry.tokens.output);
		}
	}
	return { llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens, llmTimedSteps, toolTimedCalls, decodeSteps };
}

/**
 * 会话级用量缓存。SDK 的 getSessionStats() 每次都全表遍历 getEntries()（浅拷贝整个会话）、
 * getContextUsage() 再 buildSessionProjection()（又一次全表拷贝 + 逐消息估算 token）——
 * 一轮 agent 里 publishUsage 会在每个工具结束/每条消息结束各触发一次，长会话下这是
 * 服务端最大的重复开销。条目数与 leaf 指针没变时结果必然相同，直接复用。
 */
const usageCache = new WeakMap<Managed, { entryCount: number; leafId: string | null; evt: Extract<WebEvent, { type: "usage" }> }>();

function sessionStats(m: Managed): WebStats | null {
	if (!m.session) return null;
	try {
		const stats = m.session.getSessionStats();
		return {
			userMessages: stats.userMessages,
			assistantMessages: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			totalMessages: stats.totalMessages,
			tokens: stats.tokens,
			cost: stats.cost,
			...timingStats(m),
		};
	} catch {
		return null;
	}
}

function coldSessionStats(m: Managed): WebStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolCalls = 0;
	let totalMessages = 0;
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	let cost = 0;
	const addUsage = (usage: any) => {
		if (!usage || typeof usage !== "object") return;
		tokens.input += Number(usage.input ?? 0);
		tokens.output += Number(usage.output ?? 0);
		tokens.cacheRead += Number(usage.cacheRead ?? 0);
		tokens.cacheWrite += Number(usage.cacheWrite ?? 0);
		cost += Number(usage.cost?.total ?? 0);
	};
	for (const entry of m.sm.getEntries() as any[]) {
		if ((entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) addUsage(entry.usage);
		if (entry.type !== "message" || !entry.message) continue;
		totalMessages += 1;
		const message = entry.message;
		if (message.role === "user") userMessages += 1;
		else if (message.role === "assistant") {
			assistantMessages += 1;
			toolCalls += Array.isArray(message.content)
				? message.content.filter((content: any) => content?.type === "toolCall").length
				: 0;
			addUsage(message.usage);
		} else if (message.role === "toolResult") addUsage(message.usage);
	}
	tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
	return { userMessages, assistantMessages, toolCalls, totalMessages, tokens, cost, ...timingStats(m) };
}

function usageEvent(m: Managed): WebEvent | null {
	if (!m.session) return null;
	// 条目数与 leaf 没变（还停在同一轮事件循环的同一状态）→ 复用上次的完整 usage 事件
	try {
		const entryCount = (m.sm as unknown as { getEntryCount?: () => number }).getEntryCount?.() ?? m.sm.getEntries().length;
		const leafId = m.sm.getLeafId();
		const cached = usageCache.get(m);
		if (cached && cached.entryCount === entryCount && cached.leafId === leafId) return { ...cached.evt, ts: Date.now() };
	} catch {
		/* 缓存键拿不到就走原路径 */
	}
	const stats = sessionStats(m);
	// 用量统计是旁路信息：SDK 偶发取不到时不能让调用方失败，
	// 否则一次统计异常就会把「切模型 / 刷新目录」这类命令打回 ok:false。
	let usage: ReturnType<AgentSession["getContextUsage"]> | null = null;
	try {
		usage = m.session.getContextUsage() ?? null;
	} catch {
		usage = null;
	}
	const evt = {
		type: "usage" as const,
		stats,
		contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : null,
		ts: Date.now(),
	};
	try {
		const entryCount = (m.sm as unknown as { getEntryCount?: () => number }).getEntryCount?.() ?? m.sm.getEntries().length;
		usageCache.set(m, { entryCount, leafId: m.sm.getLeafId(), evt });
	} catch {
		/* ignore */
	}
	return evt;
}

/**
 * 忙时节流：一轮 agent 期间 publishUsage 的调用点密（每个工具结束 + 每条消息结束），
 * 而 usage 在条目数没变时本来就不会动。500ms 内的重复请求直接跳过；
 * settle/compaction 等关键节点用 flush 参数强制发一次，收尾数字不缺席。
 */
const USAGE_MIN_INTERVAL_MS = 500;
const usageThrottle = new WeakMap<Managed, number>();

function publishUsage(m: Managed, flush = false): void {
	const now = Date.now();
	if (!flush) {
		const last = usageThrottle.get(m) ?? 0;
		if (now - last < USAGE_MIN_INTERVAL_MS) return;
	}
	usageThrottle.set(m, now);
	const evt = usageEvent(m);
	if (evt) publish(m, evt);
}

function translate(m: Managed, evt: AgentSessionEvent): void {
	m.ledger.onEvent(evt);
	growthOf(m).onEvent(evt);
	const now = Date.now();
	switch (evt.type) {
		case "message_start": {
			const raw = (evt as any).message;
			const msg = projectMessage(m, raw);
			if (msg.role === "assistant") {
				m.inflight = raw;
				m.inflightId = msg.streamId;
				m.inflightIndex = m.session?.messages.length;
				msg.stopReason = "pending";
				// SDK 的 partial 是被就地追加的共享对象，发到这里时首个增量往往已经写进去了；
				// 正文一律由后续 delta 事件补齐，这里清空文本，否则浏览器会把首段拼两遍（"TheThe user…"）
				msg.content = msg.content.map((c) => (c.type === "text" ? { ...c, text: "" } : c.type === "thinking" ? { ...c, thinking: "" } : c));
			}
			if (msg.role === "user" || msg.role === "assistant") {
				publish(m, { type: "message", message: msg, phase: "start", ts: now });
			}
			break;
		}
		case "message_update": {
			const e: any = (evt as any).assistantMessageEvent;
			if ((evt as any).message) {
				m.inflight = (evt as any).message;
				if (m.inflightId) m.messageIds.set((evt as any).message, m.inflightId);
			}
			if (!e) break;
			if (e.type === "text_delta" && typeof e.delta === "string") {
				publish(m, { type: "delta", kind: "text", contentIndex: e.contentIndex, delta: e.delta, messageId: m.inflightId, ts: now });
			} else if (e.type === "thinking_delta" && typeof e.delta === "string") {
				publish(m, { type: "delta", kind: "thinking", contentIndex: e.contentIndex, delta: e.delta, messageId: m.inflightId, ts: now });
			}
			break;
		}
		case "message_end": {
			const raw = (evt as any).message;
			if (raw?.role === "assistant") {
				if (m.inflightId) m.messageIds.set(raw, m.inflightId);
				m.inflight = null;
				m.inflightId = undefined;
				m.inflightIndex = undefined;
			}
			// Pi persists message_end after notifying listeners; wait one microtask so
			// the browser receives the durable entry ID without reordering later tool events.
			deferPublish(m, () => {
				const msg = projectMessage(m, raw);
				if (msg.role === "assistant") {
					msg.endedAt = now;
					// 首次回复结束后 pi 已把系统分段写进会话文件，此时分类能读到投影（比 systemPrompt 差分精确）
					if (!m.breakdownProjected) {
						m.breakdownProjected = true;
						publishContextBreakdown(m);
					}
				}
				const usage = usageEvent(m);
				return usage
					? [{ type: "message", message: msg, phase: "end", ts: now }, usage]
					: [{ type: "message", message: msg, phase: "end", ts: now }];
			});
			break;
		}
		case "tool_execution_start":
			// write 覆盖前先留一份旧内容，结束时才能给出真实的新增/删除 diff
			if (evt.toolName?.toLowerCase() === "write") captureWriteBase(m.cwd, m.sessionPath, evt.toolCallId, evt.args);
			publish(m, {
				type: "tool",
				id: evt.toolCallId,
				name: evt.toolName,
				args: evt.args,
				state: "running",
				ts: now,
			});
			break;
		case "tool_execution_update": {
			const partial = sanitizeToolOutput(coercePartial((evt as any).partialResult) ?? "");
			// 不带 args：start 已经发过，前端沿用上一次的值；write 的 args 含整份文件内容，每次进度都重发很浪费
			publish(m, {
				type: "tool",
				id: evt.toolCallId,
				name: evt.toolName,
				state: "running",
				partialResult: partial.text || undefined,
				encodingLoss: partial.encodingLoss || undefined,
				ts: now,
			});
			break;
		}
		case "tool_execution_end": {
			const result = sanitizeToolOutput(coercePartial((evt as any).result) ?? "");
			publish(m, {
				type: "tool",
				id: evt.toolCallId,
				name: evt.toolName,
				args: (evt as any).args,
				state: "done",
				result: result.text || undefined,
				isError: evt.isError,
				encodingLoss: result.encodingLoss || undefined,
				patch: patchOf((evt as any).result?.details) ?? (evt.toolName?.toLowerCase() === "write" ? takeWritePatch(m.cwd, m.sessionPath, evt.toolCallId, (evt as any).args) : undefined),
				ts: now,
			});
			publishUsage(m);
			break;
		}
		case "agent_start":
			m.runActive = true;
			publish(m, { type: "status", isStreaming: true, state: "running", ts: now });
			break;
		case "agent_end":
			// SDK 的 post-run retry/compaction/queued continuation 尚未结束。
			publishUsage(m);
			break;
		case "agent_settled":
			m.runActive = false;
			publish(m, { type: "status", isStreaming: false, state: "idle", ts: now });
			publishUsage(m, true);
			if (m.resourceReloadPending) queueMicrotask(() => void reloadManagedResources(m));
			break;
		case "queue_update":
			publish(m, {
				type: "queue",
				steering: [...(evt as any).steering],
				followUp: [...(evt as any).followUp],
				ts: now,
			});
			break;
		case "compaction_start":
			publish(m, { type: "status", isStreaming: true, state: "compacting", ts: now });
			publish(m, { type: "compaction", phase: "start", reason: (evt as any).reason, ts: now });
			break;
		case "compaction_end":
			publish(m, {
				type: "compaction",
				phase: "end",
				reason: (evt as any).reason,
				errorMessage: (evt as any).errorMessage,
				...((evt as any).result && !(evt as any).errorMessage ? compactionMarker(m) : {}),
				ts: now,
			});
			publishUsage(m, true);
			publishContextBreakdown(m);
			if ((evt as any).reason === "manual") {
				publish(m, { type: "status", isStreaming: isManagedBusy(m), state: isManagedBusy(m) ? "running" : "idle", ts: now });
				if (m.resourceReloadPending) queueMicrotask(() => void reloadManagedResources(m));
			}
			break;
		case "session_info_changed":
			publish(m, { type: "name", name: (evt as any).name ?? "", ts: now });
			break;
		case "thinking_level_changed":
			if (m.session) publishModelState(m, m.session);
			else publish(m, { type: "model", thinkingLevel: (evt as any).level, ts: now });
			break;
		case "auto_retry_start":
			// 重试是流程内通知:发一条结构化 retry 事件(界面聚合成「重试 n/max」一行),
			// 不再走 error 通道,免得每次尝试都多出一条报错。
			publish(m, {
				type: "retry",
				attempt: Number((evt as any).attempt) || 0,
				maxAttempts: Number((evt as any).maxAttempts) || 0,
				message: String((evt as any).errorMessage ?? ""),
				ts: now,
			});
			break;
		case "auto_retry_end":
			// 重试收尾:SDK 成功/最终失败/被中止都会发这条,而重试成功后的这轮对话
			// agent_settled 之前界面上还留着「重试 1/5 terminated」那一行(用户看到的
			// 就是「已经恢复了还显示错误」)。这里显式发一条清除事件,重试区间一结束
			// 就收掉这行;真失败时紧随其后的 assistant error 消息会照常出错误块。
			publish(m, { type: "retry_end", attempt: Number((evt as any).attempt) || 0, ts: now });
			break;
		default:
			break;
	}
	publishTraj(m);
}

// ---------- 项目生长 ----------

function growthOf(m: Managed): GrowthTracker {
	if (m.growth && m.growth.version !== GROWTH_TRACKER_VERSION) {
		m.growth.dispose();
		m.growth = null;
	}
	return (m.growth ??= createGrowthTracker({
		cwd: m.cwd,
		sessionPath: m.sessionPath,
		publish: (evt) => publish(m, evt),
		entries: () => m.sm.getEntries() as never,
		consent: () => getGrowthInitConsent(m.cwd).catch(() => null),
	}));
}

/** 立即记录（项目栏按钮）：把当前改动提交为「你的修改」，同时广播给本会话的订阅者 */
export async function growthRecord(m: Managed): Promise<GrowthRound | null> {
	touch(m);
	return growthOf(m).recordNow();
}

/**
 * 用户回答了「要不要在这个工作区建 git 仓库」：决定按工作区记住，同一工作区的其他会话一并收起弹窗；
 * 同意时由发起的会话立即拍基线（返回这一笔）。
 */
export async function growthConsent(m: Managed, allow: boolean): Promise<GrowthRound | null> {
	touch(m);
	await setGrowthInitConsent(m.cwd, allow);
	const same = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
	for (const other of sessions.values()) {
		if (other !== m && other.growth?.getConsentRequest() && same(other.cwd) === same(m.cwd)) void other.growth.consentAnswered(allow).catch(() => undefined);
	}
	return growthOf(m).consentAnswered(allow);
}

// ---------- 会话生命周期 ----------

function touch(m: Managed): void {
	m.lastActive = Date.now();
}

const warmedResourceCwds = new Set<string>();

/**
 * 打开会话的首个快照要等资源发现（扩展 / 技能 / AGENTS.md / prompt 模板）跑完，本机实测约
 * 140ms；侧栏一拿到会话列表就把最可能被点开的那个工作区先发现掉，用户点开时直接命中缓存。
 * 每个 cwd 只做一次，最多两个（别把一堆工作区的扩展全加载起来），失败静默。
 */
export function warmSessionResources(cwds: string[]): void {
	for (const cwd of cwds) {
		if (!cwd || warmedResourceCwds.size >= 2) return;
		const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
		if (warmedResourceCwds.has(key)) continue;
		warmedResourceCwds.add(key);
		if (peekResourceLoader(cwd)) continue;
		void resourceLoaderReady(cwd).catch(() => undefined);
	}
}

export function getManaged(sessionPath: string): Managed {
	let m = sessions.get(sessionPath);
	if (m) m = syncWithDisk(m);
	else {
		if (!existsSync(sessionPath)) throw new BoundaryError("session not found");
		const sm = openSessionManager(sessionPath);
		m = registerManaged(sessionPath, sm.getCwd() || process.cwd(), sm);
	}
	touch(m);
	return m;
}

/**
 * 数出 JSONL 里自上次核对以来、不是本进程写的新条目。
 * 自己的条目在 SessionManager._appendEntry 里先进内存索引再落盘，所以索引里找不到 id 的行就是外来的
 * （终端 pi 同时打开了这个会话）。只读新增的字节；文件变短（被整体重写）就从头核对；没写完的最后一行留到下次。
 */
function externalEntryCount(m: Managed): number {
	let size: number;
	try {
		size = statSync(m.sessionPath).size;
	} catch {
		return 0; // 还没落盘
	}
	if (size === m.diskSize) return 0;
	const from = size < m.diskSize ? 0 : m.diskSize;
	let buf = Buffer.alloc(size - from);
	let fd: number | undefined;
	try {
		fd = openSync(m.sessionPath, "r");
		buf = buf.subarray(0, readSync(fd, buf, 0, buf.length, from));
	} catch {
		return 0;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	const end = buf.lastIndexOf(0x0a);
	m.diskSize = from + end + 1;
	let count = 0;
	for (const line of buf.subarray(0, Math.max(0, end)).toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type !== "session" && typeof entry?.id === "string" && !m.sm.getEntry(entry.id)) count += 1;
		} catch {
			/* 从行中间读起的半行、写坏的行都不算 */
		}
	}
	return count;
}

/**
 * pi 终端和 PiWeb 共用同一份 JSONL，但各自在内存里记着会话树：一边写了，另一边不知道，
 * 接着写就从自己的旧叶子分叉。打开会话、发消息都经过 getManaged，这里先核对磁盘：
 * 有外来条目且本会话空闲，就丢掉内存里的旧副本从磁盘重开；正在跑就只提醒，空闲后的下一次核对再重载。
 */
function syncWithDisk(m: Managed): Managed {
	const found = externalEntryCount(m);
	if (!found && !m.externalEntries) return m;
	m.externalEntries += found;
	if (m.creating || isManagedBusy(m)) {
		if (found) publish(m, { type: "external_write", entries: m.externalEntries, ts: Date.now() });
		return m;
	}
	return reopenManaged(m);
}

/** 等同空闲回收后再打开：会话级的选择（工具档位、思考级别）带过去，正在看的浏览器立刻重连拿新快照 */
function reopenManaged(m: Managed): Managed {
	let sm: SessionManager;
	try {
		sm = openSessionManager(m.sessionPath);
	} catch {
		return m; // 读不出来（正被写坏？）就先沿用旧副本，下次再试
	}
	const at = Date.now();
	const reload = { entries: m.externalEntries, at };
	// 直接写给订阅者：publish 可能排在队列里，晚于 dispose 就送不到了
	const frame = JSON.stringify({ type: "external_reload", ...reload, ts: at });
	for (const send of m.subscribers) {
		try {
			send(m.seq, frame);
		} catch {
			/* ignore */
		}
	}
	disposeSession(m);
	const fresh = registerManaged(m.sessionPath, sm.getCwd() || m.cwd, sm);
	// 核对位置沿用旧的（整行末尾）：打开时恰好没写完的那行，写完后还会被认作外来的
	fresh.diskSize = m.diskSize;
	fresh.toolPreset = m.toolPreset;
	fresh.customActiveTools = m.customActiveTools;
	fresh.desiredThinkingLevel = m.desiredThinkingLevel;
	fresh.viewerGraceUntil = m.viewerGraceUntil;
	fresh.externalReload = reload;
	return fresh;
}

/**
 * 侧栏每 3 秒拉一次会话列表，顺带核对所有开着的会话：终端写入几秒内就能提示 / 重载，
 * 回合中途发现的外来写入也在回合结束后的下一次拉取时重载（不在 agent_settled 里做：
 * SDK 收尾时还可能有延后的提问要开跑，那一刻回收会把它丢掉）。每个会话一次 stat，没变就不读文件。
 */
export function syncSessionsFromDisk(): void {
	for (const m of [...sessions.values()]) {
		try {
			syncWithDisk(m);
		} catch {
			/* 核对失败只是晚一点发现，打开 / 发送时还会再查 */
		}
	}
}

function fileSize(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

function registerManaged(sessionPath: string, cwd: string, sm: SessionManager): Managed {
	let initialTrajectory: TrajEntry[] = [];
	try {
		initialTrajectory = buildTrajectoryFromEntries(sm.getEntries() as unknown as any[]);
	} catch {
		/* A damaged history can still be opened; live events start a fresh ledger. */
	}
	const m: Managed = {
		sessionPath,
		cwd,
		sm,
		session: null,
		creating: null,
		subscribers: new Set(),
		buffer: [],
		seq: 0,
		epoch: randomUUID().replace(/-/g, "").slice(0, 12),
		inflight: null,
		ui: null,
		growth: null,
		ledger: new TrajLedger(initialTrajectory),
		lastActive: Date.now(),
		toolPreset: "readonly",
		requestedTools: new Set(),
		resourceVersion: 0,
		resourceReloadPending: false,
		resourceReloading: false,
		promptSubmitting: false,
		runActive: false,
		disposed: false,
		messageIds: new WeakMap(),
		diskSize: fileSize(sessionPath),
		externalEntries: 0,
	};
	sessions.set(sessionPath, m);
	return m;
}

function loadContextResources(cwd: string, loader: AgentSession["resourceLoader"] = getResourceLoader(cwd)): ContextResource[] {
	const files = loader.getAgentsFiles().agentsFiles.map((file) => ({
		path: file.path,
		content: file.content,
		source: "project" as const,
	}));
	const append = loader.getAppendSystemPrompt();
	const sources = loader.getAppendSystemPromptSources();
	return [
		...files,
		...append.map((content, index) => ({
			path: sources[index]?.path ?? `Appended system prompt ${index + 1}`,
			content,
			source: "extension" as const,
		})),
	];
}

const SKILLS_SECTION_START = "The following skills provide specialized instructions";
const SKILLS_SECTION_END = "</available_skills>";

/**
 * 当前上下文的字符分类，优先读 SDK 投影中的系统分段、工具 schema 与摘要。
 * 旧客户端仍可读取字符/4 的估算字段；新客户端仅将字符数作为分类数据。
 * 没有持久化系统消息且尚未启动的会话，资源来自发现缓存并标记 cold。
 */
async function buildContextBreakdown(m: Managed, resources: ContextResource[]): Promise<ContextBreakdown> {
	const session = m.session;
	const breakdown: ContextBreakdown = {
		systemPrompt: 0, systemTools: 0, customTools: 0, memory: 0, skills: 0, compacted: 0, autoCompactBuffer: 0,
		...(session ? {} : { cold: true }),
	};
	// Memory：AGENTS.md 等注入文件（contextResources 的 project 部分）
	const memoryText = resources.filter((r) => r.source === "project").map((r) => r.content).join("\n\n");
	// 字符分项只读取当前投影中的内容。历史压缩摘要、未激活工具不混入当前统计。
	const characters = { systemPrompt: 0, systemTools: 0, customTools: 0, memory: 0, skills: 0, compacted: 0 };
	try {
		const messages = m.sm.buildSessionProjection().messages as any[];
		const system = messages.findLast((message) => message.role === "system");
		if (system) {
			const contentChars = typeof system.content === "string" ? system.content.length : textOf(system.content).length;
			characters.memory = system.sections?.project_context?.length ?? 0;
			characters.skills = system.sections?.skills?.length ?? 0;
			characters.systemPrompt = contentChars + Object.entries(system.sections ?? {})
				.filter(([key]) => key !== "project_context" && key !== "skills")
				.reduce((sum, [, value]) => sum + (typeof value === "string" ? value.length : 0), 0);
			const builtinNames = new Set(session
				? session.getAllTools().filter((tool: any) => tool.sourceInfo?.source === "builtin").map((tool) => tool.name)
				: ["read", "bash", "edit", "write", "grep", "find", "ls"]);
			for (const tool of system.toolsAdded ?? []) {
				characters[builtinNames.has(tool.name) ? "systemTools" : "customTools"] += JSON.stringify(tool).length;
			}
			delete breakdown.cold;
		} else if (session) {
			const prompt = session.systemPrompt ?? "";
			characters.memory = memoryText.length;
			const start = prompt.indexOf(SKILLS_SECTION_START);
			const end = prompt.indexOf(SKILLS_SECTION_END);
			characters.skills = start >= 0 && end > start ? prompt.slice(start, end + SKILLS_SECTION_END.length).length : 0;
			characters.systemPrompt = Math.max(0, prompt.length - characters.memory - characters.skills);
			const active = new Set(session.getActiveToolNames());
			for (const tool of session.getAllTools().filter((tool) => active.has(tool.name))) {
				const size = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
				characters[(tool as any).sourceInfo?.source === "builtin" ? "systemTools" : "customTools"] += size;
			}
		} else {
			// 初次启动前只能读到待注入的资源，界面保留 cold 提示。
			characters.memory = memoryText.length;
			const loader = peekResourceLoader(m.cwd) ?? getResourceLoader(m.cwd);
			characters.skills = formatSkillsForPrompt(loader.getSkills().skills).trim().length;
		}
		for (const message of messages) {
			if (message.role === "compactionSummary" || message.role === "branchSummary") characters.compacted += message.summary?.length ?? 0;
		}
		breakdown.characters = characters;
		// 保留旧客户端的估算字段，当前客户端直接展示实际字符数。
		for (const key of Object.keys(characters) as Array<keyof typeof characters>) breakdown[key] = Math.ceil(characters[key] / 4);
	} catch {
		/* 投影不可用时不给字符分项，不能从旧 token 估算反推字符数。 */
	}
	// auto-compact 预留读本工作区、当前模型实际使用的设置。
	try {
		const compaction = getSettingsManager(m.cwd).getCompactionSettings(session?.model);
		if (compaction.enabled) breakdown.autoCompactBuffer = compaction.reserveTokens;
	} catch {
		/* 设置读取失败则保持 0 */
	}
	return breakdown;
}

/**
 * 分项变了就推一次（会话启动、工具 / 资源重载、压缩之后）。分项以前只随快照下发：
 * 打开冷会话时是 0，之后会话启动了弹窗也一直停在那份 0 上，直到刷新页面。
 * 同一轮里多次触发（启动时 publishTools + publishResources）合并成一次。
 */
function publishContextBreakdown(m: Managed): void {
	if (m.breakdownQueued || m.disposed) return;
	m.breakdownQueued = true;
	queueMicrotask(() => {
		m.breakdownQueued = false;
		if (m.disposed) return;
		let resources: ContextResource[] = [];
		try {
			resources = loadContextResources(m.cwd, m.session?.resourceLoader);
		} catch {
			/* 读不到注入文件就按空算 Memory */
		}
		void buildContextBreakdown(m, resources).then((breakdown) => {
			if (!m.disposed) publish(m, { type: "context_breakdown", breakdown, ts: Date.now() });
		}, () => undefined);
	});
}

/** 资源加载器注入文件的展示上限：同一份全文已经随快照的 contextResources 下发过一次，
 *  轨迹条目的 detail 只留头部供列表预览与搜索——两处不再各带一份全文 */
const TRAJ_CONTEXT_DETAIL_MAX_CHARS = 4_000;

/** resources 已经算过（快照）就传进来，免得资源发现结果再读一遍 */
function environmentTrajectory(m: Managed, session: AgentSession | null, known?: ContextResource[]): TrajEntry[] {
	const ts = m.ledger.entries[0]?.ts ?? Date.now();
	const entries: TrajEntry[] = [];
	if (session?.systemPrompt) {
		entries.push({
			seq: -1,
			kind: "system",
			ts,
			title: "Initial System Prompt",
			detail: session.systemPrompt,
		});
	}

	try {
		const resources = known ?? loadContextResources(m.cwd, m.session?.resourceLoader);
		resources.forEach((resource, index) => entries.push({
			seq: -2 - index,
			kind: "context",
			ts,
			title: resource.path,
			// 全文在快照 contextResources 里；这里只留头部，快照不再双份序列化
			detail: resource.content.length > TRAJ_CONTEXT_DETAIL_MAX_CHARS
				? `${resource.content.slice(0, TRAJ_CONTEXT_DETAIL_MAX_CHARS)}…`
				: resource.content,
		}));
	} catch {
		/* Resource discovery diagnostics are already surfaced by Pi. */
	}
	return entries;
}

function publishEnvironmentTrajectory(m: Managed, session: AgentSession): void {
	for (const entry of environmentTrajectory(m, session)) {
		publish(m, { type: "traj", entry, ts: Date.now() });
	}
}

export async function ensureSession(m: Managed): Promise<AgentSession> {
	if (m.disposed) throw new Error("session is disposed");
	if (m.creating) return m.creating;
	if (m.session) return m.session;
	m.creating = (async () => {
		await resourceLoaderReady(m.cwd);
		const settingsManager = getSettingsManager(m.cwd);
		const loader = await createSessionResourceLoader(m.cwd);
		let created: AgentSession | undefined;
		try {
			if (m.disposed) throw new Error("session is disposed");
			const { session } = await createAgentSession({
				cwd: m.cwd,
				agentDir: getAgentDir(),
				sessionManager: m.sm,
				modelRuntime: await getModelRuntime(),
				resourceLoader: loader,
				settingsManager,
				// 内置的选择窗口：问题经扩展界面桥推给浏览器（m.ui 在下面 bindExtensions 前建好，调用时再取）
				customTools: [createAskUserTool((questions, signal) => (m.ui ? m.ui.askQuestions(questions, signal) : Promise.resolve({ status: "unavailable" })))],
			});
			created = session;
			if (m.disposed) throw new Error("session is disposed");
			m.session = session;
			// SDK 按 defaultTools 设置算出的初始激活集（含 "+codemode" 这类显式开启）
			m.requestedTools = new Set(session.getActiveToolNames());
			installSessionPolicy(m, session);
			applyToolPolicy(m, session);
			session.subscribe((evt) => { if (!m.disposed) translate(m, evt); });
			const ui = createExtensionUiBridge({ publish: (evt) => publish(m, evt), hasViewers: () => !m.disposed && hasViewers(m) });
			m.ui = ui;
			await session.bindExtensions({
				mode: "rpc",
				uiContext: ui.uiContext as never,
				onError: (error) => {
					publish(m, { type: "error", message: `扩展 ${error.extensionPath.split(/[\\/]/).pop()} 在 ${error.event} 出错：${error.error}`, ts: Date.now() });
				},
				abortHandler: () => void session.abort().catch(() => undefined),
			});
			if (m.disposed) throw new Error("session is disposed");
			applyToolPolicy(m, session);
			m.resourceVersion = resourceLoaderVersion(m.cwd);
			publishEnvironmentTrajectory(m, session);
			publishTools(m, session);
			publishResources(m);
			publishUsage(m);
			return session;
		} catch (error) {
			m.ui?.dispose();
			m.ui = null;
			// session_start 可能已经跑过（MCP 在连服务器）：先发 session_shutdown 收尾，再废掉扩展 runtime
			const runtime = loader.getExtensions().runtime;
			if (created) void shutdownSession(created).finally(() => runtime.invalidate());
			else runtime.invalidate();
			m.session = null;
			throw error;
		}
	})().catch((err) => {
		if (!m.disposed) publish(m, { type: "error", message: String(err?.message ?? err), ts: Date.now() });
		throw err;
	}).finally(() => { m.creating = null; });
	return m.creating;
}

function isManagedBusy(m: Managed): boolean {
	return m.promptSubmitting || m.resourceReloading || m.runActive || !!(m.session && !m.session.isIdle);
}

function allowedToolNames(m: Managed, session: AgentSession): string[] {
	const custom = m.customActiveTools;
	return listAllToolNames(session).filter((name) => (custom ? custom.includes(name) : presetAllowsTool(m.toolPreset, name)));
}

/** SDK 注册即激活的规则：direct / model-only 曝光、且没有写 defaultActive: false */
function activatedOnRegistration(session: AgentSession): Set<string> {
	return new Set(session.getAllTools()
		.filter((tool) => (tool.exposure === "direct" || tool.exposure === "model-only") && session.getToolDefinition(tool.name)?.defaultActive !== false)
		.map((tool) => tool.name));
}

/**
 * 档位只是上限，开哪些仍按 SDK 的规则：注册即激活的，加上 SDK / 扩展明确要求打开的（requestedTools）。
 * codemode、tool_search 是 defaultActive: false，延迟加载的 MCP 工具不直接声明——把放行的全打开，
 * 每次请求要多带几千 token，延迟加载也白做。逐项选择（customActiveTools）是用户点名要的，照单全开。
 */
function policyToolNames(m: Managed, session: AgentSession): string[] {
	const allowed = allowedToolNames(m, session);
	if (m.customActiveTools) return allowed;
	const auto = activatedOnRegistration(session);
	return allowed.filter((name) => auto.has(name) || m.requestedTools.has(name));
}

/** installSessionPolicy 包装前的原始 setActiveToolsByName：PiWeb 自己落策略时不能被记成"扩展要求" */
const rawSetActiveTools = new WeakMap<AgentSession, (names: string[]) => void>();

function applyToolPolicy(m: Managed, session: AgentSession): void {
	const names = policyToolNames(m, session);
	(rawSetActiveTools.get(session) ?? session.setActiveToolsByName.bind(session))(names);
}

/**
 * SDK 的 session.dispose() 不发 session_shutdown（只有 AgentSessionRuntime 发）：不补发，扩展收不到收尾信号，
 * 内置 MCP 拉起的 stdio 服务器进程会一直挂着。先同步停掉 agent，收尾最多等 5 秒，再 dispose。
 */
const shuttingDown = new WeakMap<AgentSession, Promise<void>>();

function shutdownSession(session: AgentSession): Promise<void> {
	// 创建中途被回收时，disposeSession 与 ensureSession 的 catch 会各收尾一次
	const existing = shuttingDown.get(session);
	if (existing) return existing;
	try {
		session.agent.abort();
	} catch {
		/* ignore */
	}
	let shutdown: Promise<unknown> = Promise.resolve();
	try {
		const runner = session.extensionRunner;
		if (runner.hasHandlers("session_shutdown")) shutdown = runner.emit({ type: "session_shutdown", reason: "quit" });
	} catch {
		/* 扩展 runtime 已失效：没有可收尾的了 */
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
		timer.unref?.();
	});
	const done = Promise.race([shutdown.then(() => undefined, () => undefined), timeout]).finally(() => {
		clearTimeout(timer);
		try {
			session.dispose();
		} catch {
			/* ignore */
		}
	});
	shuttingDown.set(session, done);
	return done;
}

function publishTools(m: Managed, session: AgentSession): void {
	publish(m, { type: "tools", active: listActiveTools(session), all: listAllToolNames(session), toolPreset: m.toolPreset, customActiveTools: m.customActiveTools ?? null, ts: Date.now() });
	publishContextBreakdown(m);
}

/** SDK reload 自动启用扩展工具，注册新工具也会刷新全集；统一在激活边界收敛到服务端选择。 */
function installSessionPolicy(m: Managed, session: AgentSession): void {
	const setActive = session.setActiveToolsByName.bind(session);
	rawSetActiveTools.set(session, setActive);
	session.setActiveToolsByName = (names) => {
		const wanted = [...new Set(names)];
		// 扩展传的是完整列表（多半是 getActiveTools() 加减几项）：原本激活、这次没列的算关掉，其余都算要求打开
		for (const name of listActiveTools(session)) if (!wanted.includes(name)) m.requestedTools.delete(name);
		for (const name of wanted) m.requestedTools.add(name);
		const allowed = allowedToolNames(m, session);
		setActive(wanted.filter((name) => allowed.includes(name)));
	};
	const reload = session.reload.bind(session);
	session.reload = async (options) => {
		if (m.disposed) throw new Error("session is disposed");
		if (isManagedBusy(m)) throw new Error("session is busy");
		m.resourceReloading = true;
		try {
			await withResourceLock(async () => {
				if (m.disposed || m.runActive || !session.isIdle) throw new Error("session is busy");
				await reload({ beforeSessionStart: async () => {
					// reload 绕过包装直接按 defaultTools 重算了激活集（新加进 defaultTools 的工具会被打开）
					for (const name of listActiveTools(session)) m.requestedTools.add(name);
					applyToolPolicy(m, session);
					await options?.beforeSessionStart?.();
					applyToolPolicy(m, session);
				} });
			});
			m.resourceVersion = resourceLoaderVersion(m.cwd);
		} finally {
			applyToolPolicy(m, session);
			m.resourceReloading = false;
			if (!m.disposed) {
				publishTools(m, session);
				publishEnvironmentTrajectory(m, session);
				publishResources(m);
			}
		}
	};
}

function listAllToolNames(session: AgentSession): string[] {
	const all = (session as unknown as { getAllTools?: () => Array<{ name: string }> }).getAllTools?.();
	return all ? all.map((t) => t.name) : [];
}

function listActiveTools(session: AgentSession): string[] {
	// SDK 的真名是 getActiveToolNames（getActiveTools 不存在）
	const active = (session as unknown as { getActiveToolNames?: () => string[] }).getActiveToolNames?.();
	return active ?? [];
}

export function disposeSession(m: Managed): void {
	if (m.disposed) return;
	m.disposed = true;
	m.ui?.dispose();
	m.ui = null;
	m.growth?.dispose();
	m.growth = null;
	if (m.session) void shutdownSession(m.session);
	// 正在创建中的会话：创建完成后立即销毁，否则它会挂在已被移出池的
	// Managed 上，订阅与句柄永久泄漏（同一 JSONL 还会出现双活跃会话）。
	if (m.creating) {
		void m.creating
			.then((session) => (session ? shutdownSession(session) : undefined))
			.catch(() => undefined);
	}
	for (const send of m.subscribers) {
		try {
			send(m.seq, JSON.stringify({ type: "status", isStreaming: false, state: "disposed", ts: Date.now() }));
		} catch {
			/* ignore */
		}
	}
	m.subscribers.clear();
	sessions.delete(m.sessionPath);
}

/**
 * 让某个会话立刻收工：中断正在跑的回合并回收 agent。
 * 归档用它——归档后会话从工作区消失，若它的回合还在后台跑，用户看不见却仍在消耗 token。
 * 只影响这一个会话，其它会话的运行不受影响（LRU/空闲回收同样跳过 busy 的会话）。
 */
export async function disposeSessionPath(sessionPath: string): Promise<void> {
	const m = sessions.get(sessionPath);
	if (!m) return;
	const session = m.session ?? (m.creating ? await m.creating.catch(() => null) : null);
	if (session?.isStreaming) await session.abort().catch(() => undefined);
	disposeSession(m);
}

/** 空闲回收 + 活跃数上限（LRU） */
export function reap(): void {
	const now = Date.now();
	for (const m of [...sessions.values()]) {
		if (hasViewers(m) || now - m.lastActive <= IDLE_MS) continue;
		if (!m.creating && !isManagedBusy(m)) disposeSession(m);
	}
	const active = [...sessions.values()].filter((m) => m.session);
	if (active.length > MAX_ACTIVE) {
		const evictable = active
			.filter((m) => !m.creating && !isManagedBusy(m) && !hasViewers(m))
			.sort((a, b) => a.lastActive - b.lastActive);
		for (const m of evictable.slice(0, active.length - MAX_ACTIVE)) disposeSession(m);
	}
}

// 定时器挂 globalThis：开发热重载会重新求值本模块，不清掉旧的就会一份份叠加
{
	const store = globalThis as typeof globalThis & { __piWebReaper?: ReturnType<typeof setInterval> };
	if (store.__piWebReaper) clearInterval(store.__piWebReaper);
	store.__piWebReaper = setInterval(reap, 60_000);
	store.__piWebReaper.unref?.();
}

/** 归档会话的保留期清理：只删「已归档且长期无活动」的会话；正在使用的会话一律跳过 */
function isSessionInUse(sessionPath: string): boolean {
	const key = process.platform === "win32" ? sessionPath.toLowerCase() : sessionPath;
	for (const managed of sessions.keys()) {
		if ((process.platform === "win32" ? managed.toLowerCase() : managed) === key) return true;
	}
	return false;
}

startArchivedSessionRetention({ isActive: isSessionInUse, log: (message) => console.log(message) });

// ---------- 资源清单（技能 / 提示模板 / 扩展命令 / 信任 / 诊断） ----------

type ResourceBundle = Pick<WebSnapshot, "skills" | "promptTemplates" | "extensionCommands" | "projectTrust" | "resourceDiagnostics">;

/**
 * 会话还不存在时也能发现命令：不绑定运行时、不发 session_start、不启动 MCP。
 * 新会话页和冷会话的斜杠补全都靠它，等第一次提问才建会话。
 */
export async function loadWorkspaceResources(cwd: string): Promise<ResourceBundle> {
	await refreshResourceLoaderIfStale(cwd);
	const modelRegistry = new ModelRegistry(await getModelRuntime());
	return withResourceLock(async () => {
		const loader = getResourceLoader(cwd);
		const { extensions, runtime } = loader.getExtensions();
		const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), modelRegistry);
		return collectResources({ cwd, session: null }, runner);
	});
}

function collectResources(m: Pick<Managed, "cwd" | "session">, commandRunner?: ExtensionRunner): ResourceBundle {
	const loader = m.session?.resourceLoader ?? peekResourceLoader(m.cwd) ?? getResourceLoader(m.cwd);
	const diagnostics: WebSnapshot["resourceDiagnostics"] = [];
	let skills: WebSnapshot["skills"] = [];
	try {
		const r = loader.getSkills();
		skills = r.skills.map((sk) => ({ name: String(sk.name ?? ""), description: String(sk.description ?? "") }));
		for (const d of r.diagnostics ?? []) diagnostics.push({ kind: "skill", path: d.path, message: d.message });
	} catch {
		skills = [];
	}
	let promptTemplates: WebSnapshot["promptTemplates"] = [];
	try {
		const r = loader.getPrompts();
		promptTemplates = r.prompts.map((p) => ({ name: String(p.name ?? ""), description: String(p.description ?? ""), argumentHint: p.argumentHint }));
		for (const d of r.diagnostics ?? []) diagnostics.push({ kind: "prompt", path: d.path, message: d.message });
	} catch {
		promptTemplates = [];
	}
	try {
		for (const e of loader.getExtensions().errors ?? []) diagnostics.push({ kind: "extension", path: e.path, message: e.error });
	} catch {
		/* ignore */
	}
	let extensionCommands: WebSnapshot["extensionCommands"] = [];
	if (m.session || commandRunner) {
		try {
			const runner = commandRunner ?? m.session?.extensionRunner;
			if (runner) {
				extensionCommands = runner.getRegisteredCommands().map((c) => ({
					name: c.invocationName,
					description: String(c.description ?? ""),
					source: String(c.sourceInfo?.path ?? "").split(/[\\/]/).pop() ?? "",
				}));
				for (const d of runner.getCommandDiagnostics() ?? []) diagnostics.push({ kind: "command", path: d.path, message: d.message });
			}
		} catch {
			extensionCommands = [];
		}
	}
	return { skills, promptTemplates, extensionCommands, projectTrust: resolveProjectTrust(m.cwd), resourceDiagnostics: diagnostics };
}

export function publishResources(m: Managed): void {
	publish(m, { type: "resources", ...collectResources(m), ts: Date.now() });
	publishContextBreakdown(m);
}

/**
 * 资源变更后（安装插件 / 新建模板 / 切换信任）：让持有该 cwd 的活跃会话重建扩展运行时
 * （SDK 的 session.reload() = pi 的 /reload），再广播新清单。正在流式的会话跳过，等它空闲。
 */
async function reloadManagedResources(m: Managed): Promise<boolean> {
	if (m.disposed || !m.session || m.creating || isManagedBusy(m)) return false;
	m.resourceReloadPending = false;
	try {
		await m.session.reload();
		// pi 1.3.0 起 reload 会保留原来的活动工具集：被移除的扩展工具会继续留在活动集里。
		// 这里按当前注册表重算一次；策略本身出错不能把重载判成失败。
		try {
			applyToolPolicy(m, m.session);
		} catch {
			/* 工具策略是附带动作，失败下次重载/切档位会再算 */
		}
		swapCurrentModelObject(m.session);
		return true;
	} catch (err) {
		publish(m, { type: "error", message: `重载扩展失败：${String((err as Error)?.message ?? err)}`, ts: Date.now() });
		return false;
	} finally {
		if (m.resourceReloadPending && !isManagedBusy(m)) queueMicrotask(() => void reloadManagedResources(m));
	}
}

/**
 * SDK 的 reload 不会换当前模型对象：models.json 改了 baseUrl / contextWindow 后，会话手里还是旧对象。
 * 按 provider/id 从（已就地刷新的）共享 runtime 取一次新的。
 */
function swapCurrentModelObject(session: AgentSession): void {
	const current = session.model;
	const fresh = current && session.modelRuntime.getModel(current.provider, current.id);
	if (fresh && fresh !== current) session.agent.state.model = fresh;
}

/**
 * 共享目录刷新后，给正在用这个模型的会话换上新模型对象（上下文窗口等字段跟着变），再推一次用量让圆环当场更新。
 * 运行中的会话也换：SDK 在扩展注册 provider 时同样会中途替换 agent.state.model，已发出的请求不受影响。
 */
export function refreshSessionModels(provider: string, id: string): number {
	let n = 0;
	for (const m of sessions.values()) {
		const current = m.session?.model;
		if (!m.session || current?.provider !== provider || current.id !== id) continue;
		swapCurrentModelObject(m.session);
		// 换了模型对象（contextWindow 可能变了）：条目数没变也会命中旧缓存，先失效再发
		usageCache.delete(m);
		publishUsage(m, true);
		n += 1;
	}
	return n;
}

export async function reloadSessionsForCwd(cwd?: string): Promise<number> {
	const key = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p.replace(/\\/g, "/"));
	let n = 0;
	for (const m of sessions.values()) {
		if (cwd && key(m.cwd) !== key(cwd)) continue;
		if (!m.session) {
			// 冷会话没有扩展运行时可重建，但页面可能开着：把新清单（模板 / 技能 / 信任）推过去
			if (hasViewers(m)) publishResources(m);
			continue;
		}
		if (m.creating || isManagedBusy(m)) {
			m.resourceReloadPending = true;
			publish(m, { type: "error", message: "资源已更新，将在本轮结束后生效", ts: Date.now() });
			publishResources(m);
			continue;
		}
		if (await reloadManagedResources(m)) n += 1;
	}
	return n;
}

// ---------- 快照 ----------

export async function buildSnapshot(m: Managed): Promise<WebSnapshot> {
	touch(m);
	// 冷路径的 prompt/技能/上下文资源都来自加载器，先等发现完成；
	// 用户刚在 prompts/skills/extensions 目录新建了文件的话顺手重载一次（只 stat 几个目录）
	await resourceLoaderReady(m.cwd);
	try {
		// 创建还未完成时，资源版本尚未落定；快照不能把它误标成需要再次 session_start。
		if (m.creating) {
			// 当前创建流程会发布最终资源状态。
		} else if (m.session && isManagedBusy(m)) {
			if (resourceLoaderIsStale(m.cwd) || m.resourceVersion !== resourceLoaderVersion(m.cwd)) m.resourceReloadPending = true;
		} else {
			await refreshResourceLoaderIfStale(m.cwd);
			if (m.session && (m.resourceReloadPending || m.resourceVersion !== resourceLoaderVersion(m.cwd))) {
				m.resourceReloadPending = true;
				await reloadManagedResources(m);
			}
		}
	} catch {
		/* 重载失败不影响快照 */
	}
	const session = m.session;
	let messages: WebMessage[] = [];
	let snapSeq: number | undefined;
	let model: WebSnapshot["model"];
	let thinkingLevel: string | undefined;
	let isStreaming = false;
	let thinkingLevels: string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	if (session) {
		const hasInflightFinal = linkInflightFinal(m, session);
		// session.messages 只是压缩后的模型上下文；前面补上被压缩掉的历史，压缩摘要投影成分隔卡
		let context: any[] = [];
		let history: WebMessage[] = [];
		try {
			context = m.sm.buildContextEntries() as any[];
			history = compactedHistory(m.sm, context);
		} catch {
			/* 条目读不到时只显示上下文 */
		}
		messages = [
			...history,
			...session.messages.map((message: any) =>
				message?.role === "compactionSummary" || message?.role === "branchSummary"
					? toWebMessage(message, summaryEntryId(context, message))
					: projectMessage(m, message)),
		];
		// final 已被 SDK push 时只投影一次；延后的 end 使用相同 streamId 继续更新权威内容。
		if (!hasInflightFinal && m.inflight) {
			const partial = projectMessage(m, m.inflight);
			if (partial.role === "assistant") messages.push({ ...partial, stopReason: "pending" });
		}
		snapSeq = m.seq;
		const modelObj: any = session.model;
		if (modelObj) model = { provider: String(modelObj.provider ?? ""), id: String(modelObj.id ?? ""), name: String(modelObj.name ?? modelObj.id ?? "") };
		thinkingLevel = String(session.thinkingLevel ?? "");
		try {
			thinkingLevels = session.getAvailableThinkingLevels() as unknown as string[];
		} catch {
			/* 回退到完整七档 */
		}
		isStreaming = isManagedBusy(m);
	} else {
		// 冷渲染：从 JSONL 还原消息（不启动 agent），压缩掉的历史也照常显示
		try {
			messages = sessionDisplayMessages(m.sm);
		} catch {
			messages = [];
		}
		try {
			const anySm = m.sm as unknown as { buildSessionContext?: () => { model?: { provider: string; modelId: string } | null; thinkingLevel?: string } };
			const ctx = anySm.buildSessionContext?.();
			if (ctx?.model) model = { provider: ctx.model.provider, id: ctx.model.modelId, name: ctx.model.modelId };
			thinkingLevel = ctx?.thinkingLevel;
			// 冷会话也按真实模型给档位，而不是固定七档
			if (ctx?.model) {
				const rt = await getModelRuntime();
				const mm = rt.getModel(ctx.model.provider, ctx.model.modelId);
				if (mm) {
					thinkingLevels = getSupportedThinkingLevels(mm as any);
					if (thinkingLevel) thinkingLevel = clampThinkingLevel(mm as any, thinkingLevel as any);
				}
			}
		} catch {
			/* ignore */
		}
	}

	const stats: WebStats | null = session ? sessionStats(m) : coldSessionStats(m);
	let contextUsage: WebSnapshot["contextUsage"] = null;
	if (session) {
		const usage = session.getContextUsage() ?? null;
		contextUsage = usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : null;
	} else if (model) {
		// 冷会话也使用当前分支投影，包含最后一次 API 用量之后的用户消息和工具输出。
		try {
			const rt = await getModelRuntime();
			const modelMeta = (rt.getModels(model.provider) as any[]).find((x) => String(x.id) === model.id);
			contextUsage = projectedContextUsage(m.sm.buildSessionProjection(), m.sm.getBranch(), Number(modelMeta?.contextWindow ?? 0));
		} catch {
			/* 模型或投影不可用时用量未知。 */
		}
	}

	const tools = session
		? { active: listActiveTools(session), all: listAllToolNames(session).map((n) => ({ name: n })) }
		: { active: [], all: [] };
	const queue = session
		? { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] }
		: { steering: [], followUp: [] };

	let name = "";
	try {
		name = (m.sm as unknown as { getSessionName?: () => string }).getSessionName?.() ?? "";
	} catch {
		name = "";
	}

	// 上下文注入资源（AGENTS.md 与扩展附加 prompt）；读失败时轨迹那边仍按原样自己再试一次
	let contextResources: ContextResource[] = [];
	let contextResourcesLoaded = false;
	try {
		contextResources = loadContextResources(m.cwd, m.session?.resourceLoader);
		contextResourcesLoaded = true;
	} catch {
		contextResources = [];
	}
	// 服务端可得的上下文分项（估算；失败不影响快照）
	let contextBreakdown: ContextBreakdown | undefined;
	try {
		contextBreakdown = await buildContextBreakdown(m, contextResources);
	} catch {
		contextBreakdown = undefined;
	}

	// 斜杠命令数据源：技能 / 提示模板 / 扩展命令，加上项目信任与资源诊断
	// 冷会话还没有 extensionRunner，但命令目录已经能发现；不要在第一次提问前推空列表。
	const resources = session && !m.creating ? collectResources(m) : await loadWorkspaceResources(m.cwd);

	const baseTrajectory = m.ledger.entries.length ? m.ledger.entries : coldTrajectory(m);
	const trajectory = [...environmentTrajectory(m, session, contextResourcesLoaded ? contextResources : undefined), ...baseTrajectory];

	return {
		seq: snapSeq ?? m.seq,
		sessionPath: m.sessionPath,
		cwd: m.cwd,
		name,
		contextFiles: contextResources.map((resource) => resource.path),
		contextResources,
		contextBreakdown,
		...resources,
		messages,
		userTurns: userTurnsFromEntries(m.sm.getEntries() as any[]),
		growthError: m.growth?.getError?.() ?? null,
		growthConsent: m.growth?.getConsentRequest?.() ?? null,
		model,
		thinkingLevel,
		thinkingLevels,
		toolPreset: m.toolPreset,
		customActiveTools: m.customActiveTools ?? null,
		extensionUiRequests: m.ui?.getPendingRequests() ?? [],
		// 扩展 setStatus 的当前值：重连拿快照时页脚状态不能丢
		extensionStatuses: Object.fromEntries(m.ui?.statuses ?? []),
		tools,
		stats,
		contextUsage,
		queue,
		trajectory,
		isStreaming,
		// 重载时没人在看（打开会话那一刻才发现）：靠快照把提示带给随后连上的浏览器，前端按 at 去重
		...(m.externalReload && Date.now() - m.externalReload.at < EXTERNAL_RELOAD_NOTICE_MS ? { externalReload: m.externalReload } : {}),
	};
}

function coldTrajectory(m: Managed): TrajEntry[] {
	try {
		return buildTrajectoryFromEntries(m.sm.getEntries() as unknown as any[]);
	} catch {
		return [];
	}
}

// ---------- SSE 订阅 ----------

/** SSE 事件 id：`<epoch>.<seq>` */
export function sseEventId(m: Managed, seq: number): string {
	return `${m.epoch}.${seq}`;
}

/** 解析浏览器带回的 Last-Event-ID；不是这一份 Managed 发的（epoch 对不上）一律当没有，走快照 */
export function parseLastEventId(m: Managed, raw: string | null): number | undefined {
	const match = /^([A-Za-z0-9]+)\.(\d+)$/.exec(raw?.trim() ?? "");
	if (!match || match[1] !== m.epoch) return undefined;
	const seq = Number(match[2]);
	return Number.isSafeInteger(seq) ? seq : undefined;
}

export function subscribe(
	m: Managed,
	send: (seq: number, json: string) => void,
	lastEventId: number,
): boolean {
	touch(m);
	if (lastEventId < 0 || lastEventId > m.seq) return false;
	const replay = m.buffer.filter((b) => b.seq > lastEventId);
	if (replay.length !== m.seq - lastEventId) return false;
	const pending = new Set(m.ui?.getPendingRequests().map((request) => request.id));
	if (replay.some((frame) => {
		const event = JSON.parse(frame.json) as WebEvent;
		return event.type === "extension_ui" && ["select", "confirm", "input"].includes(event.method) && !pending.has(event.id);
	})) return false;
	m.subscribers.add(send);
	for (const b of replay) send(b.seq, b.json);
	return true;
}

export function unsubscribe(m: Managed, send: (seq: number, json: string) => void): void {
	m.subscribers.delete(send);
}

/**
 * 长轮询（快速隧道）的一次请求结束时调用：下一次请求到来前的这段空档仍算有人在看，
 * 否则扩展弹窗会被当成无人值守直接取默认值，会话也可能被当成没人开着回收掉。
 */
export function holdViewer(m: Managed, ms: number): void {
	m.viewerGraceUntil = Math.max(m.viewerGraceUntil ?? 0, Date.now() + ms);
}

function hasViewers(m: Managed): boolean {
	if (m.viewerAvailable) return m.viewerAvailable();
	return m.subscribers.size > 0 || (m.viewerGraceUntil ?? 0) > Date.now();
}

// ---------- 命令执行 ----------

export interface CommandResult {
	ok: boolean;
	error?: string;
	data?: Record<string, unknown>;
}

/**
 * 发 prompt 前给生长记录拍基线。基线不能无限阻塞提问（git 不可用时每次探测至多 30s 超时）：
 * 5s 内没完成就放行，快照后台补拍（工具结束后照常记步，外部修改兜底）。
 */
async function prepareGrowthBriefly(m: Managed): Promise<void> {
	await Promise.race([
		growthOf(m).prepare().catch(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, 5000)),
	]);
}

type PromptImages = NonNullable<NonNullable<Parameters<AgentSession["prompt"]>[1]>["images"]>;

/** 被编辑的那条用户消息里的图片：编辑只改文字，图片原样带进重发（编辑框里也照样显示它们） */
function userMessageImages(session: AgentSession, entryId: string): PromptImages {
	const entry = session.sessionManager?.getEntry?.(entryId) as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
	if (entry?.type !== "message" || entry.message?.role !== "user" || !Array.isArray(entry.message.content)) return [];
	return entry.message.content.filter(
		(c): c is PromptImages[number] => c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string",
	);
}

/** 交给 SDK，并在「受理」那一刻返回，而不是等整轮跑完；受理之后的错误经 SSE 可见 */
function submitPrompt(
	m: Managed,
	session: AgentSession,
	text: string,
	options: Pick<NonNullable<Parameters<AgentSession["prompt"]>[1]>, "images" | "streamingBehavior"> = {},
): Promise<CommandResult> {
	return new Promise<CommandResult>((resolve) => {
		let accepted = false;
		const run = session.prompt(text, {
			...options,
			source: "rpc",
			preflightResult: (success) => {
				if (success) {
					accepted = true;
					resolve({ ok: true, data: { accepted: true } });
				}
			},
		});
		// 同步挂好 rejection handler；接受后的错误仍经 SSE 可见，不能成为未处理拒绝。
		void run.then(() => {
			// 上一轮的 agent_settled 还没发完时，SDK 不拒绝提问，而是把它挂进 deferredSettledActions，
			// 立即返回并在稍后用同一份 options 重发；这条路径不会调用 preflightResult。
			// 消息确实会发出去，不能报「未受理」——否则界面报错，消息随后照样出现。真正的拒绝只会是 rejection。
			if (!accepted) resolve({ ok: true, data: { accepted: true } });
		}, (error) => {
			const message = String(error?.message ?? error);
			if (accepted) publish(m, { type: "error", message, ts: Date.now() });
			else resolve({ ok: false, error: message });
		});
	});
}

export async function execute(m: Managed, cmd: AgentCommand): Promise<CommandResult> {
	touch(m);
	try {
		switch (cmd.cmd) {
			case "prepare":
				await ensureSession(m);
				return { ok: true };
			case "prompt": {
				const text = (cmd.text ?? "").trim();
				if (!text && !cmd.images?.length) return { ok: false, error: "empty prompt" };
				// 在第一个 await 前占位，两个并发请求不能都看见 idle 后启动/误排队。
				if (m.promptSubmitting || m.resourceReloading) return { ok: false, error: "session is busy accepting another command" };
				m.promptSubmitting = true;
				try {
					const session = await ensureSession(m);
					if (m.disposed) throw new Error("session is disposed");
					// 只有用户显式选择 steer/followUp 才排队；旧的普通提交不能悄悄成为 steering。
					if ((session.isStreaming || m.runActive) && !cmd.behavior) return { ok: false, error: "session is busy; choose steer or followUp" };
					if (!session.isStreaming) await prepareGrowthBriefly(m);
					if (m.disposed) throw new Error("session is disposed");
					return await submitPrompt(m, session, text, { images: cmd.images, streamingBehavior: cmd.behavior });
				} finally {
					m.promptSubmitting = false;
					if (!m.disposed) publish(m, { type: "status", isStreaming: isManagedBusy(m), state: isManagedBusy(m) ? "running" : "idle", ts: Date.now() });
					if (m.resourceReloadPending) queueMicrotask(() => void reloadManagedResources(m));
				}
			}
			case "steer":
			case "followUp": {
				if (m.promptSubmitting || m.resourceReloading) return { ok: false, error: "session is busy accepting another command" };
				const session = await ensureSession(m);
				if (m.promptSubmitting || m.resourceReloading || !session.isStreaming) return { ok: false, error: "session is not accepting queued messages" };
				await session[cmd.cmd](cmd.text ?? "", cmd.images);
				return { ok: true };
			}
			case "clearQueue": {
				if (!m.session) return { ok: true, data: { steering: [], followUp: [] } };
				const cleared = m.session.clearQueue();
				publish(m, { type: "queue", steering: [], followUp: [], ts: Date.now() });
				return { ok: true, data: cleared };
			}
			case "abort": {
				if (!m.session) return { ok: true, data: { steering: [], followUp: [] } };
				// 先清队列再中止（pi 终端 Esc 同款）：Agent.abort() 不清队列，而 agent 循环每次开跑都先取走 steering 队列，
				// 不清的话「已取消」的排队消息会在下一次提问时冒出来。清出来的文本交给前端放回输入框
				const cleared = m.session.clearQueue();
				await m.session.abort();
				publish(m, { type: "status", isStreaming: false, state: "aborted", ts: Date.now() });
				return { ok: true, data: cleared };
			}
			case "compact": {
				const session = await ensureSession(m);
				await session.compact(cmd.instructions || undefined);
				return { ok: true };
			}
			case "setModel": {
				const session = await ensureSession(m);
				const rt = await getModelRuntime();
				const model = rt.getModels(cmd.provider).find((x) => x.id === cmd.modelId) as any;
				if (!model) return { ok: false, error: `unknown model ${cmd.provider}/${cmd.modelId}` };
				await session.setModel(model, { persist: false });
				reapplyDesiredLevel(m, session);
				// 新会话页选的模型（fresh）：思考档位按新会话的规则定；之后显式选的档位仍会覆盖
				if (cmd.fresh === true && !m.desiredThinkingLevel) applyNewSessionThinking(m, session);
				usageCache.delete(m); // 换模型 = contextWindow 变了，旧 usage 缓存作废
				publishModelState(m, session);
				publishUsage(m, true);
				return { ok: true, data: { thinkingLevel: session.thinkingLevel, thinkingLevels: session.getAvailableThinkingLevels() } };
			}
			case "setThinkingLevel": {
				const session = await ensureSession(m);
				const requested = String(cmd.level ?? "medium");
				// 与 pi 终端一致：不支持的档位就近钳制而不是拒绝（非推理模型 → off），并把实际生效值回传
				const effective = clampThinkingLevel(session.model as any, requested as any);
				m.desiredThinkingLevel = requested;
				// 不传 persist：与终端 pi 一样，聊天里切档位只影响本会话；全局默认仍以 settings.json 为准（见 reapplyDesiredLevel）
				session.setThinkingLevel(effective as never);
				publishModelState(m, session);
				return { ok: true, data: { requested, thinkingLevel: session.thinkingLevel, clamped: session.thinkingLevel !== requested } };
			}
			case "setToolPreset": {
				const preset = cmd.preset as ToolPreset;
				if (!Object.hasOwn(TOOL_PRESETS, preset)) return { ok: false, error: "invalid tool preset" };
				// 运行中也能改：SDK 的 setActiveToolsByName 不做 busy 检查，改完重建系统提示词，
				// 在下一轮生效（本轮的请求已经发出去了，改不了）。这里不再自行拦一层。
				if (!m.session && !m.creating) {
					// 冷会话只记下选择，等真正启动时（ensureSession → applyToolPolicy）再生效。
					// 不能为了切个档位就冷启动 agent：打开会话时前端会恢复本地档位，
					// 若这里 ensureSession，光是浏览历史会话就会跑一遍扩展的 session_start。
					m.toolPreset = preset;
					m.customActiveTools = undefined;
					publish(m, { type: "tools", active: [], all: [], toolPreset: preset, customActiveTools: null, ts: Date.now() });
					return { ok: true };
				}
				const session = await ensureSession(m);
				if (m.disposed) return { ok: false, error: "session is disposed" };
				m.toolPreset = preset;
				m.customActiveTools = undefined;
				applyToolPolicy(m, session);
				publishEnvironmentTrajectory(m, session);
				publishTools(m, session);
				return { ok: true };
			}
			case "setActiveTools": {
				// 同上：运行中允许改，下一轮生效。
				const session = await ensureSession(m);
				if (m.disposed) return { ok: false, error: "session is disposed" };
				const wanted = Array.isArray(cmd.names) ? cmd.names.map(String) : [];
				const all = listAllToolNames(session);
				const next = [...new Set(wanted)].filter((n) => all.includes(n));
				if (next.length === 0) return { ok: false, error: "cannot disable all tools" };
				m.customActiveTools = next;
				applyToolPolicy(m, session);
				publishEnvironmentTrajectory(m, session);
				publishTools(m, session);
				return { ok: true, data: { active: listActiveTools(session) } };
			}
			case "cycleModel": {
				const session = await ensureSession(m);
				const r = await session.cycleModel(cmd.direction ?? "forward");
				if (r?.model) {
					reapplyDesiredLevel(m, session);
					publishModelState(m, session);
					return { ok: true, data: { model: String((r.model as any).id ?? ""), thinkingLevel: session.thinkingLevel } };
				}
				return { ok: false, error: "no scoped models to cycle" };
			}
			case "navigate": {
				const session = await ensureSession(m);
				const entryId = String((cmd as any).entryId ?? "");
				if (!entryId) return { ok: false, error: "missing entryId" };
				const r = await session.navigateTree(entryId);
				return { ok: !r?.cancelled, data: { cancelled: r?.cancelled === true, editorText: r?.editorText } };
			}
			case "editAndResend": {
				// 编辑用户消息并重发：先停在跑的回合（用户改口即表示不要这一轮的输出），
				// 再回到该消息之前用新文本重新提问。放在服务端串行做，避免客户端"先 abort 再发"的竞态。
				const entryId = String((cmd as any).entryId ?? "");
				const text = (cmd.text ?? "").trim();
				if (!entryId) return { ok: false, error: "missing entryId" };
				if (!text) return { ok: false, error: "empty prompt" };
				if (m.promptSubmitting || m.resourceReloading) return { ok: false, error: "session is busy accepting another command" };
				m.promptSubmitting = true;
				try {
					const session = await ensureSession(m);
					if (m.disposed) throw new Error("session is disposed");
					if (session.isStreaming || m.runActive) {
						await session.abort().catch(() => undefined);
						// 等 SDK 真正回到空闲（abort 是异步的；最多等 5 秒，超时就按当前状态继续）
						for (let i = 0; i < 50 && !m.disposed && (session.isStreaming || m.runActive); i += 1) {
							await new Promise((resolve) => setTimeout(resolve, 100));
						}
					}
					if (m.disposed) throw new Error("session is disposed");
					// 回到消息之前先取它带的图片：客户端只发改过的文字，不取的话重发出去图就没了
					const images = userMessageImages(session, entryId);
					const moved = await session.navigateTree(entryId);
					if (moved?.cancelled) return { ok: false, error: "edit cancelled" };
					await prepareGrowthBriefly(m);
					if (m.disposed) throw new Error("session is disposed");
					// 与普通 prompt 一样在受理时就返回：等整轮跑完的话，这期间 promptSubmitting 一直为真，
					// 插话 / 排队 / 新消息全被拒，HTTP 请求也一直挂着
					return await submitPrompt(m, session, text, images.length ? { images } : {});
				} finally {
					m.promptSubmitting = false;
					if (!m.disposed) publish(m, { type: "status", isStreaming: isManagedBusy(m), state: isManagedBusy(m) ? "running" : "idle", ts: Date.now() });
					if (m.resourceReloadPending) queueMicrotask(() => void reloadManagedResources(m));
				}
			}
			case "rename": {
				const name = (cmd.text ?? "").trim();
				if (m.session) m.session.setSessionName(name);
				else (m.sm as unknown as { appendSessionInfo: (n: string) => string }).appendSessionInfo(name);
				publish(m, { type: "name", name, ts: Date.now() });
				return { ok: true };
			}
			case "extensionUiResponse": {
				const ok = m.ui?.respond(String(cmd.requestId), { value: cmd.value, confirmed: cmd.confirmed, cancelled: cmd.cancelled }) ?? false;
				return ok ? { ok: true } : { ok: false, error: "no pending extension request" };
			}
			case "reload": {
				if (isManagedBusy(m)) return { ok: false, error: "session is busy" };
				// /reload：先就地刷新共享的模型目录（models.json / auth.json 可能是手改的）；其它会话手里的
				// 模型对象跟着换新，忙着的等本轮结束再换；本会话重载资源后再换一次
				await refreshModelRuntime();
				for (const other of sessions.values()) {
					if (other === m || !other.session) continue;
					if (isManagedBusy(other)) other.resourceReloadPending = true;
					else swapCurrentModelObject(other.session);
				}
				const session = await ensureSession(m);
				await session.reload();
				// 同 reloadManagedResources：pi 1.3.0 保留活动工具集，重载后按当前注册表重算
				try {
					applyToolPolicy(m, session);
				} catch {
					/* 同上：策略失败不影响 /reload 本身 */
				}
				swapCurrentModelObject(session);
				return { ok: true };
			}
			case "fork": {
				const forked = cmd.entryId
					? SessionManager.open(m.sessionPath).createBranchedSession(cmd.entryId)
					: SessionManager.forkFrom(m.sessionPath, m.cwd).getSessionFile();
				const newPath = forked ?? "";
				if (!newPath) return { ok: false, error: "failed to create forked session" };
				return { ok: true, data: { sessionPath: newPath } };
			}
			default:
				return { ok: false, error: `unknown cmd` };
		}
	} catch (err: any) {
		return { ok: false, error: String(err?.message ?? err) };
	}
}

/** 新建会话（不启动 agent；发第一条消息时才冷启动） */
export async function createNewSession(cwd: string): Promise<{ sessionPath: string }> {
	const sm = SessionManager.create(cwd);
	const p = sm.getSessionFile() ?? "";
	if (!p) throw new Error("failed to create session file");
	// 必须直接注册 create 得到的实例：JSONL 落盘前 SessionManager.open(p) 找不到
	// 文件会走新建分支，cwd 回退 process.cwd()，把会话偷换到服务器进程目录。
	registerManaged(p, cwd, sm);
	return { sessionPath: p };
}

/** 活跃会话状态（给侧栏状态点用） */
export function activeStatus(): Record<string, { streaming: boolean; lastStep?: string }> {
	const out: Record<string, { streaming: boolean; lastStep?: string }> = {};
	for (const [p, m] of sessions) {
		if (!m.session) continue;
		// 侧栏显示“最后一步”：正在跑的会话让用户一眼知道它在干什么
		let lastStep: string | undefined;
		for (let i = m.ledger.entries.length - 1; i >= 0; i -= 1) {
			const e = m.ledger.entries[i];
			if (e.kind === "tool") {
				lastStep = [e.toolName, toolStepPreview(e)].filter(Boolean).join(" · ");
				break;
			}
		}
		out[p] = { streaming: isManagedBusy(m), lastStep };
	}
	return out;
}

/** 导出（html 需要真实 AgentSession，冷会话会静默冷启动） */
export async function exportSession(
	m: Managed,
	format: "jsonl" | "html",
): Promise<{ filename: string; content: string; contentType: string }> {
	const base = m.sessionPath.replace(/\\/g, "/").split("/").pop() ?? "session";
	if (format === "jsonl") {
		const { readFile } = await import("node:fs/promises");
		return { filename: base, content: await readFile(m.sessionPath, "utf8"), contentType: "application/jsonl" };
	}
	const session = await ensureSession(m);
	// exportToHtml 返回的是写入磁盘的路径，不是内容；读回后删掉临时副本
	const outPath = await session.exportToHtml();
	const { readFile, rm } = await import("node:fs/promises");
	const content = await readFile(outPath, "utf8");
	await rm(outPath, { force: true }).catch(() => undefined);
	return { filename: base.replace(/\.jsonl$/, ".html"), content, contentType: "text/html" };
}
