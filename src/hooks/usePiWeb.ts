"use client";

/**
 * 中央状态：会话列表轮询、当前会话 SSE 订阅、事件折叠（快照→增量）、命令发送。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
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
}

export interface PiWebState {
	snapshot: WebSnapshot | null;
	messages: WebMessage[];
	tools: Record<string, ToolCardState>;
	toolPreset: ToolPreset;
	connected: boolean;
	error: string | null;
}

export interface SessionListItem extends SessionSummary {
	streaming: boolean;
}

const fold = (state: PiWebState, evt: WebEvent): PiWebState => {
	const s = { ...state };
	switch (evt.type) {
		case "delta": {
			// 增量追加到最后一条 assistant 消息的 content[contentIndex]
			const msgs = [...s.messages];
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i].role === "assistant") {
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
					break;
				}
			}
			s.messages = msgs;
			return s;
		}
		case "message": {
			const msgs = [...s.messages];
			if (evt.phase === "start") {
				if (evt.message.role === "assistant") {
					// 追加占位 assistant（或复用最后一个空的）
					const last = msgs[msgs.length - 1];
					if (last?.role === "assistant" && last.content.length === 0) {
						msgs[msgs.length - 1] = evt.message;
					} else msgs.push(evt.message);
				} else if (evt.message.role === "user") {
					const last = msgs[msgs.length - 1];
					if (last?.role !== "user") msgs.push(evt.message);
				}
			} else {
				// end：替换最后一条同角色消息（权威版本）
				const role = evt.message.role;
				for (let i = msgs.length - 1; i >= 0; i--) {
					if (msgs[i].role === role) {
						if (role === "toolResult") break;
						msgs[i] = evt.message;
						break;
					}
				}
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
			};
			s.tools = tools;
			return s;
		}
		case "status":
			if (s.snapshot) s.snapshot = { ...s.snapshot, isStreaming: evt.isStreaming };
			return s;
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
				s.snapshot = snap;
			}
			return s;
		}
		case "usage":
			if (s.snapshot) s.snapshot = { ...s.snapshot, stats: evt.stats, contextUsage: evt.contextUsage };
			return s;
		case "compaction":
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
			if (s.snapshot) s.snapshot = { ...s.snapshot, tools: { active: evt.active, all: evt.all.map((n) => ({ name: n })) } };
			return s;
		case "error":
			s.error = evt.message;
			return s;
		default:
			return s;
	}
};

function savedToolPreset(): ToolPreset {
	if (typeof window === "undefined") return "standard";
	const saved = localStorage.getItem("piweb.toolPreset");
	return saved === "readonly" || saved === "full" ? saved : "standard";
}

function toolsFromMessages(messages: WebMessage[]): Record<string, ToolCardState> {
	const tools: Record<string, ToolCardState> = {};
	for (const message of messages) {
		for (const content of message.content) {
			if (content.type === "toolCall") {
				tools[content.id] = { name: content.name, args: content.arguments, state: "done" };
			} else if (content.type === "toolResult" && content.toolCallId && tools[content.toolCallId]) {
				tools[content.toolCallId] = {
					...tools[content.toolCallId],
					result: content.text,
					isError: content.isError,
				};
			}
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
});

export interface SessionPreset {
	name: string;
	tool: ToolPreset;
	provider?: string;
	modelId?: string;
	thinking?: string;
}

const BUILTIN_PRESETS: SessionPreset[] = [
	{ name: "standard", tool: "standard" },
	{ name: "readonly", tool: "readonly" },
	{ name: "full", tool: "full" },
];

function loadPresets(): { all: SessionPreset[]; custom: SessionPreset[]; active: string } {
	let custom: SessionPreset[] = [];
	try {
		const raw = JSON.parse(localStorage.getItem("piweb.presets") ?? "[]");
		if (Array.isArray(raw)) custom = raw.filter((p) => p && typeof p.name === "string");
	} catch {
		/* ignore */
	}
	return { all: [...BUILTIN_PRESETS, ...custom], custom, active: localStorage.getItem("piweb.activePreset") ?? "standard" };
}

