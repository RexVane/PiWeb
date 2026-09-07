"use client";

/**
 * AppShell：三栏网格（对齐 dsh ui-layout 几何）+ 拖拽调宽 + 侧栏窄条 +
 * 头部（对话/轨迹标签 + Session log）+ Hero 新会话页 + 设置弹窗。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PiMark } from "@/components/PiMark";
import { ChatInput } from "@/components/ChatInput";
import { ChatWindow } from "@/components/ChatWindow";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SettingsPanel } from "@/components/SettingsPanel";
import { TrajInspector, TrajectoryView } from "@/components/TrajectoryView";
import {
	IconBranchOutline16,
	IconCheckOutline14,
	IconChevronDown14,
	IconDownloadOutline16,
	IconFolderClose16,
	IconPanelLeftOutline16,
	IconProjectAddOutline16,
} from "@/components/icons";
import { useI18n } from "@/i18n";
import { usePiWeb } from "@/hooks/usePiWeb";
import { applyTheme, type ThemePref } from "@/lib/theme";
import type { ModelChoice } from "@/components/ModelSelector";
import type { ImageAttachment, TrajEntry } from "@/lib/types";

// dsh ui-layout columns.ts 几何常量
const SIDEBAR_MIN = 264;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_COLLAPSED = 56;
const DETAILS_MIN = 300;
const DETAILS_MAX = 520;
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
	} = usePiWeb();

	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [detailsWidth, setDetailsWidth] = useState(DETAILS_DEFAULT);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [dragging, setDragging] = useState<"sidebar" | "details" | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [tab, setTab] = useState<"chat" | "traj">("chat");
	const [selected, setSelected] = useState<TrajEntry | null>(null);
	const [heroCwd, setHeroCwd] = useState("");
	const [heroModel, setHeroModel] = useState<{ provider: string; id: string } | null>(null);
	const [heroThinking, setHeroThinking] = useState("");
	const [branchOpen, setBranchOpen] = useState(false);
	const [branchItems, setBranchItems] = useState<{ entryId: string; ts: number; text: string; depth: number; label?: string }[]>([]);
	const [branchLeafId, setBranchLeafId] = useState("");
	const [branchLoading, setBranchLoading] = useState(false);
	const [branchError, setBranchError] = useState("");
	const [restoredDraft, setRestoredDraft] = useState<{ key: number; text: string } | null>(null);
	const [isNarrow, setIsNarrow] = useState(false);
	const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
	const branchRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!branchOpen) return;
		const h = (e: MouseEvent) => {
			if (!branchRef.current?.contains(e.target as Node)) setBranchOpen(false);
		};
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [branchOpen]);
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

	// 全局外观主题初始化与系统偏好动态监听（对齐 dsh theme-presenter）
	useEffect(() => {
		const sync = () => {
			const pref = (localStorage.getItem("piweb.theme") as ThemePref) || "system";
			applyTheme(pref);
		};
		sync();
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		mq.addEventListener("change", sync);
		const onStorage = (e: StorageEvent) => {
			if (e.key === "piweb.theme") sync();
		};
		window.addEventListener("storage", onStorage);
		return () => {
			mq.removeEventListener("change", sync);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	// 轨迹页选中后展开 details 栏
	useEffect(() => {
		if (selected) setDetailsOpen(true);
	}, [selected]);

	// 已知工作区列表（给 Hero 建议）
	const knownCwds = Array.from(new Set([...addedWorkspaces, ...sessions.map((s) => s.cwd)])).filter(Boolean);

	const authByProvider: Record<string, boolean> = {};
	const providerNames: Record<string, string> = {};
	for (const p of models?.providers ?? []) {
		authByProvider[p.id] = p.authConfigured === true;
		providerNames[p.id] = p.name;
	}
	const modelChoices: ModelChoice[] = (models?.models ?? []).map((m: any) => ({
		provider: m.provider,
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		thinkingLevels: m.thinkingLevels,
		contextWindow: m.contextWindow,
	}));
	const defaultModel = modelChoices.find((m) => authByProvider[m.provider]);
	const heroModelLevels = (heroModel ? modelChoices.find((m) => m.provider === heroModel.provider && m.id === heroModel.id) : defaultModel)?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
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
	const isStreaming = snapshot?.isStreaming ?? false;

	useEffect(() => {
		if (!state.error) return;
		const timer = setTimeout(clearError, 6000);
		return () => clearTimeout(timer);
	}, [state.error, clearError]);

	const doRename = (path: string, newName: string) => {
		if (!newName.trim()) return;
		if (path === currentPath) void sendCommand({ cmd: "rename", text: newName.trim() });
		else {
			// 冷会话：临时走命令路由（会按需打开，不启动 agent 的 rename 走 appendSessionInfo）
			void sendCommand({ cmd: "rename", text: newName.trim() }, encodeURIComponent(b64url(path)));
		}
	};

	const doDelete = (path: string) => {
		if (!window.confirm(t.delete)) return;
		void fetch(`/api/sessions/${encodeURIComponent(b64url(path))}`, { method: "DELETE" }).then(() => {
			if (path === currentPath) closeSession();
			resync();
		});
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
			await archiveSession(path);
			if (path === currentPath) {
				closeSession();
			}
		},
		[archiveSession, currentPath, closeSession],
	);

	const doRenameWorkspace = useCallback(
		(cwd: string, newName: string) => {
			void renameWorkspace(cwd, newName);
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

	const openBranches = useCallback(async () => {
		if (branchOpen) {
			setBranchOpen(false);
			return;
		}
		if (!currentId) return;
		setBranchOpen(true);
		setBranchLoading(true);
		setBranchError("");
		try {
			const response = await fetch(`/api/agent/${currentId}/tree`);
			const result = await response.json();
			if (!response.ok || !result.success) throw new Error(result.error || "failed to load branches");
			setBranchItems(result.data.userMessages ?? []);
			setBranchLeafId(result.data.activeUserId ?? "");
		} catch (error) {
			setBranchError(error instanceof Error ? error.message : "failed to load branches");
		} finally {
			setBranchLoading(false);
		}
	}, [branchOpen, currentId]);

	const navigateBranch = useCallback(async (entryId: string) => {
		const result = await sendCommand({ cmd: "navigate", entryId });
		if (result.success) {
			if (typeof result.data?.editorText === "string") {
				setRestoredDraft({ key: Date.now(), text: result.data.editorText });
			}
			setBranchOpen(false);
			resync();
		}
	}, [sendCommand, resync]);

	// Hero 发送：先完整应用新会话预设，再发第一条消息。
	const heroSend = async (text: string, images: ImageAttachment[]) => {
		const cwd = heroCwd.trim() || knownCwds[0] || "";
		if (!cwd) return;
		const p = await newSession(cwd, {
			provider: heroModel?.provider,
			modelId: heroModel?.id,
			thinking: heroThinking || undefined,
		});
		if (!p) return;
		await sendCommand({ cmd: "prompt", text, images }, encodeURIComponent(b64url(p)));
	};

	const sendPrompt = (text: string, images: ImageAttachment[]) => {
		void sendCommand({ cmd: "prompt", text, images });
	};

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
						setTab("chat");
						closeSession();
					}}
					onNewInWorkspace={(cwd) => {
						setTab("chat");
						void newSession(cwd);
					}}
					onRename={doRename}
					onDelete={doDelete}
					onFork={doForkSession}
					onArchive={doArchiveSession}
					getWorkspaceName={getWorkspaceName}
					onRenameWorkspace={doRenameWorkspace}
					onDeleteWorkspace={doDeleteWorkspace}
					onOpenSettings={() => {
						setSettingsOpen(true);
						setMobileSidebarOpen(false);
					}}
					onAddWorkspace={() => void addWorkspaceByPicker()}
					onRemoveWorkspace={(cwd) => void removeWorkspace(cwd)}
				/>
			</div>

			{/* 会话区 */}
			<div className="pi-main flex min-h-0 min-w-0 flex-col">
				{!currentId ? (
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
				) : (
					<>
						{/* 头部：标题行 + 页签行（dsh 两行式） */}
						<div className="hairline-b px-5 pb-0 pt-3">
							<div className="flex items-center gap-3">
								<span className="min-w-0 flex-1 truncate" style={{ fontSize: 14.5, fontWeight: 600 }}>
									{title}
								</span>
								<div ref={branchRef} className="relative">
									<button className="btn-outline" style={{ height: 30, fontSize: 12.5 }} onClick={() => void openBranches()}>
										<IconBranchOutline16 size={13} />
										{t.branches}
										<IconChevronDown14 size={12} />
									</button>
									{branchOpen && (
										<div className="popover absolute right-0 top-9 z-50 max-h-80 w-80 overflow-y-auto py-1.5">
											{branchLoading && <div className="px-4 py-3" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>...</div>}
											{branchError && <div className="px-4 py-3" role="alert" style={{ fontSize: 12, color: "var(--dsw-danger)" }}>{branchError}</div>}
											{!branchLoading && !branchError && branchItems.length === 0 && (
												<div className="px-4 py-3" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.noBranches}</div>
											)}
											{branchItems.map((item, index) => (
												<button
													key={item.entryId}
													className="flex w-full items-start gap-3 px-4 py-2.5 text-left"
													style={{ background: item.entryId === branchLeafId ? "var(--dsw-accent-soft)" : "transparent" }}
													disabled={item.entryId === branchLeafId || isStreaming}
													onClick={() => void navigateBranch(item.entryId)}
												>
													<span style={{ fontSize: 11, color: "var(--dsw-label-caption)", flex: "none", marginLeft: Math.min(item.depth, 8) * 10 }}>{index + 1}</span>
													<span className="line-clamp-2 min-w-0 flex-1" style={{ fontSize: 12.5 }}>{item.label ? `${item.label}: ` : ""}{item.text || "..."}</span>
													{item.entryId === branchLeafId && <IconCheckOutline14 size={13} style={{ flex: "none", color: "var(--dsw-accent)" }} />}
												</button>
											))}
										</div>
									)}
								</div>
								<button
									className="btn-outline"
									style={{ height: 30, fontSize: 12.5 }}
									onClick={() => currentId && window.open(`/api/sessions/${currentId}/export?format=jsonl`, "_blank")}
									title={t.exportJsonl}
								>
									<IconDownloadOutline16 size={13} />
									{t.sessionLog}
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
							<div className="flex min-h-0 flex-1 flex-col justify-end">
								<ChatWindow
									messages={state.messages}
									tools={state.tools}
									stats={snapshot?.stats ?? null}
									queue={snapshot?.queue ?? { steering: [], followUp: [] }}
									contextFiles={snapshot?.contextFiles ?? []}
								/>
								<div className="px-4 pb-3 pt-2">
									<div className="mx-auto w-full" style={{ maxWidth: "var(--dsh-composer-card-max-width)" }}>
										<ChatInput
											isStreaming={isStreaming}
											contextPercent={snapshot?.contextUsage?.percent ?? null}
											contextTokens={snapshot?.contextUsage?.tokens ?? null}
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
											onCompact={() => void sendCommand({ cmd: "compact" })}
											onSelectModel={(provider, id) => void sendCommand({ cmd: "setModel", provider, modelId: id })}
											onSelectLevel={(level) => void sendCommand({ cmd: "setThinkingLevel", level })}
											onCycleModel={(direction) => void sendCommand({ cmd: "cycleModel", direction })}
											onClearQueue={() => void sendCommand({ cmd: "clearQueue" })}
											draft={restoredDraft}
										/>
									</div>
								</div>
							</div>
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

			{/* details 栏 */}
			{detailsOpen && (
				<div
					className="min-h-0 overflow-hidden"
					style={isNarrow ? {
						position: "fixed",
						inset: "0 0 0 auto",
						width: "min(92vw, 520px)",
						zIndex: 90,
						background: "var(--dsw-sidebar-fill)",
						boxShadow: "var(--dsw-elevation-prominent)",
					} : { background: "var(--dsw-sidebar-fill)", borderLeft: "0.5px solid var(--dsw-border-l2)" }}
				>
					{selected ? (
						<TrajInspector
							entry={selected}
							onClose={() => {
								setSelected(null);
								setDetailsOpen(false);
							}}
						/>
					) : (
						<SessionInfoPane
							name={snapshot?.name ?? ""}
							cwd={snapshot?.cwd ?? ""}
							model={snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "—"}
							stats={snapshot?.stats ?? null}
							onClose={() => setDetailsOpen(false)}
						/>
					)}
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
				onClose={() => setSettingsOpen(false)}
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
			{state.error && (
				<button
					className="fixed bottom-5 right-5 z-[140] max-w-md rounded-2xl px-4 py-3 text-left"
					style={{ background: "var(--dsw-danger)", color: "white", boxShadow: "var(--dsw-elevation-prominent)", fontSize: 13 }}
					onClick={clearError}
					role="alert"
				>
					{state.error}
				</button>
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
					disabled={!cwd.trim()}
					isStreaming={false}
					contextPercent={null}
					contextTokens={null}
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
					onCompact={() => {}}
					onSelectModel={onSelectHeroModel}
					onSelectLevel={onSelectHeroThinking}
				/>
			</div>
		</div>
	);
}

function SessionInfoPane({
	name,
	cwd,
	model,
	stats,
	onClose,
}: {
	name: string;
	cwd: string;
	model: string;
	stats: { userMessages: number; toolCalls: number; tokens: { input: number; output: number; cacheRead: number }; cost: number } | null;
	onClose: () => void;
}) {
	const { t } = useI18n();
	return (
		<div className="flex h-full flex-col p-4">
			<div className="mb-3 flex items-center justify-between">
				<span style={{ fontSize: 13, fontWeight: 600 }}>{name || t.sessionLog}</span>
				<button className="icon-btn" onClick={onClose} style={{ width: 22, height: 22 }}>
					<IconChevronDown14 size={13} />
				</button>
			</div>
			<div className="flex flex-col gap-2" style={{ fontSize: 12, color: "var(--dsw-label-secondary)" }}>
				<div>
					<span style={{ color: "var(--dsw-label-caption)" }}>{t.workspaces}: </span>
					<span className="break-all">{cwd ? basename(cwd) : "—"}</span>
				</div>
				<div>
					<span style={{ color: "var(--dsw-label-caption)" }}>model: </span>
					{model}
				</div>
				{stats && (
					<div>
						<span style={{ color: "var(--dsw-label-caption)" }}>
							{t.turns}:{" "}
						</span>
						{stats.userMessages} · {t.toolCalls} {stats.toolCalls} · ${stats.cost.toFixed(4)}
					</div>
				)}
			</div>
		</div>
	);
}
