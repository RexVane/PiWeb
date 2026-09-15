"use client";

/**
 * 中央状态：会话列表轮询、当前会话 SSE 订阅、事件折叠（快照→增量）、命令发送。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEventBatcher, type EventBatcher } from "@/lib/event-batcher";
import type {
	GrowthStep,
	SessionSummary,
	TrajEntry,
	WebEvent,
	WebMessage,
	WebSnapshot,
	ToolPreset,
} from "@/lib/types";

export interface ToolCardState {
	name: string;
	args: unknown;
	state: "running" | "done";
	partialResult?: string;
	result?: string;
	isError?: boolean;
	encodingLoss?: boolean;
	/** edit/write 的 unified patch，用于渲染红绿 diff */
	patch?: string;
	/** 服务端事件时间戳：运行中显示已用时长，完成后显示耗时 */
	startedAt?: number;
	endedAt?: number;
}

/** 扩展发来的、需要浏览器应答的对话框（对应 pi RPC 的 extension_ui_request） */
export interface ExtensionDialog {
	id: string;
	method: "select" | "confirm" | "input";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	timeout?: number;
	ts: number;
}

export interface PiWebState {
	snapshot: WebSnapshot | null;
	messages: WebMessage[];
	tools: Record<string, ToolCardState>;
	toolPreset: ToolPreset;
	connected: boolean;
	error: string | null;
	compaction: { phase: "start" | "end"; errorMessage?: string; ts: number } | null;
	/** 自动重试通知（随消息流显示的折叠行，流结束清除） */
	retryNotice: string | null;
	/** 扩展对话框队列（按到达顺序，一次显示一个） */
	extensionDialogs: ExtensionDialog[];
	/** 扩展通知（notify），显示几秒后消失 */
	extensionNotices: { id: string; message: string; type: "info" | "warning" | "error"; ts: number }[];
	/** 扩展设的页脚状态文本（setStatus） */
	extensionStatuses: Record<string, string>;
	/** 扩展覆盖的「工作中」文案（setWorkingMessage） */
	workingMessage: string | null;
	/** 项目生长：本次连接期间收到的步（完整账本由 useGrowth 拉取后合并），以及运行中工具正在生成的路径 */
	growth: { steps: GrowthStep[]; pending: string[]; error: string | null };
}

export interface SessionListItem extends SessionSummary {
	streaming: boolean;
	/** 正在运行的会话最后一个工具步骤（侧栏副标题） */
	lastStep?: string;
}

