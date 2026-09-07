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
	TOOL_PRESETS,
	SessionManager,
	createAgentSession,
	getModelRuntime,
	openSessionManager,
} from "./pi";
import { TrajLedger, buildTrajectoryFromEntries, toTrajTokens } from "./trajectory";
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

export function toWebMessage(m: any): WebMessage {
	if (!m || typeof m !== "object") return { role: "other", content: [] };
	const out: WebMessage = { role: "other", content: [] };
	if (typeof m.id === "string") out.id = m.id;
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
		out.content = [{ type: "toolResult", toolCallId: m.toolCallId, text: textOf(m.content), isError: m.isError === true }];
	}
	return out;
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

function publishTraj(m: Managed): void {
	for (const entry of m.ledger.drainDirty()) {
		publish(m, { type: "traj", entry, ts: Date.now() });
	}
}

function publishUsage(m: Managed): void {
	if (!m.session) return;
	let stats: WebStats | null = null;
	try {
		const s = m.session.getSessionStats();
		stats = {
			userMessages: s.userMessages,
			assistantMessages: s.assistantMessages,
			toolCalls: s.toolCalls,
			totalMessages: s.totalMessages,
			tokens: s.tokens,
			cost: s.cost,
		};
	} catch {
		stats = null;
	}
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
			const msg = toWebMessage((evt as any).message);
			if (msg.role === "user" || msg.role === "assistant") {
				publish(m, { type: "message", message: msg, phase: "start", ts: now });
			}
			break;
		}
		case "message_update": {
			const e: any = (evt as any).assistantMessageEvent;
			if (!e) break;
			if (e.type === "text_delta" && typeof e.delta === "string") {
				publish(m, { type: "delta", kind: "text", contentIndex: e.contentIndex, delta: e.delta, ts: now });
			} else if (e.type === "thinking_delta" && typeof e.delta === "string") {
				publish(m, { type: "delta", kind: "thinking", contentIndex: e.contentIndex, delta: e.delta, ts: now });
			}
			break;
		}
		case "message_end": {
			const msg = toWebMessage((evt as any).message);
			publish(m, { type: "message", message: msg, phase: "end", ts: now });
			publishUsage(m);
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
		case "tool_execution_update":
			publish(m, {
				type: "tool",
				id: evt.toolCallId,
				name: evt.toolName,
				args: (evt as any).args,
				state: "running",
				partialResult: coercePartial((evt as any).partialResult),
				ts: now,
			});
			break;
		case "tool_execution_end":
			publish(m, {
				type: "tool",
				id: evt.toolCallId,
				name: evt.toolName,
				args: (evt as any).args,
				state: "done",
				result: coercePartial((evt as any).result),
				isError: evt.isError,
				ts: now,
			});
			publishUsage(m);
			break;
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
			publish(m, { type: "model", thinkingLevel: (evt as any).level, ts: now });
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
		let initialTrajectory: TrajEntry[] = [];
		try {
			initialTrajectory = buildTrajectoryFromEntries(sm.getEntries() as unknown as any[]);
		} catch {
			/* A damaged history can still be opened; live events start a fresh ledger. */
		}
		m = {
			sessionPath,
			cwd: sm.getCwd() || process.cwd(),
			sm,
			session: null,
			creating: null,
			subscribers: new Set(),
			buffer: [],
			seq: 0,
			ledger: new TrajLedger(initialTrajectory),
			lastActive: Date.now(),
			toolPreset: "standard",
		};
		sessions.set(sessionPath, m);
	}
	touch(m);
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
			const preset = TOOL_PRESETS[m.toolPreset];
			const { session } = await createAgentSession({
				cwd: m.cwd,
				sessionManager: m.sm,
				modelRuntime: await getModelRuntime(),
				resourceLoader: getResourceLoader(m.cwd),
				settingsManager: getSettingsManager(m.cwd),
				...(preset && preset.length ? { tools: [...preset] } : {}),
			});
			session.subscribe((evt) => translate(m, evt));
			m.session = session;
			publishEnvironmentTrajectory(m, session);
			publish(m, {
				type: "tools",
				active: listActiveTools(session),
				all: listAllToolNames(session),
				ts: Date.now(),
			});
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
	const active = (session as unknown as { getActiveTools?: () => Array<{ name: string }> }).getActiveTools?.();
	return active ? active.map((t) => t.name) : [];
}

