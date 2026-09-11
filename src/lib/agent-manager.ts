/**
 * agent-manager：AgentSession 池 + pi 事件 → Web 事件翻译 + SSE 订阅管理。
 * 打开会话即惰性冷启动（createAgentSession），空闲回收，事件先快照后增量。
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	getResourceLoader,
	getSettingsManager,
	getAgentDir,
	loadProjectContextFiles,
	peekResourceLoader,
	refreshResourceLoaderIfStale,
	resolveProjectTrust,
	resourceLoaderReady,
	withResourceLock,
	TOOL_PRESETS,
	SessionManager,
	createAgentSession,
	getModelRuntime,
	openSessionManager,
} from "./pi";
import { createExtensionUiBridge, type ExtensionUiBridge } from "./extension-ui";
import { TrajLedger, buildTrajectoryFromEntries, toTrajTokens } from "./trajectory";
import { sanitizeToolOutput } from "./text-sanitize";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
	AgentCommand,
	ContextResource,
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

interface Managed {
	sessionPath: string;
	cwd: string;
	sm: SessionManager;
	session: AgentSession | null;
	creating: Promise<AgentSession> | null;
	subscribers: Set<(seq: number, json: string) => void>;
	buffer: { seq: number; json: string }[];
	seq: number;
	ledger: TrajLedger;
	lastActive: number;
	toolPreset: ToolPreset;
	/** 用户在本会话里最后一次显式选择的思考级别；切模型后按新模型就近钳制重新应用，不让选择被 SDK 带丢 */
	desiredThinkingLevel?: string;
	/** 正在流式生成、尚未进入 session.messages 的助手消息（SDK 的共享 partial 对象）；中途订阅的快照要带上它 */
	inflight: unknown | null;
	/** 扩展界面请求桥（select/confirm/input/notify → 浏览器） */
	ui: ExtensionUiBridge | null;
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
	}
	return out;
}

function entryIdForMessage(sm: SessionManager, message: any): string | undefined {
	const entries = sm.getEntries() as any[];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message" || !entry.message) continue;
		if (entry.message === message) return typeof entry.id === "string" ? entry.id : undefined;
		if (entry.message.role === message?.role && entry.message.timestamp === message?.timestamp) {
			return typeof entry.id === "string" ? entry.id : undefined;
		}
	}
	return undefined;
}