export const foldPiWebEvent = (state: PiWebState, evt: WebEvent): PiWebState => {
	const s = { ...state };
	switch (evt.type) {
		case "delta": {
			// 新服务端按稳定流 ID 定位；旧协议仍按最近 pending 消息兼容。
			const msgs = [...s.messages];
			let i = evt.messageId ? msgs.findIndex((message) => message.streamId === evt.messageId || message.id === evt.messageId) : msgs.length - 1;
			if (!evt.messageId) while (i >= 0 && msgs[i].role !== "assistant" && msgs[i].role !== "user") i -= 1;
			if (evt.messageId && i >= 0 && msgs[i].stopReason && msgs[i].stopReason !== "pending") return s;
			if (i < 0 || msgs[i].role !== "assistant" || (msgs[i].stopReason ?? "pending") !== "pending") {
				msgs.push({ role: "assistant", content: [], streamId: evt.messageId, stopReason: "pending", timestamp: evt.ts });
				i = msgs.length - 1;
			}
			{
				const m = { ...msgs[i] };
				const content = [...m.content];
				while (content.length <= evt.contentIndex) content.push({ type: "text", text: "" });
				const c: any = { ...content[evt.contentIndex] };
				if (evt.kind === "text" && c.type !== "text") {
					content[evt.contentIndex] = { type: "text", text: evt.delta };
				} else if (evt.kind === "thinking") {
					if (c.type !== "thinking") content[evt.contentIndex] = { type: "thinking", thinking: evt.delta };
					else c.thinking = (c.thinking ?? "") + evt.delta, content[evt.contentIndex] = c;
				} else if (c.type === "text") {
					c.text = (c.text ?? "") + evt.delta;
					content[evt.contentIndex] = c;
				}
				m.content = content;
				msgs[i] = m;
			}
			s.messages = msgs;
			return s;
		}
		case "message": {
			const msgs = [...s.messages];
			const same = msgs.findIndex((message) =>
				(!!evt.message.id && message.id === evt.message.id) ||
				(!!evt.message.streamId && message.streamId === evt.message.streamId));
			if (same >= 0) {
				// snapshot 可能已包含 final，但 SDK 的扩展 message_end 还没返回；不能丢掉权威 end。
				if (evt.phase === "end") msgs[same] = { ...msgs[same], ...evt.message };
				s.messages = msgs;
				return s;
			}
			if (evt.phase === "start") {
				if (evt.message.role === "user" || evt.message.role === "assistant") msgs.push(evt.message);
			} else if (evt.message.role !== "toolResult") {
				// 无稳定流 ID 的旧服务端：只在本轮末尾匹配 pending，不按时间戳覆盖历史消息。
				let index = -1;
				if (!evt.message.streamId) {
					const last = msgs[msgs.length - 1];
					if (evt.message.role === "assistant" && last?.role === "assistant" && (last.stopReason ?? "pending") === "pending") index = msgs.length - 1;
					if (evt.message.role === "user" && last?.role === "user" && !last.id && !last.streamId) index = msgs.length - 1;
				}
				if (index >= 0) msgs[index] = evt.message;
				else msgs.push(evt.message);
			}
			s.messages = msgs;
			return s;
		}
		case "tool": {
			const tools = { ...s.tools };
			const prev = tools[evt.id];
			tools[evt.id] = {
				name: evt.name,
				args: evt.args ?? prev?.args,
				state: evt.state,
				partialResult: evt.partialResult ?? (evt.state === "done" ? undefined : prev?.partialResult),
				result: evt.result ?? prev?.result,
				isError: evt.isError ?? prev?.isError,
				encodingLoss: evt.encodingLoss ?? prev?.encodingLoss,
				patch: evt.patch ?? prev?.patch,
				startedAt: prev?.startedAt ?? evt.ts,
				endedAt: evt.state === "done" ? evt.ts : prev?.endedAt,
			};
			s.tools = tools;
			return s;
		}
		case "queue":
			if (s.snapshot)
				s.snapshot = { ...s.snapshot, queue: { steering: evt.steering, followUp: evt.followUp } };
			return s;
		case "model": {
			if (s.snapshot) {
				const snap = { ...s.snapshot };
				if (evt.model) snap.model = { ...(snap.model ?? { provider: "", id: "", name: "" }), id: evt.model, name: evt.model };
				if (evt.provider && snap.model) snap.model = { ...snap.model, provider: evt.provider };
				if (evt.thinkingLevel) snap.thinkingLevel = evt.thinkingLevel;
				if (evt.thinkingLevels) snap.thinkingLevels = evt.thinkingLevels;
				s.snapshot = snap;
			}
			return s;
		}
		case "usage":
			if (s.snapshot) s.snapshot = { ...s.snapshot, stats: evt.stats, contextUsage: evt.contextUsage };
			return s;
		case "compaction":
			s.compaction = { phase: evt.phase, errorMessage: evt.errorMessage, ts: evt.ts };
			return s;
		case "traj": {
			if (s.snapshot) {
				const traj = [...s.snapshot.trajectory];
				const idx = traj.findIndex((e) => e.seq === evt.entry.seq);
				if (idx >= 0) traj[idx] = evt.entry;
				else traj.push(evt.entry);
				s.snapshot = { ...s.snapshot, trajectory: traj };
			}
			return s;
		}
		case "name":
			if (s.snapshot) s.snapshot = { ...s.snapshot, name: evt.name };
			return s;
		case "tools":
			if (evt.toolPreset) s.toolPreset = evt.toolPreset;
			if (s.snapshot) s.snapshot = {
				...s.snapshot,
				toolPreset: evt.toolPreset ?? s.snapshot.toolPreset,
				customActiveTools: evt.customActiveTools === undefined ? s.snapshot.customActiveTools : evt.customActiveTools,
				tools: { active: evt.active, all: evt.all.map((n) => ({ name: n })) },
			};
			return s;
		case "resources":
			if (s.snapshot) {
				s.snapshot = {
					...s.snapshot,
					skills: evt.skills,
					promptTemplates: evt.promptTemplates,
					extensionCommands: evt.extensionCommands,
					projectTrust: evt.projectTrust,
					resourceDiagnostics: evt.resourceDiagnostics,
				};
			}
			return s;
		case "extension_ui": {
			if (evt.method === "select" || evt.method === "confirm" || evt.method === "input") {
				if (s.extensionDialogs.some((dialog) => dialog.id === evt.id)) return s;
				s.extensionDialogs = [
					...s.extensionDialogs,
					{ id: evt.id, method: evt.method, title: evt.title ?? "", message: evt.message, options: evt.options, placeholder: evt.placeholder, timeout: evt.timeout, ts: evt.ts },
				];
			} else if (evt.method === "notify") {
				s.extensionNotices = [...s.extensionNotices.slice(-4), { id: evt.id, message: evt.message ?? "", type: evt.notifyType ?? "info", ts: evt.ts }];
			} else if (evt.method === "setStatus" && evt.statusKey) {
				const next = { ...s.extensionStatuses };
				if (evt.statusText === undefined || evt.statusText === "") delete next[evt.statusKey];
				else next[evt.statusKey] = evt.statusText;
				s.extensionStatuses = next;
			} else if (evt.method === "setWorkingMessage") {
				s.workingMessage = evt.message ?? null;
			}
			return s;
		}
		case "extension_ui_resolved":
			s.extensionDialogs = s.extensionDialogs.filter((dialog) => dialog.id !== evt.id);
			return s;
		case "status":
			if (s.snapshot) s.snapshot = { ...s.snapshot, isStreaming: evt.isStreaming };
			if (!evt.isStreaming) {
				s.retryNotice = null;
				s.workingMessage = null;
			}
			return s;
		case "growth": {
			const steps = s.growth.steps.some((x) => x.seq === evt.step.seq) ? s.growth.steps.map((x) => (x.seq === evt.step.seq ? evt.step : x)) : [...s.growth.steps, evt.step];
			s.growth = { steps, pending: [], error: null };
			return s;
		}
		case "growth_pending":
			s.growth = { ...s.growth, pending: evt.paths };
			return s;
		case "growth_error":
			s.growth = { ...s.growth, pending: [], error: evt.message };
			return s;
		case "retry":
			// 只保留最后一次尝试：重试过程在界面上是「重试 3/5」这一条，而不是五行报错
			s.retryNotice = evt.maxAttempts
				? `重试 ${evt.attempt}/${evt.maxAttempts}${evt.message ? `：${evt.message}` : ""}`
				: `重试 ${evt.attempt}${evt.message ? `：${evt.message}` : ""}`;
			return s;
		case "error":
			// 旧服务端把自动重试塞在 error 里：同样按通知处理，不占错误条
			if (/^(自动重试|重试)/.test(evt.message)) s.retryNotice = evt.message;
			else s.error = evt.message;
			return s;
		default:
			return s;
	}
};

