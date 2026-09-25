"use client";

/**
 * AppShell：三栏网格（对齐 dsh ui-layout 几何）+ 拖拽调宽 + 侧栏窄条 +
 * 头部（对话/轨迹标签 + Session log）+ Hero 新会话页 + 设置弹窗。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PiMark } from "@/components/PiMark";
import { ChatInput, EMPTY_CHAT_DRAFT, type ChatDraft, type ChatDraftUpdate } from "@/components/ChatInput";
import { ChatWindow, SessionStatsBar } from "@/components/ChatWindow";
import { ExtensionDialogHost, ExtensionNotices } from "@/components/ExtensionUI";
import dynamic from "next/dynamic";
import { SessionSidebar } from "@/components/SessionSidebar";
import { PromptPanel } from "@/components/PromptPanel";

// 首屏不需要的重组件按需加载（设置面板含供应商配置与代码高亮，轨迹/文件只在打开时才用）
const SettingsPanel = dynamic(() => import("@/components/SettingsPanel").then((m) => m.SettingsPanel), { ssr: false });
const TrajInspector = dynamic(() => import("@/components/TrajectoryView").then((m) => m.TrajInspector), { ssr: false });

/** 会话/工作区路径比较（Windows 大小写与分隔符差异不该影响判断） */
const samePath = (a: string, b: string): boolean =>
	a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const ProjectPanel = dynamic(() => import("@/components/ProjectPanel").then((m) => m.ProjectPanel), { ssr: false });
const FileViewer = dynamic(() => import("@/components/FileViewer").then((m) => m.FileViewer), { ssr: false });
const GitPanel = dynamic(() => import("@/components/GitPanel").then((m) => m.GitPanel), { ssr: false });
import {
	IconAgentPresetOutline16,
	IconCheckOutline14,
	IconChevronDown14,
	IconFolderClose16,
	IconFolderOpenOutline16,
	IconPanelLeftOutline16,
	IconProjectAddOutline16,
} from "@/components/icons";
import { useI18n } from "@/i18n";
import { usePiWeb } from "@/hooks/usePiWeb";
import { useGrowth } from "@/hooks/useGrowth";
import { useFileViewer } from "@/hooks/useFileViewer";
import type { TreeNode } from "@/lib/growth-tree";
import { syncPebrelTheme } from "@/lib/theme";
import type { ModelChoice } from "@/components/ModelSelector";
import type { ImageAttachment, TrajEntry, WorkflowMode } from "@/lib/types";

// dsh ui-layout columns.ts 几何常量
const SIDEBAR_MIN = 264;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_COLLAPSED = 56;
const DETAILS_MIN = 300;
const DETAILS_MAX = 760;
const DETAILS_DEFAULT = 360;
const PROJECT_MIN = 280;
const PROJECT_MAX = 640;
const PROJECT_DEFAULT = 380;
function persist(key: string, value: number) {
	localStorage.setItem(key, String(value));
}
function restore(key: string, fallback: number): number {
	const v = parseInt(localStorage.getItem(key) ?? "", 10);
	return Number.isNaN(v) ? fallback : v;
}