export function usePiWeb() {
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	const [currentId, setCurrentId] = useState<string | null>(null);
	const [currentPath, setCurrentPath] = useState<string | null>(null);
	const [state, setState] = useState<PiWebState>(emptyState);
	const [models, setModels] = useState<{ providers: any[]; models: any[] } | null>(null);
	const [addedWorkspaces, setAddedWorkspaces] = useState<string[]>([]);
	const [removedWorkspaces, setRemovedWorkspaces] = useState<string[]>([]);
	const [groupBy, setGroupByState] = useState<"workspace" | "flat">("workspace");
	const [orderBy, setOrderByState] = useState<"updated" | "manual">("updated");
	const [presets, setPresetsState] = useState<{ all: SessionPreset[]; custom: SessionPreset[]; active: string }>({
		all: BUILTIN_PRESETS,
		custom: [],
		active: "standard",
	});
	const [resyncNonce, setResyncNonce] = useState(0);
	const esRef = useRef<EventSource | null>(null);

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
	const [archivedSessions, setArchivedSessions] = useState<string[]>([]);

	// 手动添加的工作区与别名、归档
	const refreshWorkspaces = useCallback(async () => {
		try {
			const r = await fetch("/api/workspaces");
			const j = await r.json();
			if (j.success) {
				if (Array.isArray(j.data.workspaces)) setAddedWorkspaces(j.data.workspaces);
				if (Array.isArray(j.data.removedWorkspaces)) setRemovedWorkspaces(j.data.removedWorkspaces);
				if (j.data.aliases && typeof j.data.aliases === "object") setWorkspaceAliases(j.data.aliases);
				if (Array.isArray(j.data.archivedSessions)) setArchivedSessions(j.data.archivedSessions);
			}
		} catch {
			/* ignore */
		}
	}, []);
	useEffect(() => {
		refreshWorkspaces();
	}, [refreshWorkspaces]);

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
			if (Array.isArray(j.data?.archivedSessions)) setArchivedSessions(j.data.archivedSessions);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to archive session";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, []);

	const getWorkspaceName = useCallback(
		(dir: string): string => {
			if (!dir) return "";
			const norm = dir.replace(/\\/g, "/").toLowerCase();
			for (const [k, v] of Object.entries(workspaceAliases)) {
				if (k.replace(/\\/g, "/").toLowerCase() === norm && v.trim()) {
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
			if (j.success && j.data?.path) {
				setAddedWorkspaces(j.data.workspaces ?? []);
				await refreshWorkspaces();
				return j.data.path as string;
			}
			return null;
		} catch {
			return null;
		}
	}, [refreshWorkspaces]);

	const removeWorkspace = useCallback(
		async (dir: string) => {
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
		},
		[refreshWorkspaces],
	);

	// 会话列表轮询（3 秒，多标签同步）；隐藏标签页暂停，单个标签内不会重叠请求。
	useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let controller: AbortController | undefined;
		const schedule = () => {
			if (!alive || document.visibilityState !== "visible") return;
			timer = setTimeout(() => void load(false), 3000);
		};
		const load = async (force: boolean) => {
			if (!alive || (!force && document.visibilityState !== "visible")) return;
			controller = new AbortController();
			try {
				const r = await fetch("/api/sessions", { signal: controller.signal });
				const j = await r.json();
				if (!alive || !j.success) return;
				const running: Record<string, { streaming: boolean }> = j.data.running ?? {};
				const registry = j.data.workspaceRegistry;
				if (registry) {
					if (Array.isArray(registry.workspaces)) setAddedWorkspaces(registry.workspaces);
					if (Array.isArray(registry.removedWorkspaces)) setRemovedWorkspaces(registry.removedWorkspaces);
					if (registry.aliases && typeof registry.aliases === "object") setWorkspaceAliases(registry.aliases);
					if (Array.isArray(registry.archivedSessions)) setArchivedSessions(registry.archivedSessions);
				}
				setSessions(
					(j.data.sessions as SessionSummary[]).map((s) => ({ ...s, streaming: running[s.path]?.streaming === true })),
				);
			} catch (error) {
				if (!(error instanceof DOMException && error.name === "AbortError")) {
					/* A later poll retries transient list failures. */
				}
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
	}, []);

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
			setState(emptyState(savedToolPreset()));
			return;
		}
		setState({ ...emptyState(savedToolPreset()), connected: false });
		const es = new EventSource(`/api/agent/${currentId}/events`);
		esRef.current = es;
		es.onopen = () => setState((s) => ({ ...s, connected: true }));
		es.onerror = () => setState((s) => ({ ...s, connected: false }));
		es.onmessage = (e) => {
			const parsed = JSON.parse(e.data) as any;
			if (parsed.type === "snapshot" && parsed.snapshot) {
				const snap = parsed.snapshot as WebSnapshot;
				setState({
					snapshot: snap,
					messages: snap.messages,
					tools: toolsFromMessages(snap.messages),
					toolPreset: savedToolPreset(),
					connected: true,
					error: null,
				});
			} else {
				setState((s) => fold(s, parsed as WebEvent));
			}
		};
		return () => {
			es.close();
			esRef.current = null;
		};
	}, [currentId, resyncNonce]);

	const sendCommand = useCallback(async (cmd: Record<string, unknown>, id?: string): Promise<any> => {
		const target = id ?? currentId;
		if (!target) {
			setState((s) => ({ ...s, error: "no session" }));
			return { success: false, error: "no session" };
		}
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
				const { all, active } = loadPresets();
				const preset = all.find((item) => item.name === active) ?? BUILTIN_PRESETS[0];
				const setup: Record<string, unknown>[] = [{ cmd: "setToolPreset", preset: preset.tool }];
				const provider = overrides.provider ?? preset.provider;
				const modelId = overrides.modelId ?? preset.modelId;
				const thinking = overrides.thinking ?? preset.thinking;
				if (provider && modelId) setup.push({ cmd: "setModel", provider, modelId });
				if (thinking) setup.push({ cmd: "setThinkingLevel", level: thinking });
				for (const command of setup) {
					const configured = await sendCommand(command, id);
					if (!configured.success) {
						await fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
						return null;
					}
				}
				setCurrentPath(p);
				setCurrentId(id);
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
		},
		[idOf],
	);

	const closeSession = useCallback(() => {
		setCurrentId(null);
		setCurrentPath(null);
	}, []);

	const setToolPreset = useCallback(
		(preset: ToolPreset) => {
			localStorage.setItem("piweb.toolPreset", preset);
			setState((s) => ({ ...s, toolPreset: preset }));
			if (currentId) void sendCommand({ cmd: "setToolPreset", preset });
		},
		[currentId, sendCommand],
	);

	// ---------- 会话预设 ----------
	const refreshPresets = useCallback(() => setPresetsState(loadPresets()), []);
	const setActivePreset = useCallback(
		(name: string) => {
			localStorage.setItem("piweb.activePreset", name);
			refreshPresets();
			const { all } = loadPresets();
			const p = all.find((x) => x.name === name);
			if (!p) return;
			localStorage.setItem("piweb.toolPreset", p.tool);
			if (currentId) {
				void (async () => {
					await sendCommand({ cmd: "setToolPreset", preset: p.tool });
					if (p.provider && p.modelId) await sendCommand({ cmd: "setModel", provider: p.provider, modelId: p.modelId });
					if (p.thinking) await sendCommand({ cmd: "setThinkingLevel", level: p.thinking });
				})();
			}
			refreshModels();
		},
		[currentId, sendCommand, refreshPresets, refreshModels],
	);
	useEffect(() => {
		refreshPresets();
		const changed = () => {
			const next = loadPresets();
			setPresetsState(next);
			setActivePreset(next.active);
		};
		window.addEventListener("piweb.presetsChanged", changed);
		return () => window.removeEventListener("piweb.presetsChanged", changed);
	}, [refreshPresets, setActivePreset]);

	const saveCustomPresets = useCallback((custom: SessionPreset[]) => {
		localStorage.setItem("piweb.presets", JSON.stringify(custom));
	}, []);

	const addPreset = useCallback(
		(p: SessionPreset) => {
			const { custom } = loadPresets();
			const next = [...custom.filter((x) => x.name !== p.name), p];
			saveCustomPresets(next);
			refreshPresets();
			setActivePreset(p.name);
		},
		[saveCustomPresets, refreshPresets, setActivePreset],
	);

	const removePreset = useCallback(
		(name: string) => {
			const { custom, active } = loadPresets();
			saveCustomPresets(custom.filter((x) => x.name !== name));
			refreshPresets();
			if (active === name) setActivePreset("standard");
		},
		[saveCustomPresets, refreshPresets, setActivePreset],
	);

	/** 强制重连 SSE 拿新快照（navigate 等场景） */
	const resync = useCallback(() => setResyncNonce((n) => n + 1), []);
	const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

	// 工具权限是 PiWeb 的会话护栏，不写入 Pi JSONL；恢复会话时只重放此项，不覆盖模型与思考级别。
	useEffect(() => {
		if (currentId) void sendCommand({ cmd: "setToolPreset", preset: savedToolPreset() });
	}, [currentId, sendCommand]);

	const visibleSessions = useMemo(() => {
		const set = new Set(archivedSessions.map((p) => p.replace(/\\/g, "/").toLowerCase()));
		return sessions.filter((s) => !set.has(s.path.replace(/\\/g, "/").toLowerCase()));
	}, [sessions, archivedSessions]);

	return {
		sessions: visibleSessions,
		currentId,
		currentPath,
		state,
		models,
		addedWorkspaces,
		removedWorkspaces,
		workspaceAliases,
		getWorkspaceName,
		renameWorkspace,
		archiveSession,
		presets,
		setActivePreset,
		addPreset,
		removePreset,
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
	};
}
