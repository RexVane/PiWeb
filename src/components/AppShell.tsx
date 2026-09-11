"use client";

/**
 * AppShell：三栏网格（对齐 dsh ui-layout 几何）+ 拖拽调宽 + 侧栏窄条 +
 * 头部（对话/轨迹标签 + Session log）+ Hero 新会话页 + 设置弹窗。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PiMark } from "@/components/PiMark";
import { ChatInput } from "@/components/ChatInput";
import { ChatWindow, SessionStatsBar } from "@/components/ChatWindow";
import { FilesPanel } from "@/components/FilesPanel";
import { GitPanel } from "@/components/GitPanel";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SettingsPanel } from "@/components/SettingsPanel";
import { TrajInspector, TrajectoryView } from "@/components/TrajectoryView";
import {
	IconCheckOutline14,
	IconChevronDown14,
	IconDataOutline16,
	IconFolderClose16,
	IconFolderOpenOutline16,
	IconGitOutline16,
	IconPanelLeftOutline16,
	IconProjectAddOutline16,
} from "@/components/icons";
import { useI18n } from "@/i18n";
import { usePiWeb } from "@/hooks/usePiWeb";
import { syncPebrelTheme } from "@/lib/theme";
import type { ModelChoice } from "@/components/ModelSelector";
import type { ImageAttachment, TrajEntry } from "@/lib/types";

// dsh ui-layout columns.ts 几何常量
const SIDEBAR_MIN = 264;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_COLLAPSED = 56;
const DETAILS_MIN = 300;
const DETAILS_MAX = 760;
const DETAILS_DEFAULT = 360;
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
		archivedSessions,
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
		setError,
	} = usePiWeb();

	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [detailsWidth, setDetailsWidth] = useState(DETAILS_DEFAULT);
	const [detailsOpen, setDetailsOpen] = useState(false);
	/** 详情栏页签：轨迹 inspector / 文件 / Git（三者共用右侧一栏） */
	const [detailsTab, setDetailsTab] = useState<"traj" | "files" | "git">("traj");
	/** 注入输入框的文本（文件引用、让 pi 提交） */
	const [composerInsert, setComposerInsert] = useState<{ key: number; text: string } | null>(null);
	const [dragging, setDragging] = useState<"sidebar" | "details" | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [tab, setTab] = useState<"chat" | "traj">("chat");
	const [selected, setSelected] = useState<TrajEntry | null>(null);
	const [heroCwd, setHeroCwd] = useState("");
	const [heroModel, setHeroModel] = useState<{ provider: string; id: string } | null>(null);
	const [heroThinking, setHeroThinking] = useState("");
	const [isNarrow, setIsNarrow] = useState(false);
	const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
	useEffect(() => {
		setSidebarWidth(restore("piweb.sidebarW", SIDEBAR_DEFAULT));
		setDetailsWidth(restore("piweb.detailsW", DETAILS_DEFAULT));
		setSidebarCollapsed(localStorage.getItem("piweb.sidebarCollapsed") === "1");
	}, []);

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

	// 轨迹页选中后展开 details 栏并切到轨迹页签
	useEffect(() => {
		if (selected) {
			setDetailsTab("traj");
			setDetailsOpen(true);
		}
	}, [selected]);

	useEffect(() => {
		setSelected(null);
		setDetailsOpen(false);
	}, [currentPath]);

	// 已知工作区列表（给 Hero 建议）；启动不预选任何工作区，
	// 未选择时输入框仍可用，发送会提示先选择工作区
	const knownCwds = useMemo(
		() => Array.from(new Set([...addedWorkspaces, ...sessions.map((s) => s.cwd)])).filter(Boolean),
		[addedWorkspaces, sessions],
	);

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
		(side: "sidebar" | "details") => (e: React.PointerEvent) => {
			e.preventDefault();
			setDragging(side);
			const startX = e.clientX;
			const startW = side === "sidebar" ? sidebarWidth : detailsWidth;
			const move = (ev: PointerEvent) => {
				if (side === "sidebar") {
					const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)));
					setSidebarWidth(w);
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
		[sidebarWidth, detailsWidth],
	);

	useEffect(() => {
		if (dragging === "sidebar") persist("piweb.sidebarW", sidebarWidth);
		if (dragging === "details") persist("piweb.detailsW", detailsWidth);
	}, [dragging, sidebarWidth, detailsWidth]);

	const toggleSidebar = () => {
		const next = !sidebarCollapsed;
		setSidebarCollapsed(next);
		localStorage.setItem("piweb.sidebarCollapsed", next ? "1" : "0");
	};

	// ---------- 会话操作 ----------
	const snapshot = state.snapshot;

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

	const doArchiveSession = useCallback(
		async (path: string) => {
			try {
				// dsh 合同：归档不关会话——当前会话被归档后保持打开且在主列表可见
				// （usePiWeb 的可见性规则对 currentPath 豁免），继续可聊。
				await archiveSession(path);
			} catch {
				// usePiWeb exposes the request failure in the shared error banner.
			}
		},
		[archiveSession],
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
			return;
		}
		// 用户没手动选过模型时也要把界面显示的默认模型显式下发，
		// 否则后端不 setModel、SDK 自选的默认与界面显示不一致。
		const effective = heroModel ?? (defaultModel ? { provider: defaultModel.provider, id: defaultModel.id } : null);
		const p = await newSession(cwd, {
			provider: effective?.provider,
			modelId: effective?.id,
			thinking: heroThinking || undefined,
		});
		if (!p) return;
		await sendCommand({ cmd: "prompt", text, images }, encodeURIComponent(b64url(p)));
	};

	const sendPrompt = (text: string, images: ImageAttachment[]) => {
		void sendCommand({ cmd: "prompt", text, images });
	};

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

	// 斜杠命令（Web 内置 + pi 模板 + 技能），照 dsh 命令面板
	const slashCommands = useMemo(() => {
		const list: { name: string; desc: string; kind: "builtin" | "template" | "skill" }[] = [
			{ name: "compact", desc: t.cmdCompact, kind: "builtin" },
			{ name: "export", desc: t.cmdExport, kind: "builtin" },
			{ name: "model", desc: t.cmdModel, kind: "builtin" },
			{ name: "new", desc: t.cmdNew, kind: "builtin" },
			{ name: "fork", desc: t.cmdFork, kind: "builtin" },
			...(snapshot?.promptTemplates ?? []).map((p) => ({ name: p.name, desc: p.description, kind: "template" as const })),
			...(snapshot?.skills ?? []).map((s) => ({ name: `skill:${s.name}`, desc: s.description, kind: "skill" as const })),
		];
		return list.sort((a, b) => a.name.localeCompare(b.name));
	}, [snapshot, t]);

	const runSlashCommand = useCallback(
		(name: string) => {
			if (name === "compact") void sendCommand({ cmd: "compact" });
			else if (name === "export" && currentId) window.open(`/api/sessions/${currentId}/export?format=jsonl`, "_blank");
			else if (name === "new") {
				setTab("chat");
				closeSession();
			} else if (name === "fork" && currentId) {
				void sendCommand({ cmd: "fork" }).then((r) => {
					if (r.success && r.data?.sessionPath) openSession(r.data.sessionPath);
				});
			}
		},
		[sendCommand, currentId, closeSession, openSession],
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

	// 详情栏文件/Git 面板的工作区：当前会话的工作区优先，快照未到时回落到会话列表里的 cwd
	const panelCwd = snapshot?.cwd || currentSession?.cwd || heroCwd || knownCwds[0] || "";

	// 文件 / Git 面板自动刷新：pi 每完成一个会改动文件的工具，或一轮结束时，静默重拉
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

	// 本会话被 pi 改过的文件（相对工作区，"/" 分隔），文件面板用来打标记
	const changedPaths = useMemo(() => {
		const out = new Set<string>();
		const root = panelCwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		for (const tool of Object.values(state.tools)) {
			if (tool.state !== "done" || !["edit", "write"].includes(tool.name.toLowerCase())) continue;
			const a = tool.args as { path?: unknown; file_path?: unknown } | undefined;
			const raw = a?.path ?? a?.file_path;
			if (typeof raw !== "string" || !raw) continue;
			let rel = raw.replace(/\\/g, "/");
			if (root && rel.toLowerCase().startsWith(`${root}/`)) rel = rel.slice(root.length + 1);
			if (/^[A-Za-z]:\//.test(rel) || rel.startsWith("/")) continue;
			out.add(rel.replace(/^\.\//, ""));
		}
		return out;
	}, [state.tools, panelCwd]);

	const insertIntoComposer = useCallback((text: string) => setComposerInsert({ key: Date.now(), text }), []);
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
	const openDetails = useCallback((tabName: "traj" | "files" | "git") => {
		setDetailsTab(tabName);
		setDetailsOpen(true);
	}, []);

	useEffect(() => {
		document.title = currentId && title && title !== "pi" ? `${title} · pi` : "pi";
	}, [currentId, title]);

	// 三栏网格
	const gridCols = isNarrow ? "minmax(0,1fr)" : `${sidebarCollapsed ? SIDEBAR_COLLAPSED : sidebarWidth}px minmax(0,1fr) ${
		detailsOpen ? `${detailsWidth}px` : "0px"
	}`;

	return (
		<div
			className="grid h-screen w-screen overflow-hidden"
			style={{
				gridTemplateColumns: gridCols,
				transition: dragging ? "none" : "grid-template-columns var(--ds-duration-slow) var(--ds-ease-in-out)",
				background: "var(--dsw-bg-base)",
			}}
		>
			{/* 侧栏 */}
			<div
				className="min-h-0 overflow-hidden"
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
						setTab("chat");
						const cur = sessions.find((s) => s.path === currentPath)?.cwd;
						setHeroCwd(cur || heroCwd || knownCwds[0] || "");
						closeSession();
					}}
					onNewInWorkspace={(cwd) => {
						// dsh 惰性新建：只预选工作区进草稿态，发送第一条消息才真正创建会话
						setTab("chat");
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

			{/* 会话区 */}
			<div className="pi-main flex min-h-0 min-w-0 flex-col">
				{!currentId ? (
					<div className="flex min-h-0 flex-1 flex-col">
						<Hero
							cwd={heroCwd}
							setCwd={setHeroCwd}
							knownCwds={knownCwds}
							getWorkspaceName={getWorkspaceName}
							onSend={heroSend}
							models={modelChoices}
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
							<div className="hairline-b px-5 pb-0 pt-3">
								<div className="flex items-center gap-3">
									<span className="min-w-0 flex-1 truncate" style={{ fontSize: 14.5, fontWeight: 600 }}>
										{title}
									</span>
									{/* 右侧详情栏（轨迹 / 文件 / Git 三页签）开关 */}
									<button
										type="button"
										className="icon-btn"
										style={{ width: 30, height: 30, background: detailsOpen ? "var(--dsw-active)" : undefined }}
										title={t.detailsPanel}
										aria-label={t.detailsPanel}
										aria-pressed={detailsOpen}
										onClick={() => setDetailsOpen((open) => !open)}
									>
										<IconDataOutline16 size={15} />
									</button>
									<button
										type="button"
										className="icon-btn"
										style={{ width: 30, height: 30, background: detailsOpen && detailsTab === "files" ? "var(--dsw-active)" : undefined }}
										title={t.filesPanel}
										aria-label={t.filesPanel}
										onClick={() => (detailsOpen && detailsTab === "files" ? setDetailsOpen(false) : openDetails("files"))}
									>
										<IconFolderOpenOutline16 size={15} />
									</button>
									<button
										type="button"
										className="icon-btn"
										style={{ width: 30, height: 30, background: detailsOpen && detailsTab === "git" ? "var(--dsw-active)" : undefined }}
										title={t.gitPanel}
										aria-label={t.gitPanel}
										onClick={() => (detailsOpen && detailsTab === "git" ? setDetailsOpen(false) : openDetails("git"))}
									>
										<IconGitOutline16 size={15} />
									</button>
								</div>
							<div className="mt-1.5 flex items-center gap-5">
								<button className="tab-underline" data-active={tab === "chat"} onClick={() => setTab("chat")}>
									{t.tabChat}
								</button>
								<button
									className="tab-underline"
									data-active={tab === "traj"}
									onClick={() => {
										setTab("traj");
										void sendCommand({ cmd: "prepare" }).then((result) => {
											if (result.success) resync();
										});
									}}
								>
									{t.tabTrajectory}
								</button>
							</div>
						</div>

						{/* 内容 */}
						{tab === "chat" ? (
							!snapshot ? (
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
									queue={snapshot?.queue ?? { steering: [], followUp: [] }}
									contextFiles={snapshot?.contextResources ?? snapshot?.contextFiles ?? []}
									isStreaming={isStreaming}
									error={state.error}
									connected={state.connected}
									onClearError={clearError}
									retryNotice={state.retryNotice}
									stats={snapshot?.stats ?? null}
									trajectory={snapshot?.trajectory ?? []}
									onRetry={(text) => sendPrompt(text, [])}
									onAbort={() => void sendCommand({ cmd: "abort" })}
									onOpenTrajectory={(toolCallId) => {
										const entry = (snapshot?.trajectory ?? []).find((e) => e.toolCallId === toolCallId);
										if (entry) {
											setSelected(entry);
											openDetails("traj");
										}
									}}
									onOpenFile={openInEditor}
									onFork={handleFork}
								/>
								<div className="px-4 pb-3 pt-2">
									<div className="mx-auto w-full" style={{ maxWidth: "var(--dsh-composer-card-max-width)" }}>
										{/* 运行状态指示由 ChatWindow 内的 WorkingIndicator 承担（含工具/输出 token 信息） */}
										<ChatInput
											insert={composerInsert}
											isStreaming={isStreaming}
											contextPercent={snapshot?.contextUsage?.percent ?? null}
											contextTokens={snapshot?.contextUsage?.tokens ?? null}
											contextWindow={snapshot?.contextUsage?.contextWindow ?? null}
											contextSource={{ systemChars: contextSystemChars, messages: state.messages }}
											contextVisible={(snapshot?.messages?.length ?? 0) > 0}
											model={snapshot?.model}
											thinkingLevel={snapshot?.thinkingLevel}
											thinkingLevels={snapshot?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]}
											models={modelChoices}
											providerNames={providerNames}
											authByProvider={authByProvider}
											queue={snapshot?.queue ?? { steering: [], followUp: [] }}
											commands={slashCommands}
											onCommand={runSlashCommand}
											onSend={sendPrompt}
											onSteer={(text, images) => void sendCommand({ cmd: "prompt", text, images, behavior: "steer" })}
											onFollowUp={(text, images) => void sendCommand({ cmd: "prompt", text, images, behavior: "followUp" })}
											onAbort={() => void sendCommand({ cmd: "abort" })}
											onSelectModel={(provider, id) => void sendCommand({ cmd: "setModel", provider, modelId: id })}
											onSelectLevel={(level) =>
												void sendCommand({ cmd: "setThinkingLevel", level }).then((r) => {
													// 后端按 pi 规则就近钳制；被调整时明确告知，不再“选了没反应”
													if (r?.success && r.data?.clamped) setError(t.thinkingClamped.replace("{requested}", level).replace("{level}", String(r.data.thinkingLevel)));
												})
											}
											onClearQueue={() => void sendCommand({ cmd: "clearQueue" })}
										/>
										<SessionStatsBar stats={snapshot?.stats ?? null} />
									</div>
								</div>
							</div>
							)
						) : (
							<div className="min-h-0 flex-1">
								<TrajectoryView
									entries={snapshot?.trajectory ?? []}
									selected={selected}
									onSelect={setSelected}
								/>
							</div>
						)}
					</>
				)}
			</div>

			{/* details 栏：轨迹 / 文件 / Git 三页签共用 */}
			{detailsOpen && (
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
					<div className="hairline-b flex items-center gap-4 px-4 pt-2.5" style={{ flex: "none" }}>
						{([
							{ id: "traj" as const, label: t.detailsTabTraj },
							{ id: "files" as const, label: t.filesPanel },
							{ id: "git" as const, label: t.gitPanel },
						]).map((tabItem) => (
							<button
								key={tabItem.id}
								className="tab-underline"
								data-active={detailsTab === tabItem.id}
								style={{ fontSize: 13 }}
								onClick={() => setDetailsTab(tabItem.id)}
							>
								{tabItem.label}
							</button>
						))}
					</div>
					<div className="min-h-0 flex-1">
						{detailsTab === "traj" ? (
							selected ? (
								<TrajInspector
									entry={selected}
									onClose={() => {
										setSelected(null);
										setDetailsOpen(false);
									}}
								/>
							) : (
								<div className="p-4" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", lineHeight: 1.6 }}>{t.detailsTrajHint}</div>
							)
						) : detailsTab === "files" ? (
							<FilesPanel
								cwd={panelCwd}
								refreshKey={panelRefreshKey}
								changedPaths={changedPaths}
								onReference={insertIntoComposer}
								onOpenFile={openInEditor}
								onClose={() => setDetailsOpen(false)}
							/>
						) : (
							<GitPanel
								cwd={panelCwd}
								refreshKey={panelRefreshKey}
								onAskCommit={() => insertIntoComposer(t.gitAskCommitPrompt)}
								onOpenFile={openInEditor}
								onClose={() => setDetailsOpen(false)}
							/>
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
			{!isNarrow && detailsOpen && (
				<div
					className="fixed top-0 h-full w-2 cursor-col-resize"
					style={{ left: `calc(100vw - ${detailsWidth}px - 4px)`, zIndex: 40 }}
					onPointerDown={onDrag("details")}
				/>
			)}

			<SettingsPanel
				open={settingsOpen}
				onClose={() => {
					setSettingsOpen(false);
					// 模型配置可能在设置里被改动（API key / OAuth / 自定义 provider）：
					// 关闭时刷新全局模型目录，否则输入卡/新会话页的模型菜单停留在旧目录。
					void refreshModels();
				}}
				cwd={snapshot?.cwd || heroCwd || knownCwds[0] || ""}
				toolPreset={state.toolPreset}
				onToolPresetChange={setToolPreset}
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
	cwd,
	setCwd,
	knownCwds,
	getWorkspaceName,
	onSend,
	models,
	providerNames,
	authByProvider,
	addWorkspaceByPicker,
	heroModel,
	onSelectHeroModel,
	defaultModel,
	heroModelLevels,
	heroThinking,
	onSelectHeroThinking,
}: {
	cwd: string;
	setCwd: (v: string) => void;
	knownCwds: string[];
	getWorkspaceName?: (cwd: string) => string;
	onSend: (text: string, images: ImageAttachment[]) => void;
	models: ModelChoice[];
	providerNames: Record<string, string>;
	authByProvider: Record<string, boolean>;
	addWorkspaceByPicker: () => Promise<string | null>;
	heroModel: { provider: string; id: string } | null;
	onSelectHeroModel: (provider: string, id: string) => void;
	defaultModel?: ModelChoice;
	heroModelLevels: string[];
	heroThinking: string;
	onSelectHeroThinking: (level: string) => void;
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
		<div className="flex h-full min-h-0 flex-col items-center justify-center px-6">
			{/* 品牌行：仅 π 标 */}
			<div className="mb-5 flex items-center justify-center gap-3">
				<PiMark size={40} />
			</div>

			{/* 工作区芯片行 + 输入卡 同宽容器（芯片行与卡片左对齐） */}
			<div className="w-full flex flex-col items-stretch mx-auto" style={{ maxWidth: "var(--dsh-composer-card-max-width)" }}>
				<div ref={menuRef} className="mb-3 flex items-center gap-3" style={{ paddingLeft: 7 }}>
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

				{/* 输入卡 */}
				<ChatInput
					isStreaming={false}
					contextPercent={null}
					contextTokens={null}
					contextWindow={null}
					contextVisible={false}
					model={heroModel ? models.find((m) => m.provider === heroModel.provider && m.id === heroModel.id) ?? { provider: heroModel.provider, id: heroModel.id, name: heroModel.id, reasoning: false, contextWindow: 0 } : defaultModel}
					thinkingLevel={heroThinking || undefined}
					thinkingLevels={heroModelLevels}
					models={models}
					providerNames={providerNames}
					authByProvider={authByProvider}
					queue={{ steering: [], followUp: [] }}
					onSend={onSend}
					onSteer={() => {}}
					onAbort={() => {}}
					onSelectModel={onSelectHeroModel}
					onSelectLevel={onSelectHeroThinking}
				/>
			</div>
		</div>
	);
}