export function AppShell() {
	const { t } = useI18n();
	const {
		sessions,
		sessionListError,
		retrySessionList,
		archivedSessions,
		archivedSessionPaths,
		currentId,
		currentPath,
		state,
		models,
		modelLoading,
		modelLoadError,
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
		editAndResend,
		newSession,
		openSession,
		closeSession,
		setToolPreset,
		clearError,
		clearCompaction,
		setError,
		answerExtensionDialog,
		dismissExtensionNotice,
	} = usePiWeb();

	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [detailsWidth, setDetailsWidth] = useState(DETAILS_DEFAULT);
	/** 项目栏（侧栏与对话之间的第四列：项目生长可视化） */
	const [projectOpen, setProjectOpen] = useState(false);
	const [projectWidth, setProjectWidth] = useState(PROJECT_DEFAULT);
	// Drafts are parent-owned data, never a replayable last insertion/upload event.
	// A hero draft keeps its identity when newSession switches the rendered composer.
	const composerDrafts = useRef(new Map<string, ChatDraft>());
	const sessionDraftKeys = useRef(new Map<string, string>());
	const draftSequence = useRef(0);
	const [heroDraftKey, setHeroDraftKey] = useState("__hero__:0");
	const [draftVersion, setDraftVersion] = useState(0);
	void draftVersion;
	const draftKey = currentPath ? sessionDraftKeys.current.get(currentPath) ?? currentPath : heroDraftKey;
	const [uploadCounts, setUploadCounts] = useState<Record<string, number>>({});
	const [uploadFailures, setUploadFailures] = useState<Record<string, string>>({});
	const [pendingSends, setPendingSends] = useState<Record<string, boolean>>({});
	const updateDraft = useCallback((key: string, update: ChatDraftUpdate) => {
		const previous = composerDrafts.current.get(key) ?? EMPTY_CHAT_DRAFT;
		composerDrafts.current.set(key, typeof update === "function" ? update(previous) : update);
		setDraftVersion((version) => version + 1);
	}, []);
	const trackUpload = useCallback((key: string, delta: 1 | -1) => {
		if (delta === 1) setUploadFailures((current) => ({ ...current, [key]: "" }));
		setUploadCounts((current) => ({ ...current, [key]: Math.max(0, (current[key] ?? 0) + delta) }));
	}, []);
	const failUpload = useCallback((key: string, message: string) => {
		setUploadFailures((current) => ({ ...current, [key]: message }));
	}, []);
	const trackSend = useCallback((key: string, pending: boolean) => {
		setPendingSends((current) => ({ ...current, [key]: pending }));
	}, []);
	const saveSessionDraft = useCallback((update: ChatDraftUpdate) => updateDraft(draftKey, update), [draftKey, updateDraft]);
	const saveHeroDraft = useCallback((update: ChatDraftUpdate) => updateDraft(heroDraftKey, update), [heroDraftKey, updateDraft]);
	const [dragging, setDragging] = useState<"sidebar" | "details" | "project" | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [selected, setSelected] = useState<TrajEntry | null>(null);
	const [gitDetailsOpen, setGitDetailsOpen] = useState(false);
	/** 提示词来源面板（右侧详情列） */
	const [promptsOpen, setPromptsOpen] = useState(false);
	const [heroCwd, setHeroCwd] = useState("");
	const [heroModel, setHeroModel] = useState<{ provider: string; id: string } | null>(null);
	const [heroThinking, setHeroThinking] = useState("");
	const [heroMode, setHeroMode] = useState<WorkflowMode>("agent");
	const [isNarrow, setIsNarrow] = useState(false);
	const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
	useEffect(() => {
		setSidebarWidth(restore("piweb.sidebarW", SIDEBAR_DEFAULT));
		setDetailsWidth(restore("piweb.detailsW", DETAILS_DEFAULT));
		setProjectWidth(restore("piweb.projectW", PROJECT_DEFAULT));
		setSidebarCollapsed(localStorage.getItem("piweb.sidebarCollapsed") === "1");
		setProjectOpen(localStorage.getItem("piweb.projectOpen") === "1");
	}, []);
	const toggleProject = useCallback((next?: boolean) => {
		setProjectOpen((cur) => {
			const v = next ?? !cur;
			localStorage.setItem("piweb.projectOpen", v ? "1" : "0");
			return v;
		});
	}, []);
	// Ctrl/⌘+Shift+E：切换项目栏（与 VS Code 资源管理器同键）
	useEffect(() => {
		const h = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") {
				e.preventDefault();
				toggleProject();
			}
		};
		document.addEventListener("keydown", h);
		return () => document.removeEventListener("keydown", h);
	}, [toggleProject]);

	useEffect(() => {
		const query = window.matchMedia("(max-width: 840px)");
		const sync = () => {
			setIsNarrow(query.matches);
			if (!query.matches) setMobileSidebarOpen(false);
		};
		sync();
		query.addEventListener("change", sync);
		return () => query.removeEventListener("change", sync);
	}, []);

	// 全局 Pebrel 主题初始化与系统亮暗/跨标签动态监听
	useEffect(() => {
		const sync = () => syncPebrelTheme();
		sync();
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		mq.addEventListener("change", sync);
		const onStorage = (e: StorageEvent) => {
			// 配色或亮暗任一变化都重放（跨标签同步）
			if (e.key === "piweb.pebrelTheme" || e.key === "piweb.theme") sync();
		};
		window.addEventListener("storage", onStorage);
		return () => {
			mq.removeEventListener("change", sync);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	// 切换会话时清掉轨迹页的选中态并收起详情栏
	useEffect(() => {
		setSelected(null);
		setGitDetailsOpen(false);
		setPromptsOpen(false);
	}, [currentPath]);

	// 已知工作区列表（给 Hero 建议）；启动不预选任何工作区，
	// 未选择时输入框仍可用，发送会提示先选择工作区。
	// 已删除工作区要过滤（与会话栏分组同口径）：否则它下面残留的会话 cwd
	// 会把刚删掉的工作区重新喂回顶部下拉。
	const knownCwds = useMemo(() => {
		const removed = new Set(removedWorkspaces.map((w) => w.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()));
		const keep = (cwd: string) => {
			const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
			return Boolean(norm) && !removed.has(norm);
		};
		return Array.from(new Set([...addedWorkspaces, ...sessions.map((s) => s.cwd)].filter(keep)));
	}, [addedWorkspaces, sessions, removedWorkspaces]);

	// 模型目录派生值：数百个模型对象的映射只在目录变化时重算，
	// 不能跟着每次 token 增量 / 3 秒轮询重跑（usePiWeb 的 setState 都会触发本组件渲染）
	const { authByProvider, providerNames } = useMemo(() => {
		const auth: Record<string, boolean> = {};
		const names: Record<string, string> = {};
		for (const p of models?.providers ?? []) {
			auth[p.id] = p.authReady === true;
			names[p.id] = p.name;
		}
		return { authByProvider: auth, providerNames: names };
	}, [models]);
	const modelChoices: ModelChoice[] = useMemo(
		() =>
			(models?.models ?? []).map((m: any) => ({
				provider: m.provider,
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				thinkingLevels: m.thinkingLevels,
				contextWindow: m.contextWindow,
			})),
		[models],
	);
	const defaultModel = useMemo(() => modelChoices.find((m) => authByProvider[m.provider]), [modelChoices, authByProvider]);
	const heroModelLevels = useMemo(
		() => (heroModel ? modelChoices.find((m) => m.provider === heroModel.provider && m.id === heroModel.id) : defaultModel)?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		[heroModel, modelChoices, defaultModel],
	);


	// ---------- 拖拽 ----------
	const onDrag = useCallback(
		(side: "sidebar" | "details" | "project") => (e: React.PointerEvent) => {
			e.preventDefault();
			setDragging(side);
			const startX = e.clientX;
			const startW = side === "sidebar" ? sidebarWidth : side === "project" ? projectWidth : detailsWidth;
			const move = (ev: PointerEvent) => {
				if (side === "sidebar") {
					const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)));
					setSidebarWidth(w);
				} else if (side === "project") {
					const w = Math.max(PROJECT_MIN, Math.min(PROJECT_MAX, startW + (ev.clientX - startX)));
					setProjectWidth(w);
				} else {
					const w = Math.max(DETAILS_MIN, Math.min(DETAILS_MAX, startW - (ev.clientX - startX)));
					setDetailsWidth(w);
				}
			};
			const up = () => {
				setDragging(null);
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				window.removeEventListener("pointercancel", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			// 触摸/笔输入被系统手势打断时只触发 pointercancel，不处理会永久泄漏监听器
			window.addEventListener("pointercancel", up);
		},
		[sidebarWidth, detailsWidth, projectWidth],
	);

	useEffect(() => {
		if (dragging === "sidebar") persist("piweb.sidebarW", sidebarWidth);
		if (dragging === "details") persist("piweb.detailsW", detailsWidth);
		if (dragging === "project") persist("piweb.projectW", projectWidth);
	}, [dragging, sidebarWidth, detailsWidth, projectWidth]);

	const toggleSidebar = () => {
		const next = !sidebarCollapsed;
		setSidebarCollapsed(next);
		localStorage.setItem("piweb.sidebarCollapsed", next ? "1" : "0");
	};

	// ---------- 会话操作 ----------
	const snapshot = state.snapshot;
	const trajectoryRef = useRef(snapshot?.trajectory ?? []);
	useEffect(() => {
		trajectoryRef.current = snapshot?.trajectory ?? [];
	}, [snapshot?.trajectory]);
	const openToolTrajectory = useCallback((toolCallId: string) => {
		const entry = trajectoryRef.current.find((item) => item.toolCallId === toolCallId);
		if (!entry) return;
		setGitDetailsOpen(false);
		setSelected(entry);
	}, []);

	// 上下文分段的数据源：系统提示词按注入资源字符数（很便宜）；
	// 消息字符统计交给 ContextMeter 弹窗打开时再算，避免每次 token 增量全量扫描
	const contextSystemChars = useMemo(
		() => (snapshot?.contextResources ?? []).reduce((sum, r) => sum + (r.content?.length ?? 0), 0),
		[snapshot?.contextResources],
	);
	const isStreaming = snapshot?.isStreaming ?? false;

	useEffect(() => {
		if (!state.error) return;
		const timer = setTimeout(clearError, 6000);
		return () => clearTimeout(timer);
	}, [state.error, clearError]);

	const doRename = async (path: string, newName: string) => {
		if (!newName.trim()) return;
		const result = path === currentPath
			? await sendCommand({ cmd: "rename", text: newName.trim() })
			: await sendCommand({ cmd: "rename", text: newName.trim() }, encodeURIComponent(b64url(path)));
		if (!result?.success) {
			throw new Error(result?.error || "failed to rename session");
		}
		patchSessionName(path, newName.trim());
		if (path !== currentPath) {
			// 冷会话：临时走命令路由（会按需打开，不启动 agent 的 rename 走 appendSessionInfo）
			resync();
		}
	};

	const doForkSession = useCallback(
		async (path: string, _cwd: string) => {
			const targetId = path === currentPath && currentId ? currentId : encodeURIComponent(b64url(path));
			const r = await sendCommand({ cmd: "fork" }, targetId);
			if (r?.success && r.data?.sessionPath) {
				openSession(r.data.sessionPath);
				resync();
			}
		},
		[currentPath, currentId, sendCommand, openSession, resync],
	);

	/**
	 * 原地编辑用户消息后重新发送：服务端先停在跑的回合（用户改口即表示不要这一轮），
	 * 再在同一会话文件内回到该消息之前（navigateTree），用新文本重新提问——
	 * 被编辑消息之后的分支作废，模型从这里重新回答。旧的插话（steering）撤回/编辑/发送不变。
	 */
	const doEditMessage = useCallback(
		async (entryId: string, text: string) => {
			if (!currentId) return;
			await editAndResend(entryId, text);
		},
		[currentId, editAndResend],
	);

	const doArchiveSession = useCallback(
		async (path: string) => {
			try {
				await archiveSession(path);
			} catch {
				// usePiWeb exposes the request failure in the shared error banner.
				return;
			}
			// 归档后会话立刻离开工作区列表（服务端同时让它收工）。正在看的会话被归档时
			// 必须切走：先取同一工作区的另一个可见会话，没有就回到空态（工作区仍留在侧栏）。
			if (!currentPath || !samePath(path, currentPath)) return;
			const cwd = sessions.find((s) => samePath(s.path, currentPath))?.cwd;
			const next =
				sessions.find((s) => !samePath(s.path, path) && cwd && samePath(s.cwd, cwd)) ??
				sessions.find((s) => !samePath(s.path, path));
			if (next) openSession(next.path);
			else closeSession();
		},
		[archiveSession, closeSession, currentPath, openSession, sessions],
	);
	const doUnarchiveSession = useCallback(
		async (path: string) => {
			try {
				await unarchiveSession(path);
				resync();
			} catch {
				// usePiWeb exposes the request failure in the shared error banner.
			}
		},
		[unarchiveSession, resync],
	);

	const doRenameWorkspace = useCallback(
		async (cwd: string, newName: string) => {
			await renameWorkspace(cwd, newName);
		},
		[renameWorkspace],
	);

	const doDeleteWorkspace = useCallback(
		async (cwd: string) => {
			await removeWorkspace(cwd);
			if (heroCwd === cwd) {
				setHeroCwd("");
			}
			resync();
		},
		[removeWorkspace, heroCwd, resync],
	);

	// Hero 发送：先完整应用新会话预设，再发第一条消息。
	const heroSend = async (text: string, images: ImageAttachment[]) => {
		// 启动不预选工作区：未选择就发送时明确提示，而不是静默落到第一个工作区
		const cwd = heroCwd.trim();
		if (!cwd) {
			setError(t.pickWorkspaceFirst);
			return { success: false };
		}
		// 用户没手动选过模型时也要把界面显示的默认模型显式下发，
		// 否则后端不 setModel、SDK 自选的默认与界面显示不一致。
		const effective = heroModel ?? (defaultModel ? { provider: defaultModel.provider, id: defaultModel.id } : null);
		const p = await newSession(cwd, {
			provider: effective?.provider,
			modelId: effective?.id,
			thinking: heroThinking || undefined,
			mode: heroMode,
		});
		if (!p) return { success: false };
		// Bind before the new-session render. In-flight ChatInput callbacks still own
		// this same key; a failed acceptance keeps the original text and attachments.
		sessionDraftKeys.current.set(p, heroDraftKey);
		setHeroDraftKey(`__hero__:${++draftSequence.current}`);
		return sendCommand({ cmd: "prompt", text, images }, encodeURIComponent(b64url(p)));
	};

	const sendPrompt = (text: string, images: ImageAttachment[]) => sendCommand({ cmd: "prompt", text, images });

	// 稳定引用：ChatWindow 行级 memo 依赖它，内联箭头函数会让 memo 全部失效
	const handleFork = useCallback(
		(entryId: string) =>
			sendCommand({ cmd: "fork", entryId }).then((result) => {
				if (result.success && result.data?.sessionPath) {
					openSession(result.data.sessionPath);
					resync();
				}
				return result;
			}),
		[sendCommand, openSession, resync],
	);

	// 斜杠命令：Web 内置 + pi 的技能 / 提示模板 / 扩展命令（后三类原样交给 SDK 展开或执行）
	const slashCommands = useMemo(() => {
		const list: { name: string; desc: string; kind: "builtin" | "skill" | "template" | "extension"; argumentHint?: string }[] = [
			{ name: "compact", desc: t.cmdCompact, kind: "builtin" },
			{ name: "export", desc: t.cmdExport, kind: "builtin" },
			{ name: "model", desc: t.cmdModel, kind: "builtin" },
			{ name: "new", desc: t.cmdNew, kind: "builtin" },
			{ name: "fork", desc: t.cmdFork, kind: "builtin" },
			{ name: "reload", desc: t.cmdReload, kind: "builtin" },
			...(snapshot?.promptTemplates ?? []).map((p) => ({ name: p.name, desc: p.description, kind: "template" as const, argumentHint: p.argumentHint })),
			...(snapshot?.extensionCommands ?? []).map((c) => ({ name: c.name, desc: c.description || c.source, kind: "extension" as const })),
			...(snapshot?.skills ?? []).map((s) => ({ name: `skill:${s.name}`, desc: s.description, kind: "skill" as const })),
		];
		return list.sort((a, b) => a.name.localeCompare(b.name));
	}, [snapshot, t]);

	const runSlashCommand = useCallback(
		(name: string, args: string) => {
			if (name === "compact") void sendCommand({ cmd: "compact", instructions: args || undefined });
			else if (name === "export" && currentId) window.open(`/api/sessions/${currentId}/export?format=jsonl`, "_blank");
			else if (name === "new") {
				closeSession();
			} else if (name === "fork" && currentId) {
				void sendCommand({ cmd: "fork" }).then((r) => {
					if (r.success && r.data?.sessionPath) openSession(r.data.sessionPath);
				});
			} else if (name === "reload") void sendCommand({ cmd: "reload" });
			else setError(t.cmdUnknown.replace("{name}", name));
		},
		[sendCommand, currentId, closeSession, openSession, setError, t],
	);

	const projectTrust = snapshot?.projectTrust;
	const setProjectTrust = useCallback(
		async (decision: boolean | null) => {
			const cwd = snapshot?.cwd;
			if (!cwd) return;
			try {
				const r = await fetch("/api/security", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectTrust: { cwd, decision } }) });
				const j = await r.json();
				if (!j.success) throw new Error(j.error || "failed");
			} catch (e) {
				setError(e instanceof Error ? e.message : "failed");
			}
		},
		[snapshot?.cwd, setError],
	);

	// 当前会话名 / 工作区标题
	const currentSession = sessions.find((s) => s.path === currentPath);
	const firstUserMsgText = (
		state.messages
			.find((m) => m.role === "user")
			?.content?.find((c: any) => c.type === "text" && c.text?.trim()) as any
	)?.text?.trim();
	const title =
		snapshot?.name ||
		currentSession?.name ||
		currentSession?.firstMessage ||
		firstUserMsgText ||
		currentPath?.split(/[\\/]/).pop() ||
		"pi";

	// 项目栏/文件查看器的工作区：当前会话的工作区优先，快照未到时回落到会话列表里的 cwd
	const panelCwd = snapshot?.cwd || currentSession?.cwd || heroCwd || knownCwds[0] || "";

	// Git 面板自动刷新：pi 每完成一个会改动文件的工具，或一轮结束时，静默重拉
	const mutatingDone = useMemo(
		() => Object.values(state.tools).filter((tool) => tool.state === "done" && ["edit", "write", "bash", "powershell", "pwsh"].includes(tool.name.toLowerCase())).length,
		[state.tools],
	);
	const [panelRefreshKey, setPanelRefreshKey] = useState(0);
	const prevMutatingRef = useRef(mutatingDone);
	const prevStreamingRef = useRef(isStreaming);
	useEffect(() => {
		if (prevMutatingRef.current !== mutatingDone) {
			prevMutatingRef.current = mutatingDone;
			setPanelRefreshKey((k) => k + 1);
		}
	}, [mutatingDone]);
	useEffect(() => {
		if (prevStreamingRef.current && !isStreaming) setPanelRefreshKey((k) => k + 1);
		prevStreamingRef.current = isStreaming;
	}, [isStreaming]);

	const insertIntoComposer = useCallback((text: string) => {
		const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"] textarea');
		const cursor = textarea?.selectionStart;
		updateDraft(draftKey, (previous) => {
			const position = Math.min(cursor ?? previous.text.length, previous.text.length);
			const before = previous.text.slice(0, position);
			const after = previous.text.slice(position);
			return { ...previous, text: `${before}${before && !/\s$/.test(before) ? " " : ""}${text}${after}` };
		});
		requestAnimationFrame(() => textarea?.focus());
	}, [draftKey, updateDraft]);
	const openInEditor = useCallback(
		async (filePath: string) => {
			try {
				const r = await fetch("/api/files", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: "open", cwd: panelCwd, path: filePath }),
				});
				const j = await r.json();
				if (!j.success) throw new Error(j.error || "failed to open file");
			} catch (e) {
				setError(e instanceof Error ? e.message : "failed to open file");
			}
		},
		[panelCwd, setError],
	);
	// ---------- 项目生长 ----------
	const viewer = useFileViewer();
	const resetViewer = viewer.reset;
	useEffect(() => {
		resetViewer();
	}, [panelCwd, resetViewer]);
	const growthTurnStarts = useMemo(
		() => {
			const persisted = state.snapshot?.userTurns ?? [];
			const ids = new Set(persisted.map((turn) => turn.id));
			const lastTs = persisted[persisted.length - 1]?.ts ?? -Infinity;
			const live = state.messages
				.filter((message) => message.role === "user" && (!message.id || !ids.has(message.id)) && (message.timestamp ?? Date.now()) >= lastTs - 1000)
				.map((message) => message.timestamp ?? Date.now());
			return [...persisted.map((turn) => turn.ts), ...live];
		},
		[state.snapshot?.userTurns, state.messages],
	);
	const growth = useGrowth({
		cwd: panelCwd,
		sessionPath: currentPath,
		liveSteps: state.growth.steps,
		pending: state.growth.pending,
		runtimeError: state.growth.error,
		active: projectOpen || viewer.state.open,
		connected: state.connected,
		turnStarts: growthTurnStarts,
	});
	const openFileNode = useCallback((node: TreeNode) => viewer.open(node.path, { from: node.from, lazy: node.lazy }), [viewer]);

	useEffect(() => {
		document.title = currentId && title && title !== "pi" ? `${title} · pi` : "pi";
	}, [currentId, title]);

	// 三栏网格
	const gridCols = isNarrow ? "minmax(0,1fr)" : `${sidebarCollapsed ? SIDEBAR_COLLAPSED : sidebarWidth}px ${projectOpen ? `${projectWidth}px` : "0px"} minmax(0,1fr) ${
		selected || gitDetailsOpen || promptsOpen ? `${detailsWidth}px` : "0px"
	}`;
	const projectColumn = projectOpen && (
		<div
			className="min-h-0 overflow-hidden"
			style={isNarrow ? {
				position: "fixed",
				inset: "0 auto 0 0",
				width: "min(88vw, 420px)",
				zIndex: 88,
				boxShadow: "var(--dsw-elevation-prominent)",
			} : undefined}
		>
			<ProjectPanel
				growth={growth}
				workspaceName={panelCwd ? getWorkspaceName(panelCwd) : ""}
				cwd={panelCwd}
				hasSession={Boolean(currentPath)}
				onOpenFile={openFileNode}
				onReference={insertIntoComposer}
				onOpenEditor={openInEditor}
				gitRefreshKey={panelRefreshKey}
				onAskCommit={() => insertIntoComposer(t.gitAskCommitPrompt)}
				onOpenGit={() => { setSelected(null); setGitDetailsOpen(true); }}
				onClose={() => toggleProject(false)}
				onError={setError}
			/>
		</div>
	);

	return (
		<div
			className="pw-shell grid h-screen w-screen overflow-hidden"
			style={{
				gridTemplateColumns: gridCols,
				transition: dragging ? "none" : "grid-template-columns var(--ds-duration-slow) var(--ds-ease-in-out)",
				background: "var(--dsw-bg-base)",
			}}
		>
			{/* 侧栏 */}
			<div
				className="pw-sidebar-surface min-h-0 overflow-hidden"
				style={isNarrow ? {
					position: "fixed",
					inset: "0 auto 0 0",
					width: "min(86vw, 340px)",
					zIndex: 90,
					background: "var(--dsw-sidebar-fill)",
					transform: mobileSidebarOpen ? "translateX(0)" : "translateX(-105%)",
					transition: "transform var(--ds-duration-normal) var(--ds-ease-in-out)",
					boxShadow: mobileSidebarOpen ? "var(--dsw-elevation-prominent)" : "none",
				} : { background: "var(--dsw-sidebar-fill)" }}
			>
				<SessionSidebar
					sessions={sessions}
					sessionListError={sessionListError}
					onRetrySessionList={retrySessionList}
					archivedSessions={archivedSessions}
					archivedPaths={archivedSessionPaths}
					addedWorkspaces={addedWorkspaces}
					removedWorkspaces={removedWorkspaces}
					currentPath={currentPath}
					groupBy={groupBy}
					orderBy={orderBy}
					setGroupBy={setGroupBy}
					setOrderBy={setOrderBy}
					collapsed={isNarrow ? false : sidebarCollapsed}
					onToggleCollapse={isNarrow ? () => setMobileSidebarOpen(false) : toggleSidebar}
					onOpen={(path) => {
						openSession(path);
						setMobileSidebarOpen(false);
					}}
					onNew={() => {
						// 对齐 dsh startSession：新会话默认落在当前会话的工作区（无则取最近工作区）
						const cur = sessions.find((s) => s.path === currentPath)?.cwd;
						setHeroCwd(cur || heroCwd || knownCwds[0] || "");
						closeSession();
					}}
					onNewInWorkspace={(cwd) => {
						// dsh 惰性新建：只预选工作区进草稿态，发送第一条消息才真正创建会话
						setHeroCwd(cwd);
						closeSession();
					}}
					onRename={doRename}
					onFork={doForkSession}
					onArchive={doArchiveSession}
					onUnarchive={doUnarchiveSession}
					onExport={(path) => window.open(`/api/sessions/${encodeURIComponent(b64url(path))}/export?format=jsonl`, "_blank")}
					getWorkspaceName={getWorkspaceName}
					onRenameWorkspace={doRenameWorkspace}
					onDeleteWorkspace={doDeleteWorkspace}
					onOpenSettings={() => {
						setSettingsOpen(true);
						setMobileSidebarOpen(false);
					}}
					onAddWorkspace={() => void addWorkspaceByPicker()}
					draftCwd={!currentId ? heroCwd || null : null}
				/>
			</div>

			{/* 四列网格中始终保留项目列，否则关闭项目栏时会话区会落进 0px 列。 */}
			{!isNarrow && (projectColumn || <div aria-hidden="true" />)}

			{/* 会话区 */}
			<div className={`pi-main pw-main flex min-h-0 min-w-0 flex-col${currentId ? "" : " pw-main-hero"}`}>
				{!currentId ? (
					<div className="flex min-h-0 flex-1 flex-col">
						<Hero
								draft={composerDrafts.current.get(heroDraftKey) ?? EMPTY_CHAT_DRAFT}
								onDraftChange={saveHeroDraft}
								onUploadError={(message) => failUpload(heroDraftKey, message)}
								onUploadProgress={(delta) => trackUpload(heroDraftKey, delta)}
								uploadFailure={uploadFailures[heroDraftKey]}
								pendingUploadCount={uploadCounts[heroDraftKey] ?? 0}
								pendingSend={pendingSends[heroDraftKey] ?? false}
								onSendPendingChange={(pending) => trackSend(heroDraftKey, pending)}
							commands={slashCommands}
							onCommand={runSlashCommand}
							cwd={heroCwd}
							setCwd={setHeroCwd}
							knownCwds={knownCwds}
							getWorkspaceName={getWorkspaceName}
							onSend={heroSend}
							models={modelChoices}
							modelLoading={modelLoading}
							modelLoadError={modelLoadError}
							onRetryModels={() => void refreshModels()}
							providerNames={providerNames}
							authByProvider={authByProvider}
							addWorkspaceByPicker={addWorkspaceByPicker}
							heroModel={heroModel}
							onSelectHeroModel={(provider, id) => {
								setHeroModel({ provider, id });
								const levels = modelChoices.find((model) => model.provider === provider && model.id === id)?.thinkingLevels ?? [];
								if (heroThinking && !levels.includes(heroThinking)) setHeroThinking("");
							}}
							defaultModel={defaultModel}
							heroModelLevels={heroModelLevels}
								heroThinking={heroThinking}
								onSelectHeroThinking={setHeroThinking}
								heroMode={heroMode}
								onSelectHeroMode={setHeroMode}
						/>
						{/* 草稿阶段的错误行内显示（不再弹右下角） */}
						{state.error && (
							<div className="px-4 pb-3">
								<button
									className="mx-auto block w-full max-w-md rounded-xl px-3 py-2 text-left"
									style={{ fontSize: 12.5, background: "var(--dsw-danger)", color: "white" }}
									onClick={clearError}
									role="alert"
								>
									{state.error}
								</button>
							</div>
						)}
					</div>
				) : (
					<>
							{/* 头部：标题行 + 页签行（dsh 两行式） */}
							<div className="pw-session-header hairline-b px-5 pb-0 pt-3">
								<div className="flex items-center gap-3">
									<div className="pw-session-heading min-w-0 flex-1">
										<span className="pw-session-eyebrow">PIWEB / SESSION</span>
										<span className="pw-session-title truncate">{title}</span>
									</div>
									{/* 项目生长入口；轨迹详情由对话内工具行点击唤起 */}
									<button
										type="button"
										className="icon-btn"
										style={{ width: 30, height: 30, background: projectOpen ? "var(--dsw-active)" : undefined }}
										title={`${t.projectPanel} (Ctrl/⌘+Shift+E)`}
										aria-label={t.projectPanel}
										data-testid="project-toggle"
										onClick={() => toggleProject()}
									>
										<IconFolderOpenOutline16 size={15} />
									</button>
									{/* 提示词来源：系统提示词 / 记忆 / 技能 / 模板 / 工具提示词集中列出，点开即看 */}
									<button
										type="button"
										className="icon-btn"
										style={{ width: 30, height: 30, background: promptsOpen ? "var(--dsw-active)" : undefined }}
										title={t.promptPanel}
										aria-label={t.promptPanel}
										data-testid="prompt-panel-toggle"
										onClick={() => {
											setPromptsOpen((open) => !open);
											setSelected(null);
											setGitDetailsOpen(false);
										}}
									>
										<IconAgentPresetOutline16 size={15} />
									</button>
								</div>
							{projectTrust?.required && !projectTrust.trusted && (
								<div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2" style={{ fontSize: 12.5, background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)" }} role="status">
									<span style={{ color: "var(--dsw-warn)", fontWeight: 600 }}>⚠</span>
									<span className="min-w-0 flex-1">{projectTrust.source === "default-never" || projectTrust.source === "remembered" ? t.projectTrustBannerNever : t.projectTrustBanner}</span>
									<button className="btn-primary-white" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={() => void setProjectTrust(true)}>{t.projectTrustAllow}</button>
									{projectTrust.source === "undecided" && (
										<button className="btn-outline" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={() => void setProjectTrust(false)}>{t.projectTrustDeny}</button>
									)}
								</div>
							)}
							{/* 轨迹页签已移除：轨迹按需查看（对话里的工具行 → 轨迹详情），不再占用主区域 */}
						</div>

						{/* 内容：只有对话区，轨迹按需在详情栏查看 */}
						{!snapshot ? (
								// 切换会话时快照未到：居中加载指示，避免空白/占位符闪现
								<div className="flex min-h-0 flex-1 items-center justify-center">
									<span
										className="piweb-spin"
										style={{
											width: 18,
											height: 18,
											borderRadius: "50%",
											border: "2px solid var(--dsw-border-l3)",
											borderTopColor: "var(--dsw-accent)",
											display: "inline-block",
										}}
										aria-label="loading"
									/>
								</div>
							) : (
							<div className="flex min-h-0 flex-1 flex-col justify-end">
								<ChatWindow
									key={currentId ?? "none"}
									messages={state.messages}
									tools={state.tools}
									contextFiles={snapshot?.contextResources ?? snapshot?.contextFiles ?? []}
									isStreaming={isStreaming}
									error={state.error}
									connected={state.connected}
									onClearError={clearError}
									retryNotice={state.retryNotice}
									compaction={state.compaction}
									onClearCompaction={clearCompaction}
									workingMessage={state.workingMessage}
									stats={snapshot?.stats ?? null}
									trajectory={snapshot?.trajectory ?? []}
									cwd={panelCwd}
									onOpenTrajectory={openToolTrajectory}
									onOpenFile={openInEditor}
									onFork={handleFork}
									onEditMessage={doEditMessage}
								/>
								<div className="pw-session-composer px-4 pb-3 pt-2">
									<div className="mx-auto w-full" style={{ maxWidth: "var(--dsh-composer-card-max-width)" }}>
										{/* 运行状态指示由 ChatWindow 内的 WorkingIndicator 承担（含工具/输出 token 信息） */}
										<ChatInput
											key={draftKey}
											draft={composerDrafts.current.get(draftKey) ?? EMPTY_CHAT_DRAFT}
											onDraftChange={saveSessionDraft}
											onUploadError={(message) => failUpload(draftKey, message)}
											onUploadProgress={(delta) => trackUpload(draftKey, delta)}
											uploadFailure={uploadFailures[draftKey]}
											pendingUploadCount={uploadCounts[draftKey] ?? 0}
											pendingSend={pendingSends[draftKey] ?? false}
											onSendPendingChange={(pending) => trackSend(draftKey, pending)}
											isStreaming={isStreaming}
											contextPercent={snapshot?.contextUsage?.percent ?? null}
											contextTokens={snapshot?.contextUsage?.tokens ?? null}
											contextWindow={snapshot?.contextUsage?.contextWindow ?? null}
											contextSource={{ systemChars: contextSystemChars, messages: state.messages, breakdown: snapshot?.contextBreakdown }}
											contextVisible={(snapshot?.messages?.length ?? 0) > 0}
											model={snapshot?.model}
											thinkingLevel={snapshot?.thinkingLevel}
											thinkingLevels={snapshot?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]}
											models={modelChoices}
											modelLoading={modelLoading}
											modelLoadError={modelLoadError}
											onRetryModels={() => void refreshModels()}
											providerNames={providerNames}
											authByProvider={authByProvider}
											queue={snapshot?.queue ?? { steering: [], followUp: [] }}
											workflow={snapshot?.workflow}
											onWorkflowModeChange={(mode) => sendCommand({ cmd: "setWorkflowMode", mode })}
											onApprovePlan={() => sendCommand({ cmd: "approvePlan" })}
											commands={slashCommands}
											onCommand={runSlashCommand}
											onSend={sendPrompt}
											onSteer={(text, images) => sendCommand({ cmd: "prompt", text, images, behavior: "steer" })}
											onFollowUp={(text, images) => sendCommand({ cmd: "prompt", text, images, behavior: "followUp" })}
											onAbort={() => sendCommand({ cmd: "abort" })}
											onSelectModel={(provider, id) => void sendCommand({ cmd: "setModel", provider, modelId: id })}
											onSelectLevel={(level) =>
												void sendCommand({ cmd: "setThinkingLevel", level }).then((r) => {
													// 后端按 pi 规则就近钳制；被调整时明确告知，不再“选了没反应”
													if (r?.success && r.data?.clamped) setError(t.thinkingClamped.replace("{requested}", level).replace("{level}", String(r.data.thinkingLevel)));
												})
											}
											onClearQueue={() => sendCommand({ cmd: "clearQueue" })}
										/>
										<SessionStatsBar stats={snapshot?.stats ?? null} />
										{Object.keys(state.extensionStatuses).length > 0 && (
											<div className="mx-auto mt-0.5 flex w-full flex-wrap justify-center gap-x-3 px-4" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }} title={t.extensionStatus}>
												{Object.entries(state.extensionStatuses).map(([k, v]) => <span key={k}>{v}</span>)}
											</div>
										)}
									</div>
								</div>
								</div>
								)
						}
					</>
				)}
			</div>

			{/* 提示词来源 / 轨迹 / Git 详情栏 */}
			{(selected || gitDetailsOpen || promptsOpen) && (
				<div
					className="flex min-h-0 flex-col overflow-hidden"
					style={isNarrow ? {
						position: "fixed",
						inset: "0 0 0 auto",
						width: "min(92vw, 640px)",
						zIndex: 90,
						background: "var(--dsw-sidebar-fill)",
						boxShadow: "var(--dsw-elevation-prominent)",
					} : { background: "var(--dsw-sidebar-fill)", borderLeft: "0.5px solid var(--dsw-border-l2)" }}
				>
					<div className="min-h-0 flex-1">
						{promptsOpen ? (
							<PromptPanel
								cwd={panelCwd}
								sessionId={currentId}
								refreshKey={currentId}
								onOpenContent={(path, content) => viewer.openStatic(path, content)}
								onClose={() => setPromptsOpen(false)}
							/>
						) : selected ? (
							<TrajInspector entry={selected} onClose={() => setSelected(null)} />
						) : (
							<GitPanel cwd={panelCwd} refreshKey={panelRefreshKey} onClose={() => setGitDetailsOpen(false)} onAskCommit={() => insertIntoComposer(t.gitAskCommitPrompt)} onOpenFile={openInEditor} />
						)}
					</div>
				</div>
			)}

			{/* 拖拽手柄 */}
			{!isNarrow && !sidebarCollapsed && (
				<div
					className="fixed top-0 h-full w-2 cursor-col-resize"
					style={{ left: sidebarWidth - 4, zIndex: 40 }}
					onPointerDown={onDrag("sidebar")}
				/>
			)}
			{!isNarrow && (selected || gitDetailsOpen || promptsOpen) && (
				<div
					className="fixed top-0 h-full w-2 cursor-col-resize"
					style={{ left: `calc(100vw - ${detailsWidth}px - 4px)`, zIndex: 40 }}
					onPointerDown={onDrag("details")}
				/>
			)}
			{!isNarrow && projectOpen && (
				<div
					className="fixed top-0 h-full w-2 cursor-col-resize"
					style={{ left: (sidebarCollapsed ? SIDEBAR_COLLAPSED : sidebarWidth) + projectWidth - 4, zIndex: 40 }}
					onPointerDown={onDrag("project")}
				/>
			)}
			{isNarrow && projectOpen && (
				<>
					<button className="fixed inset-0 z-[85]" style={{ background: "var(--dsw-mask)" }} onClick={() => toggleProject(false)} aria-label={t.close} />
					{projectColumn}
				</>
			)}
			{viewer.state.open && (
				<FileViewer
					state={viewer.state}
					growth={growth}
					cwd={panelCwd}
					onClose={viewer.close}
					onSelectTab={viewer.select}
					onCloseTab={viewer.closeTab}
					onOpen={viewer.open}
					onReference={insertIntoComposer}
					onOpenEditor={openInEditor}
				/>
			)}

			<ExtensionDialogHost dialog={state.extensionDialogs[0] ?? null} onAnswer={(id, response) => void answerExtensionDialog(id, response)} />
			<ExtensionNotices notices={state.extensionNotices} onDismiss={dismissExtensionNotice} />
			<SettingsPanel
				open={settingsOpen}
				onClose={() => {
					setSettingsOpen(false);
					// 模型配置可能在设置里被改动（API key / OAuth / 自定义 provider）：
					// 关闭时刷新全局模型目录，否则输入卡/新会话页的模型菜单停留在旧目录。
					void refreshModels();
				}}
				onOpenFileContent={(p, content) => viewer.openStatic(p, content)}
				cwd={snapshot?.cwd || heroCwd || knownCwds[0] || ""}
				toolPreset={state.toolPreset}
				onToolPresetChange={setToolPreset}
				tools={snapshot?.tools ?? null}
				onSetTools={(names) => {
					void sendCommand({ cmd: "setActiveTools", names });
				}}
			/>
			{isNarrow && (
				<button
					className="pi-mobile-menu icon-btn fixed left-3 top-3 z-[70]"
					style={{ width: 34, height: 34, background: "var(--dsw-bg-elevated)", boxShadow: "var(--dsw-elevation-soft)" }}
					onClick={() => setMobileSidebarOpen(true)}
					aria-label={t.workspaces}
				>
					<IconPanelLeftOutline16 size={17} />
				</button>
			)}
			{isNarrow && mobileSidebarOpen && (
				<button
					className="fixed inset-0 z-[80]"
					style={{ background: "var(--dsw-mask)" }}
					onClick={() => setMobileSidebarOpen(false)}
					aria-label={t.close}
				/>
			)}
		</div>
	);
}