/** edit/write 工具在 details.patch 里带 unified patch；限长避免撑爆 SSE 帧 */
function patchOf(details: unknown): string | undefined {
	const patch = (details as { patch?: unknown } | undefined)?.patch;
	return typeof patch === "string" && patch.trim() ? patch.slice(0, 60_000) : undefined;
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

function publish(m: Managed, evt: WebEvent): void {
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

/** 切模型后恢复用户显式选过的级别（按新模型钳制） */
function reapplyDesiredLevel(m: Managed, session: AgentSession): void {
	if (!m.desiredThinkingLevel) return;
	const target = clampThinkingLevel(session.model as any, m.desiredThinkingLevel as any);
	if (target !== session.thinkingLevel) session.setThinkingLevel(target as never);
}

function publishTraj(m: Managed): void {
	for (const entry of m.ledger.drainDirty()) {
		publish(m, { type: "traj", entry, ts: Date.now() });
	}
}

function timingStats(m: Managed): Pick<WebStats, "llmMs" | "toolMs" | "ttftMs" | "ttftSteps" | "decodeMs" | "decodeTokens"> {
	let llmMs = 0;
	let toolMs = 0;
	let ttftMs = 0;
	let ttftSteps = 0;
	let decodeMs = 0;
	let decodeTokens = 0;
	for (const entry of m.ledger.entries) {
		if (entry.kind === "tool") {
			toolMs += Math.max(0, entry.timing?.durationMs ?? 0);
			continue;
		}
		if (entry.kind !== "message") continue;
		llmMs += Math.max(0, entry.timing?.durationMs ?? 0);
		if (entry.timing?.ttftMs !== undefined) {
			ttftMs += Math.max(0, entry.timing.ttftMs);
			ttftSteps += 1;
		}
		if (entry.timing?.decodeMs !== undefined && entry.tokens?.output !== undefined) {
			decodeMs += Math.max(0, entry.timing.decodeMs);
			decodeTokens += Math.max(0, entry.tokens.output);
		}
	}
	return { llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens };
}

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
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) addUsage(entry.usage);
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

function publishUsage(m: Managed): void {
	if (!m.session) return;
	const stats = sessionStats(m);
	const usage = m.session.getContextUsage() ?? null;
	publish(m, {
		type: "usage",
		stats,
		contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : null,
		ts: Date.now(),
	});
}

function translate(m: Managed, evt: AgentSessionEvent): void {
	m.ledger.onEvent(evt);
	const now = Date.now();
	switch (evt.type) {
		case "message_start": {
			const raw = (evt as any).message;
			const msg = toWebMessage(raw, entryIdForMessage(m.sm, raw));
			if (msg.role === "assistant") {
				m.inflight = raw;
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
			if ((evt as any).message) m.inflight = (evt as any).message;
			if (!e) break;
			if (e.type === "text_delta" && typeof e.delta === "string") {
				publish(m, { type: "delta", kind: "text", contentIndex: e.contentIndex, delta: e.delta, ts: now });
			} else if (e.type === "thinking_delta" && typeof e.delta === "string") {
				publish(m, { type: "delta", kind: "thinking", contentIndex: e.contentIndex, delta: e.delta, ts: now });
			}
			break;
		}
		case "message_end": {
			const raw = (evt as any).message;
			m.inflight = null;
			// Pi persists message_end after notifying listeners; wait one microtask so
			// the browser receives the durable entry ID used by branch creation.
			queueMicrotask(() => {
				const msg = toWebMessage(raw, entryIdForMessage(m.sm, raw));
				if (msg.role === "assistant") msg.endedAt = now;
				publish(m, { type: "message", message: msg, phase: "end", ts: now });
				publishUsage(m);
			});
			break;
		}
		case "tool_execution_start":
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
			publish(m, {
				type: "tool",
				id: evt.toolCallId,
				name: evt.toolName,
				args: (evt as any).args,
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
				patch: patchOf((evt as any).result?.details),
				ts: now,
			});
			publishUsage(m);
			break;
		}
		case "agent_start":
			publish(m, { type: "status", isStreaming: true, state: "running", ts: now });
			break;
		case "agent_end":
		case "agent_settled":
			publish(m, { type: "status", isStreaming: false, state: "idle", ts: now });
			publishUsage(m);
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
			publish(m, { type: "compaction", phase: "start", reason: (evt as any).reason, ts: now });
			break;
		case "compaction_end":
			publish(m, {
				type: "compaction",
				phase: "end",
				reason: (evt as any).reason,
				errorMessage: (evt as any).errorMessage,
				ts: now,
			});
			publishUsage(m);
			break;
		case "session_info_changed":
			publish(m, { type: "name", name: (evt as any).name ?? "", ts: now });
			break;
		case "thinking_level_changed":
			if (m.session) publishModelState(m, m.session);
			else publish(m, { type: "model", thinkingLevel: (evt as any).level, ts: now });
			break;
		case "auto_retry_start":
			publish(m, { type: "error", message: `自动重试 ${(evt as any).attempt}/${(evt as any).maxAttempts}：${(evt as any).errorMessage ?? ""}`, ts: now });
			break;
		default:
			break;
	}
	publishTraj(m);
}

// ---------- 会话生命周期 ----------

function touch(m: Managed): void {
	m.lastActive = Date.now();
}

export function getManaged(sessionPath: string): Managed {
	let m = sessions.get(sessionPath);
	if (!m) {
		const sm = openSessionManager(sessionPath);
		m = registerManaged(sessionPath, sm.getCwd() || process.cwd(), sm);
	}
	touch(m);
	return m;
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
		inflight: null,
		ui: null,
		ledger: new TrajLedger(initialTrajectory),
		lastActive: Date.now(),
		toolPreset: "standard",
	};
	sessions.set(sessionPath, m);
	return m;
}