export function disposeSession(m: Managed): void {
	try {
		m.session?.dispose();
	} catch {
		/* ignore */
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

// ---------- 快照 ----------

export async function buildSnapshot(m: Managed): Promise<WebSnapshot> {
	touch(m);
	const session = m.session;
	let messages: WebMessage[] = [];
	let model: WebSnapshot["model"];
	let thinkingLevel: string | undefined;
	let isStreaming = false;
	let thinkingLevels: string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	if (session) {
		messages = session.messages.map(toWebMessage);
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
				.map((e: any) => toWebMessage(e.message));
		} catch {
			messages = [];
		}
		try {
			const anySm = m.sm as unknown as { buildSessionContext?: () => { model?: { provider: string; modelId: string } | null; thinkingLevel?: string } };
			const ctx = anySm.buildSessionContext?.();
			if (ctx?.model) model = { provider: ctx.model.provider, id: ctx.model.modelId, name: ctx.model.modelId };
			thinkingLevel = ctx?.thinkingLevel;
		} catch {
			/* ignore */
		}
	}

	let stats: WebStats | null = null;
	let contextUsage: WebSnapshot["contextUsage"] = null;
	if (session) {
		try {
			const s = session.getSessionStats();
			stats = {
				userMessages: s.userMessages,
				assistantMessages: s.assistantMessages,
				toolCalls: s.toolCalls,
				totalMessages: s.totalMessages,
				tokens: s.tokens,
				cost: s.cost,
			};
		} catch {
			stats = null;
		}
		const usage = session.getContextUsage() ?? null;
		contextUsage = usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : null;
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

	// 斜杠命令数据源：prompt 模板 + 技能
	let promptTemplates: { name: string; description: string }[] = [];
	let skills: { name: string; description: string }[] = [];
	try {
		const pts: any[] = session
			? ((session as unknown as { promptTemplates: any[] }).promptTemplates ?? [])
			: getResourceLoader(m.cwd).getPrompts().prompts;
		promptTemplates = pts.map((p: any) => ({ name: String(p.name ?? ""), description: String(p.description ?? "") }));
	} catch {
		promptTemplates = [];
	}
	try {
		const { skills: sk } = getResourceLoader(m.cwd).getSkills();
		skills = sk.map((s: any) => ({ name: String(s.name ?? ""), description: String(s.description ?? "") }));
	} catch {
		skills = [];
	}

	const baseTrajectory = m.ledger.entries.length ? m.ledger.entries : coldTrajectory(m);
	const trajectory = [...environmentTrajectory(m, session), ...baseTrajectory];

	return {
		seq: m.seq,
		sessionPath: m.sessionPath,
		cwd: m.cwd,
		name,
		contextFiles: contextResources.map((resource) => resource.path),
		contextResources,
		promptTemplates,
		skills,
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
				publish(m, {
					type: "model",
					provider: String(model.provider),
					model: String(model.id),
					thinkingLevel: String(session.thinkingLevel ?? ""),
					ts: Date.now(),
				});
				return { ok: true };
			}
			case "setThinkingLevel": {
				const session = await ensureSession(m);
				if (!session.getAvailableThinkingLevels().includes(cmd.level as never)) {
					return { ok: false, error: `unsupported thinking level ${cmd.level}` };
				}
				session.setThinkingLevel((cmd.level ?? "medium") as never);
				publish(m, { type: "model", thinkingLevel: cmd.level, ts: Date.now() });
				return { ok: true };
			}
			case "setToolPreset": {
				const preset = cmd.preset as ToolPreset;
				if (!Object.hasOwn(TOOL_PRESETS, preset)) return { ok: false, error: "invalid tool preset" };
				m.toolPreset = preset;
				if (m.session) {
					const session = m.session;
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
				}
				return { ok: true };
			}
			case "cycleModel": {
				const session = await ensureSession(m);
				const r = await session.cycleModel(cmd.direction ?? "forward");
				if (r?.model) {
					publish(m, {
						type: "model",
						provider: String((r.model as any).provider ?? ""),
						model: String((r.model as any).id ?? ""),
						thinkingLevel: String(r.thinkingLevel ?? session.thinkingLevel ?? ""),
						ts: Date.now(),
					});
					return { ok: true, data: { model: String((r.model as any).id ?? "") } };
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
			case "fork": {
				const { SessionManager } = await import("@earendil-works/pi-coding-agent");
				const forked = SessionManager.forkFrom(m.sessionPath, m.cwd);
				const newPath = forked.getSessionFile() ?? "";
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
	getManaged(p); // 预注册
	return { sessionPath: p };
}

/** 活跃会话状态（给侧栏状态点用） */
export function activeStatus(): Record<string, { streaming: boolean }> {
	const out: Record<string, { streaming: boolean }> = {};
	for (const [p, m] of sessions) {
		if (m.session) out[p] = { streaming: m.session.isStreaming };
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
	const content = await session.exportToHtml();
	return { filename: base.replace(/\.jsonl$/, ".html"), content, contentType: "text/html" };
}