function b64url(path: string): string {
	const bytes = new TextEncoder().encode(path);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function basename(p: string): string {
	const norm = p.replace(/\\/g, "/");
	return norm.split("/").filter(Boolean).pop() ?? norm;
}

function Hero({
	draft,
	onDraftChange,
	onUploadError,
	onUploadProgress,
	uploadFailure,
	pendingUploadCount,
	pendingSend,
	onSendPendingChange,
	commands,
	onCommand,
	cwd,
	setCwd,
	knownCwds,
	getWorkspaceName,
	onSend,
	models,
	modelLoading,
	modelLoadError,
	onRetryModels,
	providerNames,
	authByProvider,
	addWorkspaceByPicker,
	heroModel,
	onSelectHeroModel,
	defaultModel,
	heroModelLevels,
	heroThinking,
	onSelectHeroThinking,
	heroMode,
	onSelectHeroMode,
}: {
	draft: ChatDraft;
	onDraftChange: (update: ChatDraftUpdate) => void;
	onUploadError: (message: string) => void;
	onUploadProgress: (delta: 1 | -1) => void;
	uploadFailure?: string;
	pendingUploadCount: number;
	pendingSend: boolean;
	onSendPendingChange: (pending: boolean) => void;
	commands: Array<{ name: string; desc: string; kind: "builtin" | "skill" | "template" | "extension"; argumentHint?: string }>;
	onCommand: (name: string, args: string) => void;
	cwd: string;
	setCwd: (v: string) => void;
	knownCwds: string[];
	getWorkspaceName?: (cwd: string) => string;
	onSend: (text: string, images: ImageAttachment[]) => Promise<{ success: boolean }>;
	models: ModelChoice[];
	modelLoading: boolean;
	modelLoadError: string | null;
	onRetryModels: () => void;
	providerNames: Record<string, string>;
	authByProvider: Record<string, boolean>;
	addWorkspaceByPicker: () => Promise<string | null>;
	heroModel: { provider: string; id: string } | null;
	onSelectHeroModel: (provider: string, id: string) => void;
	defaultModel?: ModelChoice;
	heroModelLevels: string[];
	heroThinking: string;
	onSelectHeroThinking: (level: string) => void;
	heroMode: WorkflowMode;
	onSelectHeroMode: (mode: WorkflowMode) => void;
}) {
	const { t } = useI18n();
	const [wsMenu, setWsMenu] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!wsMenu) return;
		const h = (e: MouseEvent) => {
			if (!menuRef.current?.contains(e.target as Node)) {
				setWsMenu(false);
			}
		};
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [wsMenu]);

	const pickWorkspace = async () => {
		const p = await addWorkspaceByPicker();
		if (p) {
			setCwd(p);
			setWsMenu(false);
		}
	};

	const currentLabel = cwd ? (getWorkspaceName ? getWorkspaceName(cwd) : basename(cwd)) : t.startWith;

	return (
		<div className="pw-hero flex h-full min-h-0 flex-col items-center justify-center px-6">
			{/* 品牌行：仅 π 标 */}

			{/* 工作区芯片行 + 输入卡 同宽容器（芯片行与卡片左对齐） */}
			<div className="pw-hero-content w-full flex flex-col items-stretch mx-auto" style={{ maxWidth: "var(--dsh-composer-card-max-width)" }}>
				<div className="pw-hero-intro">
				<div className="pw-hero-identity"><span className="pw-hero-mark" aria-hidden="true"><PiMark size={22} style={{ color: "var(--dsw-accent)" }} /></span><span>PIWEB / WORKBENCH</span><span className="pw-hero-index">01 / READY</span></div>
				<h1 className="pw-hero-title">{t.heroTitle}</h1>
				<p className="pw-hero-description">{t.heroDescription}</p>
				<div ref={menuRef} className="pw-hero-workspace mb-3 flex items-center gap-3">
					<div className="relative">
						<button className="hero-chip" data-open={wsMenu} onClick={() => setWsMenu((v) => !v)}>
							<IconFolderClose16 className="hero-chip-icon" size={16} />
							<span className="max-w-[220px] truncate" suppressHydrationWarning>{currentLabel}</span>
							<span className="chevron">
								<IconChevronDown14 size={14} />
							</span>
						</button>
						{wsMenu && (
							<div className="popover absolute bottom-9 left-0 z-50 w-56 py-1">
								{knownCwds.map((c) => {
									const itemLabel = getWorkspaceName ? getWorkspaceName(c) : basename(c);
									return (
										<button
											key={c}
											className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors"
											style={{
												fontSize: 13,
												background: cwd === c ? "var(--dsw-accent-soft)" : "transparent",
												color: cwd === c ? "var(--dsw-accent)" : "inherit",
											}}
											onMouseEnter={(e) => {
												if (cwd !== c) e.currentTarget.style.background = "var(--dsw-hover)";
											}}
											onMouseLeave={(e) => {
												if (cwd !== c) e.currentTarget.style.background = "transparent";
											}}
											onClick={() => {
												setCwd(c);
												setWsMenu(false);
											}}
										>
											<IconFolderClose16 size={14} style={{ flex: "none", color: cwd === c ? "var(--dsw-accent)" : "var(--dsw-label-tertiary)" }} />
											<span className="min-w-0 flex-1 truncate">{itemLabel}</span>
											{cwd === c && <IconCheckOutline14 size={13} style={{ flex: "none" }} />}
										</button>
									);
								})}
								<div className="my-1" style={{ borderTop: "0.5px solid var(--dsw-border-l2)" }} />
								<button
									className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors"
									style={{ fontSize: 13 }}
									onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
									onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
									onClick={pickWorkspace}
								>
									<IconProjectAddOutline16 size={14} style={{ flex: "none", color: "var(--dsw-label-tertiary)" }} />
									{t.addWorkspace}
								</button>
							</div>
						)}
					</div>
				</div>
				</div>

				{/* 输入卡 */}
				<ChatInput
						draft={draft}
						onDraftChange={onDraftChange}
						onUploadError={onUploadError}
						onUploadProgress={onUploadProgress}
						uploadFailure={uploadFailure}
						pendingUploadCount={pendingUploadCount}
						pendingSend={pendingSend}
						onSendPendingChange={onSendPendingChange}
					commands={commands}
					onCommand={onCommand}
					isStreaming={false}
					contextPercent={null}
					contextTokens={null}
					contextWindow={null}
					contextVisible={false}
					model={heroModel ? models.find((m) => m.provider === heroModel.provider && m.id === heroModel.id) ?? { provider: heroModel.provider, id: heroModel.id, name: heroModel.id, reasoning: false, contextWindow: 0 } : defaultModel}
					thinkingLevel={heroThinking || undefined}
					thinkingLevels={heroModelLevels}
					models={models}
					modelLoading={modelLoading}
					modelLoadError={modelLoadError}
					onRetryModels={onRetryModels}
					providerNames={providerNames}
					authByProvider={authByProvider}
					queue={{ steering: [], followUp: [] }}
					workflow={{ mode: heroMode, planStatus: "idle", goal: "" }}
					onWorkflowModeChange={onSelectHeroMode}
					onSend={onSend}
					onSteer={() => ({ success: false })}
					onAbort={() => {}}
					onSelectModel={onSelectHeroModel}
					onSelectLevel={onSelectHeroThinking}
				/>
			</div>
		</div>
	);
}