function loadContextResources(cwd: string): ContextResource[] {
	const files = loadProjectContextFiles({ cwd, agentDir: getAgentDir() }).map((file) => ({
		path: file.path,
		content: file.content,
		source: "project" as const,
	}));
	const loader = getResourceLoader(cwd);
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

function environmentTrajectory(m: Managed, session: AgentSession | null): TrajEntry[] {
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
		const resources = loadContextResources(m.cwd);
		resources.forEach((resource, index) => entries.push({
			seq: -2 - index,
			kind: "context",
			ts,
			title: resource.path,
			detail: resource.content,
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
	if (m.session) return m.session;
	if (!m.creating) {
		m.creating = (async () => {
			// 资源加载器必须先完成发现（AGENTS.md/技能/模板），SDK 不会替调用方加载
			await resourceLoaderReady(m.cwd);
			const { session } = await createAgentSession({
				cwd: m.cwd,
				sessionManager: m.sm,
				modelRuntime: await getModelRuntime(),
				resourceLoader: getResourceLoader(m.cwd),
				settingsManager: getSettingsManager(m.cwd),
			});
			// 工具注册表保持全集，预设只在激活层面收敛；
			// 在 create 时传白名单会把 grep/find/ls 等永久锁在注册表外，
			// 之后无论怎么切预设都拿不回来。
			const allow = TOOL_PRESETS[m.toolPreset];
			if (allow && allow.length) {
				const all = listAllToolNames(session);
				(session as unknown as { setActiveToolsByName: (names: string[]) => void }).setActiveToolsByName(
					all.filter((name) => allow.includes(name)),
				);
			}
			session.subscribe((evt) => translate(m, evt));
			m.session = session;
			// 绑定扩展：不绑定的话 SDK 不会向扩展发 session_start，扩展的 select/confirm/notify 全是 no-op，
			// 扩展注册的斜杠命令也无从执行。语义对齐 pi 的 RPC 模式。
			const ui = createExtensionUiBridge({ publish: (evt) => publish(m, evt), hasViewers: () => m.subscribers.size > 0 });
			m.ui = ui;
			try {
				await session.bindExtensions({
					mode: "rpc",
					uiContext: ui.uiContext as never,
					onError: (error: { extensionPath: string; event: string; error: string }) => {
						publish(m, { type: "error", message: `扩展 ${error.extensionPath.split(/[\\/]/).pop()} 在 ${error.event} 出错：${error.error}`, ts: Date.now() });
					},
					abortHandler: () => void session.abort().catch(() => undefined),
				});
			} catch (err) {
				publish(m, { type: "error", message: `扩展初始化失败：${String((err as Error)?.message ?? err)}`, ts: Date.now() });
			}
			publishEnvironmentTrajectory(m, session);
			publish(m, {
				type: "tools",
				active: listActiveTools(session),
				all: listAllToolNames(session),
				ts: Date.now(),
			});
			publishResources(m);
			publishUsage(m);
			return session;
		})().catch((err) => {
			m.creating = null;
			publish(m, { type: "error", message: String(err?.message ?? err), ts: Date.now() });
			throw err;
		});
	}
	return m.creating;
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
	m.ui?.dispose();
	m.ui = null;
	try {
		m.session?.dispose();
	} catch {
		/* ignore */
	}
	// 正在创建中的会话：创建完成后立即销毁，否则它会挂在已被移出池的
	// Managed 上，订阅与句柄永久泄漏（同一 JSONL 还会出现双活跃会话）。
	if (m.creating) {
		void m.creating
			.then((session) => {
				try {
					session?.dispose();
				} catch {
					/* ignore */
				}
			})
			.catch(() => undefined);
	}
	for (const send of m.subscribers) {
		try {
			send(m.seq, JSON.stringify({ type: "status", isStreaming: false, state: "disposed", ts: Date.now() }));
		} catch {
			/* ignore */
		}
	}
	sessions.delete(m.sessionPath);
}

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
		if (m.subscribers.size > 0 || now - m.lastActive <= IDLE_MS) continue;
		if (!m.session || !m.session.isStreaming) disposeSession(m);
	}
	const active = [...sessions.values()].filter((m) => m.session);
	if (active.length > MAX_ACTIVE) {
		const evictable = active
			.filter((m) => !m.session!.isStreaming && m.subscribers.size === 0)
			.sort((a, b) => a.lastActive - b.lastActive);
		for (const m of evictable.slice(0, active.length - MAX_ACTIVE)) disposeSession(m);
	}
}

setInterval(reap, 60_000).unref?.();

// ---------- 资源清单（技能 / 提示模板 / 扩展命令 / 信任 / 诊断） ----------

type ResourceBundle = Pick<WebSnapshot, "skills" | "promptTemplates" | "extensionCommands" | "projectTrust" | "resourceDiagnostics">;

function collectResources(m: Managed): ResourceBundle {
	const loader = peekResourceLoader(m.cwd) ?? getResourceLoader(m.cwd);
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
	if (m.session) {
		try {
			const runner = (m.session as unknown as { extensionRunner?: { getRegisteredCommands(): Array<{ invocationName: string; description?: string; sourceInfo?: { path?: string } }>; getCommandDiagnostics(): Array<{ path?: string; message: string }> } }).extensionRunner;
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
}

/**
 * 资源变更后（安装插件 / 新建模板 / 切换信任）：让持有该 cwd 的活跃会话重建扩展运行时
 * （SDK 的 session.reload() = pi 的 /reload），再广播新清单。正在流式的会话跳过，等它空闲。
 */
export async function reloadSessionsForCwd(cwd?: string): Promise<number> {
	const key = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p.replace(/\\/g, "/"));
	let n = 0;
	for (const m of sessions.values()) {
		if (cwd && key(m.cwd) !== key(cwd)) continue;
		if (!m.session) {
			// 冷会话没有扩展运行时可重建，但页面可能开着：把新清单（模板 / 技能 / 信任）推过去
			if (m.subscribers.size > 0) publishResources(m);
			continue;
		}
		if (m.session.isStreaming) {
			publish(m, { type: "error", message: "资源已更新，将在本轮结束后生效", ts: Date.now() });
			continue;
		}
		try {
			const session = m.session;
			await withResourceLock(() => session.reload());
			n += 1;
			publish(m, { type: "tools", active: listActiveTools(m.session), all: listAllToolNames(m.session), ts: Date.now() });
			publishEnvironmentTrajectory(m, m.session);
		} catch (err) {
			publish(m, { type: "error", message: `重载扩展失败：${String((err as Error)?.message ?? err)}`, ts: Date.now() });
		}
		publishResources(m);
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
		if (await refreshResourceLoaderIfStale(m.cwd)) {
			const session = m.session;
			if (session && !session.isStreaming) await withResourceLock(() => session.reload());
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
		messages = session.messages.map((message) => toWebMessage(message, entryIdForMessage(m.sm, message)));
		// 正在生成的助手消息还没进 session.messages：中途打开页面的人要能看到已生成的部分，
		// 之后的 delta 从 snapSeq 起回放，正好接上（消息投影和 seq 必须在同一同步段里取）
		if (session.isStreaming && m.inflight) {
			const partial = toWebMessage(m.inflight);
			if (partial.role === "assistant") messages.push(partial);
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
		isStreaming = session.isStreaming;
	} else {
		// 冷渲染：从 JSONL 还原上下文消息（不启动 agent）
		try {
			const entries = m.sm.buildContextEntries();
			messages = entries
				.filter((e: any) => e.type === "message" && e.message)
				.map((e: any) => toWebMessage(e.message, e.id));
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
		// 冷会话没有 SDK 实例：用最后一轮 assistant 用量（input+cache+output ≈ 该轮后的
		// 上下文规模）除以模型窗口估算，避免上下文计量永远显示 0% / —
		try {
			const rt = await getModelRuntime();
			const modelMeta = (rt.getModels(model.provider) as any[]).find((x) => String(x.id) === model.id);
			const window = Number(modelMeta?.contextWindow ?? 0);
			let lastTurnTokens = 0;
			// 与 SDK getContextUsage 同一条规则：最近一次压缩之后还没有新的助手回复时，上下文大小未知（不能拿压缩前的用量充数）
			const entries = m.sm.getEntries() as Array<{ type?: string; message?: { role?: string; stopReason?: string } }>;
			let compactedSinceLastAssistant = false;
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e.type === "compaction" || e.type === "branch_summary") {
					compactedSinceLastAssistant = true;
					break;
				}
				if (e.type === "message" && e.message?.role === "assistant" && e.message.stopReason !== "error" && e.message.stopReason !== "aborted") break;
			}
			for (let i = messages.length - 1; i >= 0 && !compactedSinceLastAssistant; i--) {
				const msg = messages[i];
				if (msg.role === "assistant" && msg.usage) {
					lastTurnTokens =
						Number(msg.usage.input ?? 0) +
						Number(msg.usage.cacheRead ?? 0) +
						Number(msg.usage.cacheWrite ?? 0) +
						Number(msg.usage.output ?? 0);
					break;
				}
			}
			if (window > 0 && lastTurnTokens > 0) {
				contextUsage = { tokens: lastTurnTokens, contextWindow: window, percent: (lastTurnTokens / window) * 100 };
			} else if (window > 0) {
				contextUsage = { tokens: null, contextWindow: window, percent: null };
			}
		} catch {
			/* 模型目录不可用则维持 null（UI 显示 0%） */
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

	// 上下文注入资源（AGENTS.md 与扩展附加 prompt）
	let contextResources: ContextResource[] = [];
	try {
		contextResources = loadContextResources(m.cwd);
	} catch {
		contextResources = [];
	}

	// 斜杠命令数据源：技能 / 提示模板 / 扩展命令，加上项目信任与资源诊断
	const resources = collectResources(m);

	const baseTrajectory = m.ledger.entries.length ? m.ledger.entries : coldTrajectory(m);
	const trajectory = [...environmentTrajectory(m, session), ...baseTrajectory];

	return {
		seq: snapSeq ?? m.seq,
		sessionPath: m.sessionPath,
		cwd: m.cwd,
		name,
		contextFiles: contextResources.map((resource) => resource.path),
		contextResources,
		...resources,
		messages,
		model,
		thinkingLevel,
		thinkingLevels,
		tools,
		stats,
		contextUsage,
		queue,
		trajectory,
		isStreaming,
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

export function subscribe(
	m: Managed,
	send: (seq: number, json: string) => void,
	lastEventId: number,
): boolean {
	touch(m);
	if (lastEventId < 0 || lastEventId > m.seq) return false;
	const replay = m.buffer.filter((b) => b.seq > lastEventId);
	if (replay.length !== m.seq - lastEventId) return false;
	m.subscribers.add(send);
	for (const b of replay) send(b.seq, b.json);
	return true;
}

export function unsubscribe(m: Managed, send: (seq: number, json: string) => void): void {
	m.subscribers.delete(send);
}

// ---------- 命令执行 ----------

export interface CommandResult {
	ok: boolean;
	error?: string;
	data?: Record<string, unknown>;
}

export async function execute(m: Managed, cmd: AgentCommand): Promise<CommandResult> {
	touch(m);
	try {
		switch (cmd.cmd) {
			case "prepare":
				await ensureSession(m);
				return { ok: true };
			case "prompt": {
				const session = await ensureSession(m);
				const text = (cmd.text ?? "").trim();
				if (!text && !cmd.images?.length) return { ok: false, error: "empty prompt" };
				const opts: Record<string, unknown> = {};
				if (cmd.images?.length) opts.images = cmd.images;
				if (session.isStreaming) opts.streamingBehavior = cmd.behavior ?? "steer";
				await session.prompt(text, opts as never);
				return { ok: true };
			}
			case "steer": {
				const session = await ensureSession(m);
				await session.steer(cmd.text ?? "", cmd.images);
				return { ok: true };
			}
			case "followUp": {
				const session = await ensureSession(m);
				await session.followUp(cmd.text ?? "", cmd.images);
				return { ok: true };
			}
			case "clearQueue": {
				if (!m.session) return { ok: true, data: { steering: [], followUp: [] } };
				const cleared = m.session.clearQueue();
				publish(m, { type: "queue", steering: [], followUp: [], ts: Date.now() });
				return { ok: true, data: cleared };
			}
			case "abort": {
				if (!m.session) return { ok: true };
				await m.session.abort();
				publish(m, { type: "status", isStreaming: false, state: "aborted", ts: Date.now() });
				return { ok: true };
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
				publishModelState(m, session);
				return { ok: true, data: { thinkingLevel: session.thinkingLevel, thinkingLevels: session.getAvailableThinkingLevels() } };
			}
			case "setThinkingLevel": {
				const session = await ensureSession(m);
				const requested = String(cmd.level ?? "medium");
				// 与 pi 终端一致：不支持的档位就近钳制而不是拒绝（非推理模型 → off），并把实际生效值回传
				const effective = clampThinkingLevel(session.model as any, requested as any);
				m.desiredThinkingLevel = requested;
				session.setThinkingLevel(effective as never);
				publishModelState(m, session);
				return { ok: true, data: { requested, thinkingLevel: session.thinkingLevel, clamped: session.thinkingLevel !== requested } };
			}
			case "setToolPreset": {
				const preset = cmd.preset as ToolPreset;
				if (!Object.hasOwn(TOOL_PRESETS, preset)) return { ok: false, error: "invalid tool preset" };
				m.toolPreset = preset;
				// 与 setModel/setThinkingLevel 一致地 ensureSession：冷会话打开即启动 agent，
				// 快照里的工具列表（工具启用情况节）才有真实数据；空闲 10 分钟由 reap 回收。
				const session = await ensureSession(m);
				const allow = TOOL_PRESETS[preset];
				if (allow && allow.length) {
					const all = listAllToolNames(session);
					const active = all.filter((n) => allow.includes(n));
					(session as unknown as { setActiveToolsByName: (n: string[]) => void }).setActiveToolsByName(active);
				} else {
					const all = listAllToolNames(session);
					(session as unknown as { setActiveToolsByName: (n: string[]) => void }).setActiveToolsByName(all);
				}
				publishEnvironmentTrajectory(m, session);
				publish(m, { type: "tools", active: listActiveTools(session), all: listAllToolNames(session), ts: Date.now() });
				return { ok: true };
			}
			case "setActiveTools": {
				const session = await ensureSession(m);
				const wanted = Array.isArray(cmd.names) ? cmd.names.map(String) : [];
				// 与可用集求交集：未知工具名静默丢弃，不放大权限
				const all = listAllToolNames(session);
				const next = wanted.filter((n) => all.includes(n));
				if (next.length === 0) return { ok: false, error: "cannot disable all tools" };
				(session as unknown as { setActiveToolsByName: (n: string[]) => void }).setActiveToolsByName(next);
				publishEnvironmentTrajectory(m, session);
				publish(m, { type: "tools", active: listActiveTools(session), all: listAllToolNames(session), ts: Date.now() });
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
				const session = await ensureSession(m);
				if (session.isStreaming) return { ok: false, error: "session is busy" };
				await withResourceLock(() => session.reload());
				publish(m, { type: "tools", active: listActiveTools(session), all: listAllToolNames(session), ts: Date.now() });
				publishEnvironmentTrajectory(m, session);
				publishResources(m);
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
				lastStep = [e.toolName, (e.preview ?? e.title ?? "").split("\n")[0].slice(0, 80)].filter(Boolean).join(" · ");
				break;
			}
		}
		out[p] = { streaming: m.session.isStreaming, lastStep };
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