export function extensionDialogsFromSnapshot(snapshot: WebSnapshot, previous: ExtensionDialog[] = []): ExtensionDialog[] {
	// undefined 仅用于兼容旧服务端；新快照的空数组必须清除已答/取消的旧对话框。
	if (snapshot.extensionUiRequests === undefined) return previous;
	const dialogs = new Map<string, ExtensionDialog>();
	for (const request of snapshot.extensionUiRequests) {
		if (request.method === "select" || request.method === "confirm" || request.method === "input") {
			dialogs.set(request.id, { ...request, method: request.method, title: request.title ?? "" });
		}
	}
	return [...dialogs.values()];
}

function savedToolPreset(): ToolPreset {
	if (typeof window === "undefined") return "standard";
	const saved = localStorage.getItem("piweb.toolPreset");
	return saved === "readonly" || saved === "full" ? saved : "standard";
}

function toolsFromMessages(messages: WebMessage[], streaming = false): Record<string, ToolCardState> {
	const tools: Record<string, ToolCardState> = {};
	const resolved = new Set<string>();
	for (const message of messages) {
		for (const content of message.content) {
			if (content.type === "toolCall") {
				tools[content.id] = { name: content.name, args: content.arguments, state: "done" };
			} else if (content.type === "toolResult" && content.toolCallId && tools[content.toolCallId]) {
				resolved.add(content.toolCallId);
				tools[content.toolCallId] = {
					...tools[content.toolCallId],
					result: content.text,
					isError: content.isError,
					encodingLoss: content.encodingLoss,
					patch: content.patch,
				};
			}
		}
	}
	// 正在流式时还没有结果的调用就是正在执行（中途打开页面拿到的快照），别显示成"已完成 · 无输出"
	if (streaming) {
		for (const [id, tool] of Object.entries(tools)) {
			if (!resolved.has(id)) tools[id] = { ...tool, state: "running", startedAt: Date.now() };
		}
	}
	return tools;
}

