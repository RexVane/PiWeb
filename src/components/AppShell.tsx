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
const TestInspectorPod = dynamic(() => import("@/components/TestInspectorPod").then((m) => m.TestInspectorPod), { ssr: false });
const SwarmCoordinatorPod = dynamic(() => import("@/components/SwarmCoordinatorPod").then((m) => m.SwarmCoordinatorPod), { ssr: false });
import {
	IconAgentPresetOutline16,
	IconArchiveOutline20,
	IconBranchOutline16,
	IconCheckOutline14,
	IconChevronDown14,
	IconFolderClose16,
	IconFolderOpenOutline16,
	IconPanelLeftOutline16,
	IconProjectAddOutline16,
	IconSettingsOutline16,
	IconWorkflowAgent16,
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
	const [activeTopView, setActiveTopView] = useState<"workbench" | "diff" | "tests" | "swarm" | "archive">("workbench");
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
	const activeSnapshot = currentPath && snapshot?.sessionPath && samePath(snapshot.sessionPath, currentPath) ? snapshot : null;
	const activeWorkspaceCwd = currentPath ? (activeSnapshot?.cwd || currentSession?.cwd || "") : heroCwd;

	// Git 面板自动刷新：pi 每完成一个会改动文件的工具，或一轮结束时，静默重拉
	const mutatingDone = useMemo(
		() => Object.values(state.tools).filter((tool) => tool.state === "done" && ["edit", "write", "bash", "powershell", "pwsh"].includes(tool.name.toLowerCase())).length,
		[state.tools],
	);
	const [panelRefreshKey, setPanelRefreshKey] = useState(0);
	const [gitSummary, setGitSummary] = useState<{ available: boolean; isRepo: boolean; branch: string | null; detached: boolean; files: unknown[]; statusError?: string } | null>(null);
	const [gitSummaryError, setGitSummaryError] = useState(false);
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
	useEffect(() => {
		const controller = new AbortController();
		setGitSummary(null);
		setGitSummaryError(false);
		if (!activeWorkspaceCwd) return () => controller.abort();
		void (async () => {
			try {
				const response = await fetch(`/api/git?cwd=${encodeURIComponent(activeWorkspaceCwd)}`, { signal: controller.signal });
				const body = await response.json();
				if (!response.ok || !body.success) throw new Error(body.error || "Git 状态读取失败");
				if (!controller.signal.aborted) setGitSummary(body.data);
			} catch {
				if (!controller.signal.aborted) setGitSummaryError(true);
			}
		})();
		return () => controller.abort();
	}, [activeWorkspaceCwd, panelRefreshKey]);
	const gitBranchLabel = gitSummary?.isRepo ? (gitSummary.detached ? "HEAD" : gitSummary.branch || "—") : "—";
	const gitStatusLabel = !activeWorkspaceCwd ? "未选择"
		: gitSummaryError || gitSummary?.statusError ? "状态未知"
		: !gitSummary ? "读取中"
		: !gitSummary.available ? "Git 不可用"
		: !gitSummary.isRepo ? "非仓库"
		: gitSummary.files.length ? `${gitSummary.files.length} 改动` : "干净";
	const gitCanCommit = Boolean(gitSummary?.isRepo && !gitSummary.statusError && gitSummary.files.length);

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
		async (filePath: string, cwdOverride?: string) => {
			try {
				const r = await fetch("/api/files", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: "open", cwd: cwdOverride || panelCwd, path: filePath }),
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
					gitBranch={gitBranchLabel}
					gitStatus={gitStatusLabel}
					canAskCommit={gitCanCommit}
					onAskCommit={() => { setActiveTopView("workbench"); insertIntoComposer(t.gitAskCommitPrompt); }}
				/>
			</div>

			{/* 四列网格中始终保留项目列，否则关闭项目栏时会话区会落进 0px 列。 */}
			{!isNarrow && (projectColumn || <div aria-hidden="true" />)}

			{/* 会话区与多视图容器 */}
			<div className={`pi-main pw-main flex min-h-0 min-w-0 flex-col${currentId ? "" : " pw-main-hero"}`}>
				{/* 顶部粘土导航栏 (Screen 1 & Screen 2) */}
				<header className="pw-top-navbar flex items-center justify-between px-5 py-2.5 bg-white/75 dark:bg-slate-900/70 backdrop-blur-md border-b border-slate-200/60 dark:border-slate-800/60 z-30 select-none">
					{/* Left: Engine brand badge + breadcrumb */}
					<div className="flex items-center gap-3 min-w-0">
						<div className="clay-badge hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-white/90 dark:bg-slate-800/90 text-[11px] font-mono font-semibold text-slate-700 dark:text-slate-300">
							<span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
							<span>PiWeb</span>
						</div>
						<div className="flex items-center gap-2 text-xs font-medium text-slate-500 min-w-0">
							<span className="font-semibold text-slate-700 dark:text-slate-300">PiWeb</span>
							<span className="text-slate-300 dark:text-slate-600">/</span>
							<span className="truncate max-w-[180px] text-slate-800 dark:text-slate-200 font-medium">
								{currentId ? title : (heroCwd ? (getWorkspaceName ? getWorkspaceName(heroCwd) : basename(heroCwd)) : t.newChat)}
							</span>
							<span className={`w-1.5 h-1.5 rounded-full inline-block flex-none ${state.connected ? "bg-emerald-500" : "bg-slate-400"}`} />
						</div>
					</div>

					{/* Center: View Switcher Pill Tabs */}
					<nav aria-label="视图切换" className="clay-inset flex min-w-0 items-center overflow-x-auto p-1 rounded-full bg-slate-100/90 dark:bg-slate-900/80 gap-1 text-xs font-medium">
						<button
							type="button"
							className={`px-3.5 py-1 rounded-full transition-all duration-150 ${
								activeTopView === "workbench"
									? "clay-btn-peach text-white font-semibold shadow-sm"
									: "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
							}`}
							onClick={() => setActiveTopView("workbench")}
						>
							工作台
						</button>
						<button
							type="button"
							className={`flex items-center gap-1.5 px-3.5 py-1 rounded-full transition-all duration-150 ${
								activeTopView === "diff"
									? "clay-btn-peach text-white font-semibold shadow-sm"
									: "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
							}`}
							onClick={() => { setPanelRefreshKey((key) => key + 1); setActiveTopView("diff"); }}
						>
							<span>差异对比</span>
							<span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
								activeTopView === "diff" ? "bg-white/30 text-white" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
							}`}>
								{gitSummary?.isRepo ? gitSummary.files.length : "—"}
							</span>
						</button>
						<button
							type="button"
							className={`shrink-0 px-3.5 py-1 rounded-full transition-all duration-150 ${
								activeTopView === "tests"
									? "clay-btn-peach text-white font-semibold shadow-sm"
									: "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
							}`}
							onClick={() => setActiveTopView("tests")}
						>
							测试检查器
						</button>
						<button
							type="button"
							className={`flex items-center gap-1.5 px-3.5 py-1 rounded-full transition-all duration-150 ${
								activeTopView === "swarm"
									? "clay-btn-peach text-white font-semibold shadow-sm"
									: "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
							}`}
							onClick={() => setActiveTopView("swarm")}
						>
							<span>智能体群</span>
						</button>
						<button
							type="button"
							className={`px-3.5 py-1 rounded-full transition-all duration-150 ${
								activeTopView === "archive"
									? "clay-btn-peach text-white font-semibold shadow-sm"
									: "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
							}`}
							onClick={() => setActiveTopView("archive")}
						>
							归档
						</button>
					</nav>

					{/* Right: Actions */}
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="clay-badge hidden md:flex items-center gap-1.5 px-3 py-1 text-xs font-mono text-slate-600 dark:text-slate-300 bg-white/80 dark:bg-slate-800/80 hover:bg-white"
							title="Git 工作区状态"
							onClick={() => {
								setPanelRefreshKey((key) => key + 1);
								setSelected(null);
								setGitDetailsOpen((prev) => !prev);
							}}
						>
							<IconBranchOutline16 size={13} className="text-emerald-500" />
							<span>{gitBranchLabel}</span>
							<span className="text-slate-300 dark:text-slate-600">·</span>
							<span className="text-amber-500 font-semibold">{gitStatusLabel}</span>
						</button>
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
						<button
							type="button"
							className="icon-btn"
							style={{ width: 30, height: 30 }}
							title={t.settings}
							aria-label={t.settings}
							onClick={() => setSettingsOpen(true)}
						>
							<IconSettingsOutline16 size={15} />
						</button>
					</div>
				</header>

				{/* 视图内容切换 */}
				{activeTopView === "diff" ? (
					<div className="flex-1 min-h-0 overflow-hidden p-4 sm:p-6 bg-slate-50/50 dark:bg-slate-950/30">
						<div className="clay-card mx-auto h-full max-w-6xl overflow-hidden rounded-3xl bg-white/85 dark:bg-slate-900/80">
							<GitPanel cwd={activeWorkspaceCwd} refreshKey={panelRefreshKey} onClose={() => setActiveTopView("workbench")} onOpenFile={(filePath) => void openInEditor(filePath, activeWorkspaceCwd)} />
						</div>
					</div>
				) : activeTopView === "tests" ? (
					<div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 bg-slate-50/50 dark:bg-slate-950/30">
						<TestInspectorPod cwd={activeWorkspaceCwd} onClose={() => setActiveTopView("workbench")} onSwitchToWorkbench={() => setActiveTopView("workbench")} />
					</div>
				) : activeTopView === "swarm" ? (
					<div className="flex-1 min-h-0 overflow-hidden p-3 sm:p-4 bg-slate-50/50 dark:bg-slate-950/30">
						<SwarmCoordinatorPod
							cwd={activeWorkspaceCwd}
							onClose={() => setActiveTopView("workbench")}
							onSwitchToWorkbench={() => setActiveTopView("workbench")}
							projectTrust={activeSnapshot?.projectTrust}
							onWorkspaceChanged={() => setPanelRefreshKey((key) => key + 1)}
						/>
					</div>
				) : activeTopView === "archive" ? (
					<div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col items-center bg-slate-50/40 dark:bg-slate-950/20">
						<div className="clay-card max-w-2xl w-full p-6 rounded-3xl space-y-4">
							<div className="flex items-center justify-between pb-3 border-b border-slate-200/60 dark:border-slate-800/60">
								<h2 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
									<IconArchiveOutline20 size={18} className="text-slate-400" />
									已归档会话 ({archivedSessions.length})
								</h2>
								<span className="text-xs text-slate-400">保留历史记录，不占用主工作台</span>
							</div>
							{archivedSessions.length === 0 ? (
								<div className="text-center py-12 text-sm text-slate-400">暂无归档会话</div>
							) : (
								<div className="space-y-2">
									{archivedSessions.map((session) => (
										<div
											key={session.path}
											className="clay-card flex items-center justify-between p-3.5 rounded-2xl hover:scale-[1.01] transition-transform"
										>
											<div className="min-w-0 flex-1">
												<div className="font-semibold text-sm text-slate-800 dark:text-slate-200 truncate">{session.name || session.firstMessage || basename(session.path)}</div>
												<div className="text-xs text-slate-400 truncate mt-0.5">{session.cwd}</div>
											</div>
											<div className="flex items-center gap-2 ml-4">
												<button
													type="button"
													className="clay-btn clay-btn-soft px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200"
													onClick={() => {
														doUnarchiveSession(session.path);
														setActiveTopView("workbench");
													}}
												>
													恢复会话
												</button>
												<button
													type="button"
													className="clay-btn clay-btn-peach px-3 py-1.5 text-xs text-white"
													onClick={() => {
														openSession(session.path);
														setActiveTopView("workbench");
													}}
												>
													查看
												</button>
											</div>
										</div>
									))}
								</div>
							)}
						</div>
					</div>
				) : !currentId ? (
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
								onOpenSwarm={() => setActiveTopView("swarm")}
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
							{/* 会话信任横幅 */}
							{projectTrust?.required && !projectTrust.trusted && (
								<div className="mx-5 mt-2 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2" style={{ fontSize: 12.5, background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)" }} role="status">
									<span style={{ color: "var(--dsw-warn)", fontWeight: 600 }}>⚠</span>
									<span className="min-w-0 flex-1">{projectTrust.source === "default-never" || projectTrust.source === "remembered" ? t.projectTrustBannerNever : t.projectTrustBanner}</span>
									<button className="btn-primary-white" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={() => void setProjectTrust(true)}>{t.projectTrustAllow}</button>
									{projectTrust.source === "undecided" && (
										<button className="btn-outline" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={() => void setProjectTrust(false)}>{t.projectTrustDeny}</button>
									)}
								</div>
							)}

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
	onOpenSwarm,
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
	onOpenSwarm?: () => void;
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
		<div className="pw-hero flex h-full min-h-0 flex-col items-center justify-center px-6 py-8 overflow-y-auto">
			{/* 工作区芯片行 + 输入卡 同宽容器 */}
			<div className="pw-hero-content w-full flex flex-col items-stretch mx-auto my-auto" style={{ maxWidth: "var(--dsh-composer-card-max-width)" }}>
				<div className="pw-hero-intro mb-4 text-center">
					<div className="flex items-center justify-center gap-2 mb-2">
						<span className="clay-badge px-3 py-1 flex items-center gap-1.5 bg-white/80 dark:bg-slate-800/80 text-xs font-mono font-semibold text-slate-700 dark:text-slate-300">
							<PiMark size={16} style={{ color: "var(--clay-peach, #FB923C)" }} />
							<span>PIWEB WORKBENCH</span>
						<span className="text-emerald-500 font-bold">LOCAL</span>
						</span>
					</div>
					<h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100 mb-2">
						让想法落到代码
					</h1>
					<p className="text-sm text-slate-500 dark:text-slate-400 max-w-lg mx-auto leading-relaxed">
						基于 Pi 智能体引擎的本地工作台 · 按权限预设调用工具
					</p>

					{/* 工作区选择器 */}
					<div ref={menuRef} className="pw-hero-workspace mt-4 mb-2 flex items-center justify-center">
						<div className="relative">
							<button
								type="button"
								className="clay-btn clay-btn-soft flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-medium text-slate-700 dark:text-slate-200"
								data-open={wsMenu}
								onClick={() => setWsMenu((v) => !v)}
							>
								<IconFolderClose16 className="text-amber-500 flex-none" size={15} />
								<span className="max-w-[240px] truncate" suppressHydrationWarning>{currentLabel}</span>
								<IconChevronDown14 size={13} className="text-slate-400" />
							</button>
							{wsMenu && (
								<div className="clay-card popover absolute top-full left-1/2 -translate-x-1/2 z-50 w-64 mt-2 p-1.5 rounded-2xl shadow-xl">
									<div className="px-3 py-1.5 text-[11px] font-semibold text-slate-400">选择工作区</div>
									{knownCwds.map((c) => {
										const itemLabel = getWorkspaceName ? getWorkspaceName(c) : basename(c);
										return (
											<button
												key={c}
												className="flex w-full items-center gap-2.5 px-3 py-2 text-left rounded-xl transition-colors text-xs"
												style={{
													background: cwd === c ? "var(--dsw-accent-soft)" : "transparent",
													color: cwd === c ? "var(--dsw-accent)" : "inherit",
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
									<div className="my-1 border-t border-slate-200/50 dark:border-slate-800/50" />
									<button
										className="flex w-full items-center gap-2.5 px-3 py-2 text-left rounded-xl transition-colors text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
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

				{/* 3 Quickstarter Bento Cards (Screen 3) */}
				<div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 w-full">
					<button
						type="button"
						className="clay-card flex flex-col items-start p-3.5 rounded-2xl text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md group bg-white/90 dark:bg-slate-900/90 border border-emerald-100/60 dark:border-emerald-950/40"
						onClick={() => {
							onDraftChange((prev) => ({
								...prev,
								text: "请分析当前系统架构，重点评估状态机与分布式调度逻辑，并提出模块化演进方案与优化建议。",
							}));
							const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"] textarea');
							ta?.focus();
						}}
					>
						<div className="flex items-center justify-between w-full mb-1.5">
							<span className="clay-badge px-2 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-300">
								架构重构
							</span>
							<span className="text-emerald-500 opacity-60 group-hover:opacity-100 transition-opacity text-xs">⚡</span>
						</div>
						<div className="font-semibold text-xs text-slate-800 dark:text-slate-100 group-hover:text-emerald-600 transition-colors">
							系统架构演进
						</div>
						<div className="text-[11px] text-slate-500 mt-1 line-clamp-2 leading-relaxed">
							重构状态机与分布式调度逻辑
						</div>
					</button>

					<button
						type="button"
						className="clay-card flex flex-col items-start p-3.5 rounded-2xl text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md group bg-white/90 dark:bg-slate-900/90 border border-orange-100/60 dark:border-orange-950/40"
						onClick={() => {
							onDraftChange((prev) => ({
								...prev,
								text: "请检查当前工作区的 Git 改动，指出可能的行为回归、接口兼容性问题和缺失的测试。",
							}));
							const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"] textarea');
							ta?.focus();
						}}
					>
						<div className="flex items-center justify-between w-full mb-1.5">
							<span className="clay-badge px-2 py-0.5 text-[10px] font-semibold bg-orange-50 text-orange-600 dark:bg-orange-950/60 dark:text-orange-300">
								差异审计
							</span>
							<span className="text-orange-500 opacity-60 group-hover:opacity-100 transition-opacity text-xs">🔍</span>
						</div>
						<div className="font-semibold text-xs text-slate-800 dark:text-slate-100 group-hover:text-orange-600 transition-colors">
							改动审查
						</div>
						<div className="text-[11px] text-slate-500 mt-1 line-clamp-2 leading-relaxed">
							检查当前工作区的 Git 改动与测试风险
						</div>
					</button>

					<button
						type="button"
						className="clay-card flex flex-col items-start p-3.5 rounded-2xl text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md group bg-white/90 dark:bg-slate-900/90 border border-indigo-100/60 dark:border-indigo-950/40"
						onClick={() => {
							onOpenSwarm?.();
						}}
					>
						<div className="flex items-center justify-between w-full mb-1.5">
							<span className="clay-badge px-2 py-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300">
								群组协同
							</span>
							<span className="text-indigo-500 opacity-60 group-hover:opacity-100 transition-opacity text-xs">👥</span>
						</div>
						<div className="font-semibold text-xs text-slate-800 dark:text-slate-100 group-hover:text-indigo-600 transition-colors">
							Swarm 群组协同
						</div>
						<div className="text-[11px] text-slate-500 mt-1 line-clamp-2 leading-relaxed">
							派生隔离工作树，执行并行子任务与补丁审查
						</div>
					</button>
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