const emptyState = (toolPreset: ToolPreset = "standard"): PiWebState => ({
	snapshot: null,
	messages: [],
	tools: {},
	toolPreset,
	connected: false,
	error: null,
	compaction: null,
	retryNotice: null,
	extensionDialogs: [],
	extensionNotices: [],
	extensionStatuses: {},
	workingMessage: null,
	growth: { steps: [], pending: [], error: null },
});

function pathKey(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
		? normalized.toLowerCase()
		: normalized;
}

export function usePiWeb() {
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	const [sessionListError, setSessionListError] = useState<string | null>(null);
	const [sessionListRetryNonce, setSessionListRetryNonce] = useState(0);
	const [currentId, setCurrentId] = useState<string | null>(null);
	const [currentPath, setCurrentPath] = useState<string | null>(null);
	const [state, setState] = useState<PiWebState>(emptyState);
	/** 当前 SSE 连接的增量批量器：按帧合并事件，避免每个 token 一次整树渲染 */
	const batcherRef = useRef<EventBatcher<WebEvent> | null>(null);
	const [models, setModels] = useState<{ providers: any[]; models: any[] } | null>(null);
	const [addedWorkspaces, setAddedWorkspaces] = useState<string[]>([]);
	const [removedWorkspaces, setRemovedWorkspaces] = useState<string[]>([]);
	const [groupBy, setGroupByState] = useState<"workspace" | "flat">("workspace");
	const [orderBy, setOrderByState] = useState<"updated" | "manual">("updated");
	const [resyncNonce, setResyncNonce] = useState(0);
	const [snapshotEpoch, setSnapshotEpoch] = useState(0);
	const esRef = useRef<EventSource | null>(null);
	const promptRequestsRef = useRef(new Set<string>());
	const presetRestoreAttemptRef = useRef<string | null>(null);
	const presetRestorePromiseRef = useRef<Promise<void> | null>(null);
	const activeSessionRef = useRef(currentId);
	activeSessionRef.current = currentId;
	const subscribedSessionRef = useRef<string | null>(null);
	const retrySessionList = useCallback(() => setSessionListRetryNonce((value) => value + 1), []);
	const clearCompaction = useCallback(() => setState((current) => ({ ...current, compaction: null })), []);
	useEffect(() => {
		const notice = state.compaction;
		if (!notice || notice.phase !== "end") return;
		const timer = setTimeout(() => {
			setState((current) => current.compaction?.ts === notice.ts ? { ...current, compaction: null } : current);
		}, 8_000);
		return () => clearTimeout(timer);
	}, [state.compaction]);

	const idOf = useCallback((path: string) => {
		const bytes = new TextEncoder().encode(path);
		let bin = "";
		for (const b of bytes) bin += String.fromCharCode(b);
		return encodeURIComponent(btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
	}, []);

	// 视图偏好持久化
	useEffect(() => {
		const g = localStorage.getItem("piweb.groupBy");
		if (g === "flat" || g === "workspace") setGroupByState(g);
		const o = localStorage.getItem("piweb.orderBy");
		if (o === "updated" || o === "manual") setOrderByState(o);
	}, []);
	const setGroupBy = useCallback((v: "workspace" | "flat") => {
		setGroupByState(v);
		localStorage.setItem("piweb.groupBy", v);
	}, []);
	const setOrderBy = useCallback((v: "updated" | "manual") => {
		setOrderByState(v);
		localStorage.setItem("piweb.orderBy", v);
	}, []);

	const [workspaceAliases, setWorkspaceAliases] = useState<Record<string, string>>({});
	const [archivedSessionPaths, setArchivedSessionPaths] = useState<string[]>([]);

	// 手动添加的工作区与别名、归档
	const refreshWorkspaces = useCallback(async () => {
		try {
			const r = await fetch("/api/workspaces");
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (j.success) {
				if (Array.isArray(j.data.workspaces)) setAddedWorkspaces(j.data.workspaces);
				if (Array.isArray(j.data.removedWorkspaces)) setRemovedWorkspaces(j.data.removedWorkspaces);
				if (j.data.aliases && typeof j.data.aliases === "object") setWorkspaceAliases(j.data.aliases);
				if (Array.isArray(j.data.archivedSessions)) setArchivedSessionPaths(j.data.archivedSessions);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load workspaces";
			setState((current) => ({ ...current, error: message }));
		}
	}, []);
	useEffect(() => {
		refreshWorkspaces();
	}, [refreshWorkspaces]);

	/** 会话改名成功后先把列表里的名字改掉，不等下一次轮询（轮询 3 秒 + 服务端 1.2 秒列表缓存） */
	const patchSessionName = useCallback((sessionPath: string, name: string) => {
		const key = pathKey(sessionPath);
		setSessions((prev) => prev.map((s) => (pathKey(s.path) === key ? { ...s, name } : s)));
	}, []);

	const renameWorkspace = useCallback(async (dir: string, name: string) => {
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "rename", path: dir, name }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (j.data?.aliases) setWorkspaceAliases(j.data.aliases);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to rename workspace";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, []);

	const archiveSession = useCallback(async (sessionPath: string) => {
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "archiveSession", path: sessionPath }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (Array.isArray(j.data?.archivedSessions)) setArchivedSessionPaths(j.data.archivedSessions);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to archive session";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, []);

	const unarchiveSession = useCallback(async (sessionPath: string) => {
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "forgetSession", path: sessionPath }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (Array.isArray(j.data?.archivedSessions)) setArchivedSessionPaths(j.data.archivedSessions);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to unarchive session";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, []);

	const getWorkspaceName = useCallback(
		(dir: string): string => {
			if (!dir) return "";
			const norm = pathKey(dir);
			for (const [k, v] of Object.entries(workspaceAliases)) {
				if (pathKey(k) === norm && v.trim()) {
					return v;
				}
			}
			return dir.split(/[\\/]/).filter(Boolean).pop() || dir;
		},
		[workspaceAliases],
	);



	/** 弹出系统原生文件夹选择器并加入工作区列表；成功返回路径 */
	const addWorkspaceByPicker = useCallback(async (): Promise<string | null> => {
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "pick" }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (j.success && j.data?.path) {
				setAddedWorkspaces(j.data.workspaces ?? []);
				await refreshWorkspaces();
				return j.data.path as string;
			}
			return null;
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to add workspace";
			setState((current) => ({ ...current, error: message }));
			return null;
		}
	}, [refreshWorkspaces]);


	const removeWorkspace = useCallback(
		async (dir: string) => {
			try {
				const r = await fetch("/api/workspaces", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: "remove", path: dir }),
				});
				const j = await r.json();
				if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
				if (j.data) {
					if (Array.isArray(j.data.workspaces)) setAddedWorkspaces(j.data.workspaces);
					if (Array.isArray(j.data.removedWorkspaces)) setRemovedWorkspaces(j.data.removedWorkspaces);
					if (j.data.aliases && typeof j.data.aliases === "object") setWorkspaceAliases(j.data.aliases);
				}
				await refreshWorkspaces();
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to remove workspace";
				setState((current) => ({ ...current, error: message }));
				throw error;
			}
		},
		[refreshWorkspaces],
	);

	// 会话列表轮询（3 秒，多标签同步）；隐藏标签页暂停，单个标签内不会重叠请求。
	useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let controller: AbortController | undefined;
		// 上一次列表的 ETag：内容没变服务端答 304，跳过解析与 setState（侧栏不会每 3 秒白白重渲染一次）
		let lastEtag: string | null = null;
		const schedule = () => {
			if (!alive || document.visibilityState !== "visible") return;
			timer = setTimeout(() => void load(false), 3000);
		};
		const load = async (force: boolean) => {
			if (!alive || (!force && document.visibilityState !== "visible")) return;
			controller = new AbortController();
			try {
				const r = await fetch("/api/sessions", { signal: controller.signal, headers: lastEtag ? { "If-None-Match": lastEtag } : undefined });
				if (r.status === 304) {
					if (alive) setSessionListError(null);
					return;
				}
				const j = await r.json();
				if (!alive) return;
				if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
				setSessionListError(null);
				lastEtag = r.headers.get("etag");
				const running: Record<string, { streaming: boolean; lastStep?: string }> = j.data.running ?? {};
				const registry = j.data.workspaceRegistry;
				if (registry) {
					if (Array.isArray(registry.workspaces)) setAddedWorkspaces(registry.workspaces);
					if (Array.isArray(registry.removedWorkspaces)) setRemovedWorkspaces(registry.removedWorkspaces);
					if (registry.aliases && typeof registry.aliases === "object") setWorkspaceAliases(registry.aliases);
					if (Array.isArray(registry.archivedSessions)) setArchivedSessionPaths(registry.archivedSessions);
				}
				setSessions(
					(j.data.sessions as SessionSummary[]).map((s) => ({ ...s, streaming: running[s.path]?.streaming === true, lastStep: running[s.path]?.lastStep })),
				);
			} catch (error) {
				if (alive && !(error instanceof DOMException && error.name === "AbortError"))
					setSessionListError(error instanceof Error ? error.message : "session list request failed");
			} finally {
				controller = undefined;
				schedule();
			}
		};
		const onVisibilityChange = () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			controller?.abort();
			if (document.visibilityState === "visible") void load(false);
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		void load(true);
		return () => {
			alive = false;
			if (timer) clearTimeout(timer);
			controller?.abort();
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [sessionListRetryNonce]);

	// 模型目录
	const refreshModels = useCallback(async () => {
		try {
			const r = await fetch("/api/models");
			const j = await r.json();
			if (j.success) setModels({ providers: j.data.providers, models: j.data.models });
		} catch {
			/* ignore */
		}
	}, []);
	useEffect(() => {
		refreshModels();
	}, [refreshModels]);

	// SSE 订阅当前会话（resyncNonce 变化时强制重连取新快照）
	useEffect(() => {
		esRef.current?.close();
		esRef.current = null;
		if (!currentId) {
			subscribedSessionRef.current = null;
			setState(emptyState(savedToolPreset()));
			return;
		}
		const reconnectingCurrentSession = subscribedSessionRef.current === currentId;
		subscribedSessionRef.current = currentId;
		setState((current) => reconnectingCurrentSession
			? { ...current, connected: false }
			: { ...emptyState(savedToolPreset()), connected: false });
		let retryDelayMs = 2000;
		const connect = () => {
			const es = new EventSource(`/api/agent/${currentId}/events`);
			esRef.current = es;
			es.onopen = () => {
				setState((s) => ({ ...s, connected: true }));
			};
			es.onerror = () => {
				setState((s) => ({ ...s, connected: false }));
				// 浏览器对非 200 响应会永久放弃 EventSource 自动重连
				// （网络断连才会重试），这里手动兜底：关掉后延迟重建，
				// 重建时会拿到全新快照，不依赖 Last-Event-ID 回放。
				if (esRef.current !== es) return;
				es.close();
				esRef.current = null;
				const delay = retryDelayMs;
				retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
				retryTimer = setTimeout(() => {
					if (esRef.current === null) connect();
				}, delay);
			};
			// 流式事件按帧合并：token 速率再高也只每 16ms 渲染一次（见 event-batcher）
			const batcher = createEventBatcher<WebEvent>({
				flush: (events) => setState((s) => events.reduce((acc, evt) => foldPiWebEvent(acc, evt), s)),
			});
			batcherRef.current = batcher;
			es.onmessage = (e) => {
				let parsed: any;
				try {
					parsed = JSON.parse(e.data);
				} catch {
					// 单帧损坏（代理截断等）只丢弃该帧，不能让 EventSource 回调抛异常
					return;
				}
				if (parsed.type === "snapshot" && parsed.snapshot) {
					// 快照是权威状态：之前缓冲的增量已经过时，直接丢弃
					batcher.cancel();
					retryDelayMs = 2000;
					const snap = parsed.snapshot as WebSnapshot;
					setSnapshotEpoch((epoch) => epoch + 1);
					setState((prev) => ({
						snapshot: snap,
						messages: snap.messages,
						tools: toolsFromMessages(snap.messages, snap.isStreaming),
						toolPreset: snap.toolPreset,
						connected: true,
						error: null,
						compaction: null,
						retryNotice: null,
						// 服务器当前 pending 集合是权威来源，刷新可恢复、已答请求不能复活。
						extensionDialogs: extensionDialogsFromSnapshot(snap, prev.extensionDialogs),
						extensionNotices: prev.extensionNotices,
						extensionStatuses: {},
						workingMessage: null,
						// 重连的快照不带生长账本；连接期间已收到的步保留，useGrowth 会按 seq 与拉取结果去重
						growth: { ...prev.growth, error: snap.growthError ?? null },
					}));
				} else {
					batcher.push(parsed as WebEvent);
				}
			};
		};
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		connect();
		return () => {
			batcherRef.current?.cancel();
			batcherRef.current = null;
			if (retryTimer) clearTimeout(retryTimer);
			esRef.current?.close();
			esRef.current = null;
		};
	}, [currentId, resyncNonce]);

	const sendCommand = useCallback(async (cmd: Record<string, unknown>, id?: string): Promise<any> => {
		const target = id ?? currentId;
		if (!target) {
			setState((s) => ({ ...s, error: "no session" }));
			return { success: false, error: "no session" };
		}
		const isPrompt = cmd.cmd === "prompt";
		if (isPrompt && promptRequestsRef.current.has(target)) return { success: false, error: "prompt acceptance pending" };
		if (isPrompt) promptRequestsRef.current.add(target);
		try {
			const r = await fetch(`/api/agent/${target}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(cmd),
			});
			const result = await r.json();
			if (!r.ok || !result.success) setState((s) => ({ ...s, error: result.error || `request failed (${r.status})` }));
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : "request failed";
			setState((s) => ({ ...s, error: message }));
			return { success: false, error: message };
		} finally {
			if (isPrompt) promptRequestsRef.current.delete(target);
		}
	}, [currentId]);

	const newSession = useCallback(async (
		cwd: string,
		overrides: { provider?: string; modelId?: string; thinking?: string } = {},
	): Promise<string | null> => {
		try {
			const r = await fetch("/api/agent/new", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd }),
			});
			const j = await r.json();
			if (j.success) {
				const p = j.data.sessionPath as string;
				const id = idOf(p);
				// 工具预设取通用设置的持久化选择；模型/思考级别由 Hero 页显式下发
				const setup: Record<string, unknown>[] = [{ cmd: "setToolPreset", preset: savedToolPreset() }];
				if (overrides.provider && overrides.modelId) setup.push({ cmd: "setModel", provider: overrides.provider, modelId: overrides.modelId });
				if (overrides.thinking) setup.push({ cmd: "setThinkingLevel", level: overrides.thinking });
				for (const command of setup) {
					const configured = await sendCommand(command, id);
					if (!configured.success) {
						// 思考级别与模型不兼容（如非推理模型只支持 off）时降级跳过，
						// 不能因此删掉整个会话让用户毫无提示。
						if (command.cmd === "setThinkingLevel") continue;
						await fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
						return null;
					}
				}
				setCurrentPath(p);
				setCurrentId(id);
				try {
					localStorage.setItem("piweb.currentSession", p);
				} catch {
					/* ignore */
				}
				return p;
			}
			setState((s) => ({ ...s, error: j.error || "failed to create session" }));
			return null;
		} catch (error) {
			setState((s) => ({ ...s, error: error instanceof Error ? error.message : "failed to create session" }));
			return null;
		}
	}, [idOf, sendCommand]);

	const openSession = useCallback(
		(path: string) => {
			setCurrentPath(path);
			setCurrentId(idOf(path));
			// 持久化当前会话：刷新页面时恢复到这里，而不是回到新会话草稿
			try {
				localStorage.setItem("piweb.currentSession", path);
			} catch {
				/* ignore */
			}
		},
		[idOf],
	);

	const closeSession = useCallback(() => {
		setCurrentId(null);
		setCurrentPath(null);
		try {
			localStorage.removeItem("piweb.currentSession");
		} catch {
			/* ignore */
		}
	}, []);

	// 刷新恢复：会话列表首次加载后，若刷新前有打开的会话且仍存在，则重新打开
	const restoredRef = useRef(false);
	useEffect(() => {
		if (restoredRef.current || !sessions.length) return;
		restoredRef.current = true;
		try {
			const saved = localStorage.getItem("piweb.currentSession");
			if (saved) {
				if (sessions.some((s) => s.path === saved)) {
					// 标记本次 currentPath 来自刷新恢复：侧栏据此跳过"自动展开其工作区"
					sessionStorage.setItem("piweb.sessionRestored", "1");
					openSession(saved);
				} else localStorage.removeItem("piweb.currentSession");
			}
		} catch {
			/* ignore */
		}
	}, [sessions, openSession]);

	const setToolPreset = useCallback(
		async (preset: ToolPreset) => {
			await presetRestorePromiseRef.current;
			if (activeSessionRef.current !== currentId) return;
			if (currentId) {
				const result = await sendCommand({ cmd: "setToolPreset", preset });
				if (!result?.success) return;
			}
			localStorage.setItem("piweb.toolPreset", preset);
			if (activeSessionRef.current === currentId) setState((s) => ({
				...s,
				toolPreset: preset,
				snapshot: s.snapshot ? { ...s.snapshot, toolPreset: preset } : null,
			}));
		},
		[currentId, sendCommand],
	);

	// ---------- 会话预设已移除：工具档位见通用设置/工具启用情况，模型与思考级别由 Hero 页显式下发 ----------

	/** 强制重连 SSE 拿新快照（navigate 等场景） */
	const resync = useCallback(() => setResyncNonce((n) => n + 1), []);
	/** 应答扩展对话框（select/confirm/input）；cancelled=true 表示用户关掉了 */
	const answerExtensionDialog = useCallback(
		async (id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
			setState((s) => ({ ...s, extensionDialogs: s.extensionDialogs.filter((d) => d.id !== id) }));
			const target = currentId;
			const result = await sendCommand({ cmd: "extensionUiResponse", requestId: id, ...response });
			if (!result?.success && activeSessionRef.current === target) resync();
		},
		[currentId, resync, sendCommand],
	);
	const dismissExtensionNotice = useCallback((id: string) => setState((s) => ({ ...s, extensionNotices: s.extensionNotices.filter((n) => n.id !== id) })), []);
	const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);
	/** 供 AppShell 直接展示行内提示（如未选工作区就发送） */
	const setError = useCallback((message: string) => setState((s) => ({ ...s, error: message })), []);

	// 工具权限不写入 Pi JSONL。每次收到服务端快照后恢复本地选择；运行中延后到空闲。
	useEffect(() => {
		if (!currentId || !state.connected || !state.snapshot || state.snapshot.isStreaming || state.snapshot.customActiveTools != null) return;
		const preset = savedToolPreset();
		if (state.snapshot.toolPreset === preset) return;
		const attemptKey = `${currentId}:${snapshotEpoch}`;
		if (presetRestoreAttemptRef.current === attemptKey) return;
		presetRestoreAttemptRef.current = attemptKey;
		const sessionId = currentId;
		const restore = sendCommand({ cmd: "setToolPreset", preset }).then((result) => {
			if (result?.success && activeSessionRef.current === sessionId && savedToolPreset() === preset) setState((current) => ({
				...current,
				toolPreset: preset,
				snapshot: current.snapshot ? { ...current.snapshot, toolPreset: preset } : null,
			}));
		}).finally(() => {
			if (presetRestorePromiseRef.current === restore) presetRestorePromiseRef.current = null;
		});
		presetRestorePromiseRef.current = restore;
	}, [currentId, snapshotEpoch, state.connected, state.snapshot, sendCommand]);

	// 会话可见性规则：归档即离开工作区列表——包括当前会话（归档后切到相邻会话或空态），
	// 归档区显示全部已归档会话。
	const visibleSessions = useMemo(() => {
		const set = new Set(archivedSessionPaths.map(pathKey));
		return sessions.filter((s) => !set.has(pathKey(s.path)));
	}, [sessions, archivedSessionPaths]);
	const archivedSessions = useMemo(() => {
		const set = new Set(archivedSessionPaths.map(pathKey));
		return sessions.filter((s) => set.has(pathKey(s.path)));
	}, [sessions, archivedSessionPaths]);

	return {
		sessions: visibleSessions,
		sessionListError,
		retrySessionList,
		archivedSessions,
		/** 原始归档路径列表（含被豁免的当前会话，供菜单显示真实归档态） */
		archivedSessionPaths,
		currentId,
		currentPath,
		state,
		models,
		addedWorkspaces,
		removedWorkspaces,
		workspaceAliases,
		getWorkspaceName,
		renameWorkspace,
		patchSessionName,
		archiveSession,
		unarchiveSession,
		resync,
		groupBy,
		orderBy,
		setGroupBy,
		setOrderBy,
		addWorkspaceByPicker,
		removeWorkspace,
		refreshModels,
		sendCommand,
		newSession,
		openSession,
		closeSession,
		setToolPreset,
		clearError,
		clearCompaction,
		setError,
		answerExtensionDialog,
		dismissExtensionNotice,
	};
}
