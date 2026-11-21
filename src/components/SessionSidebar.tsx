"use client";

import { safeLocalStorage } from "@/lib/browser-storage";
import { archivedSessionPathKey as normPath, sortArchivedSessions } from "@/lib/archived-sessions-sort";
import { htmlLangOf, type Lang } from "@/lib/lang";

/**
 * 侧栏 —— 照抄 dsh ui-sidebar：
 * 品牌行（mark + 字标 + 描边徽章 + 侧栏开合）、新会话按钮（h38 r12），
 * 工作区标题行（搜索 / 滑杆菜单 / 添加工作区=原生文件夹选择器），
 * 工作区树（▶/▼ 三角 + 文件夹 + 名称；展开行 hover 显 … 和 ＋；会话缩进 + 相对时间），
 * 搜索模式（输入框替身标题行，空查询=工作区平铺，输入=会话平铺），
 * 滑杆菜单（分组方式：按工作区/单列表；排序方式：手动排序/最近更新）。
 */
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrandPi, PiMark } from "@/components/PiMark";
import {
	IconArchiveOutline20,
	IconBranchOutline16,
	IconCheckOutline14,
	IconClockOutline16,
	IconDownloadOutline16,
	IconEditOutline16,
	IconEllipsisOutline16,
	IconFileOutline16,
	IconFolderClose16,
	IconFolderOpenOutline16,
	IconNewChatOutline16,
	IconPanelLeftOutline16,
	IconPersonalizationOutline16,
	IconPinFill16,
	IconPinOutline16,
	IconPluginOutline16,
	IconCubeOutline16,
	IconPlusOutline16,
	IconProjectAddOutline16,
	IconSearchOutline16,
	IconCloseOutline14,
	IconSettingsOutline16,
	IconSkillOutline16,
	IconTrashOutline16,
	IconTriangleRightFill14,
} from "@/components/icons";
import { useI18n } from "@/i18n";
import type { SessionListItem } from "@/hooks/usePiWeb";
import { useDialog } from "@/hooks/useDialog";

const REL_TIME_UNITS: Record<Lang, { now: string; minute: string; hour: string; day: string; month: string }> = {
	zh: { now: "刚刚", minute: "分钟", hour: "小时", day: "天", month: "个月" },
	"zh-Hant": { now: "剛剛", minute: "分鐘", hour: "小時", day: "天", month: "個月" },
	en: { now: "now", minute: "m", hour: "h", day: "d", month: "mo" },
	ja: { now: "たった今", minute: "分", hour: "時間", day: "日", month: "か月" },
	ru: { now: "только что", minute: " мин", hour: " ч", day: " дн", month: " мес" },
};

function relTime(timestamp: number, lang: Lang, now: number): string {
	const d = Math.max(0, now - timestamp);
	const units = REL_TIME_UNITS[lang];
	const m = Math.floor(d / 60000);
	if (m < 1) return units.now;
	if (m < 60) return `${m}${units.minute}`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}${units.hour}`;
	const days = Math.floor(h / 24);
	if (days < 30) return `${days}${units.day}`;
	return `${Math.floor(days / 30)}${units.month}`;
}

function basename(p: string): string {
	const norm = p.replace(/\\/g, "/");
	return norm.split("/").filter(Boolean).pop() ?? norm;
}

type GroupBy = "workspace" | "flat";
type OrderBy = "updated" | "manual";
export type WorkspaceView = "chat" | "skills" | "plugins" | "prompts" | `resource:${string}`;

interface WorkspaceGroup {
	cwd: string;
	sessions: SessionListItem[];
	lastModified: string;
}

function SessionSidebarImpl({
	sessions,
	sessionListError,
	workspaceRegistryWarning,
	onRetrySessionList,
	onSearchQuery,
	onLoadMore,
	hasMore = false,
	loadingMore = false,
	archivedSessions = [],
	archivedPaths = [],
	archivedAt = {},
	pinnedPaths = [],
	addedWorkspaces,
	removedWorkspaces = [],
	currentPath,
	groupBy,
	orderBy,
	setGroupBy,
	setOrderBy,
	collapsed,
	onToggleCollapse,
	onOpen,
	onNew,
	onNewInWorkspace,
	onRename,
	onFork,
	onArchive,
	onUnarchive,
	onPin,
	onUnpin,
	onDelete,
	onExport,
	getWorkspaceName,
	onRenameWorkspace,
	onDeleteWorkspace,
	onOpenSettings,
	onAddWorkspace,
	draftCwd,
	activeView = "chat",
	onSelectView,
	resourcePanels = [],
}: {
	sessions: SessionListItem[];
	sessionListError?: string | null;
	workspaceRegistryWarning?: string | null;
	onRetrySessionList?: () => void;
	/** 有此回调时由服务端搜索全量（含归档）会话，传入 sessions 就是匹配结果。 */
	onSearchQuery?: (query: string) => void;
	onLoadMore?: () => void;
	hasMore?: boolean;
	loadingMore?: boolean;
	archivedSessions?: SessionListItem[];
	/** 原始归档路径（含被豁免的当前会话：dsh 合同下主列表可见但菜单显示取消归档） */
	archivedPaths?: string[];
	/** 服务端返回的归档起算时间，已包含归档后的文件更新。 */
	archivedAt?: Record<string, number>;
	/** 置顶会话路径列表 */
	pinnedPaths?: string[];
	addedWorkspaces: string[];
	removedWorkspaces?: string[];
	currentPath: string | null;
	groupBy: GroupBy;
	orderBy: OrderBy;
	setGroupBy: (v: GroupBy) => void;
	setOrderBy: (v: OrderBy) => void;
	collapsed: boolean;
	onToggleCollapse: () => void;
	onOpen: (path: string) => void;
	onNew: () => void;
	onNewInWorkspace: (cwd: string) => void;
	onRename: (path: string, newName: string) => Promise<void>;
	onFork?: (path: string, cwd: string) => void;
	onArchive?: (path: string) => void | Promise<void>;
	onUnarchive?: (path: string) => void;
	onPin?: (path: string) => void | Promise<void>;
	onUnpin?: (path: string) => void | Promise<void>;
	/** 确认后把会话文件移到系统回收站；失败时抛出，确认框里显示错误 */
	onDelete?: (path: string) => Promise<void>;
	/** 下载会话日志（JSONL 导出，经 AppShell 统一编码会话 id） */
	onExport?: (path: string) => void;
	getWorkspaceName?: (cwd: string) => string;
	onRenameWorkspace?: (cwd: string, newName: string) => Promise<void>;
	onDeleteWorkspace?: (cwd: string) => Promise<void>;
	onOpenSettings: () => void;
	onAddWorkspace: () => void;
	/** 新会话草稿所在的工作区：条目显示在该分组内，发送第一条消息才真正创建 */
	draftCwd?: string | null;
	/** 当前主区域展示的视图：会话对话或顶部工作区视图 */
	activeView?: WorkspaceView;
	onSelectView?: (view: Exclude<WorkspaceView, "chat">) => void;
	/** 已启用的资源面板（placement=panel）：在侧栏各占一项，点开在主区域渲染 */
	resourcePanels?: { id: string; label: string; icon?: React.ReactNode }[];
}) {
	const { t, lang } = useI18n();
	const [q, setQ] = useState("");
	const deferredQ = useDeferredValue(q);
	const [searchOpen, setSearchOpen] = useState(false);
	const [viewMenu, setViewMenu] = useState(false);
	const [rowMenu, setRowMenu] = useState<string | null>(null); // 展开工作区行菜单的 cwd
	const [sessionMenu, setSessionMenu] = useState<string | null>(null); // 展开会话行菜单的 session path
	const [archiveOpen, setArchiveOpen] = useState(false);
	const [timeNow, setTimeNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setTimeNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, []);
	const sortedArchivedSessions = useMemo(
		() => sortArchivedSessions(archivedSessions, archivedAt, archivedPaths),
		[archivedSessions, archivedAt, archivedPaths],
	);
	useEffect(() => {
		if (!searchOpen || !q.trim()) { onSearchQuery?.(""); return; }
		const timer = setTimeout(() => onSearchQuery?.(q.trim()), 300);
		return () => clearTimeout(timer);
	}, [onSearchQuery, searchOpen, q]);
	const menuRef = useRef<HTMLDivElement>(null);
	const sessionMenuRef = useRef<HTMLDivElement>(null);
	const deleteSessionDialogRef = useRef<HTMLDivElement>(null);
	const deleteWorkspaceDialogRef = useRef<HTMLDivElement>(null);

	// 自定义弹窗状态（重命名与删除工作区）
	const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
	const [deleteWorkspaceTarget, setDeleteWorkspaceTarget] = useState<{ cwd: string; name: string } | null>(null);
	const [deleteWorkspacePending, setDeleteWorkspacePending] = useState(false);
	const [deleteWorkspaceError, setDeleteWorkspaceError] = useState<string | null>(null);
	const [mounted, setMounted] = useState(false);
	const [deleteSessionTarget, setDeleteSessionTarget] = useState<{ path: string; name: string } | null>(null);
	const [deleteSessionPending, setDeleteSessionPending] = useState(false);
	const [deleteSessionError, setDeleteSessionError] = useState<string | null>(null);
	const [archivePending, setArchivePending] = useState(false);
	const [archiveError, setArchiveError] = useState<string | null>(null);
	const archiveInFlight = useRef(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	const closeRename = useCallback(() => {
		setRenameTarget(null);
	}, []);
	useDialog({ open: mounted && deleteSessionTarget !== null, onClose: () => {
		if (!deleteSessionPending) setDeleteSessionTarget(null);
	}, ref: deleteSessionDialogRef });
	useDialog({ open: mounted && deleteWorkspaceTarget !== null, onClose: () => {
		if (!deleteWorkspacePending) setDeleteWorkspaceTarget(null);
	}, ref: deleteWorkspaceDialogRef });

	const handleConfirmDeleteWorkspace = async () => {
		if (!deleteWorkspaceTarget || deleteWorkspacePending) return;
		const targetCwd = deleteWorkspaceTarget.cwd;
		setDeleteWorkspacePending(true);
		setDeleteWorkspaceError(null);
		try {
			await onDeleteWorkspace?.(targetCwd);
			setDeleteWorkspaceTarget(null);
		} catch (error) {
			setDeleteWorkspaceError(error instanceof Error ? error.message : String(error));
		} finally {
			setDeleteWorkspacePending(false);
		}
	};

	const handleConfirmDeleteSession = async () => {
		if (!deleteSessionTarget || deleteSessionPending) return;
		const targetPath = deleteSessionTarget.path;
		setDeleteSessionPending(true);
		setDeleteSessionError(null);
		try {
			await onDelete?.(targetPath);
			setDeleteSessionTarget(null);
		} catch (error) {
			setDeleteSessionError(error instanceof Error ? error.message : String(error));
		} finally {
			setDeleteSessionPending(false);
		}
	};

	const toggleSessionPin = async (path: string, pinned: boolean) => {
		try {
			if (pinned) await onUnpin?.(path);
			else await onPin?.(path);
		} catch {
			// usePiWeb exposes the request failure in the shared error banner.
		}
	};
	const archiveSession = async (sessionPath: string) => {
		if (!onArchive || archiveInFlight.current) return;
		archiveInFlight.current = true;
		setArchivePending(true);
		setArchiveError(null);
		try {
			await onArchive(sessionPath);
		} catch (error) {
			setArchiveError(error instanceof Error ? error.message : t.archiveFailed);
		} finally { archiveInFlight.current = false; setArchivePending(false); }
	};

	// 路径一律按 normPath 比：注册表里的工作区经过 path.resolve，会话头里的 cwd 是原样记下的，
	// Windows 上盘符大小写、分隔符、尾斜杠都可能不同
	const currentKey = currentPath ? normPath(currentPath) : "";
	const currentCwd = currentKey ? sessions.find((s) => normPath(s.path) === currentKey)?.cwd : undefined;

	useEffect(() => {
		if (!viewMenu && !rowMenu && !sessionMenu) return;
		const h = (e: MouseEvent) => {
			// 按在行菜单的「…」按钮上：交给按钮的 onClick 切换（它也会关掉另一种菜单）。
			// 这里先关的话，紧跟着的 click 又把菜单打开，再点一下「…」永远关不掉
			if ((e.target as Element | null)?.closest?.("[data-menu-trigger]")) return;
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setViewMenu(false);
				setRowMenu(null);
			}
			if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target as Node)) {
				setSessionMenu(null);
			}
		};
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [viewMenu, rowMenu, sessionMenu]);

	const { workspaceGroups, ungroupedGroup } = useMemo(() => {
		const removedSet = new Set((removedWorkspaces || []).map(normPath));
		const activeNormSet = new Set<string>();
		const activeWorkspaces: string[] = [];

		for (const w of addedWorkspaces) {
			const n = normPath(w);
			if (!n || removedSet.has(n) || activeNormSet.has(n)) continue;
			activeWorkspaces.push(w);
			activeNormSet.add(n);
		}

		const map = new Map<string, { cwd: string; sessions: SessionListItem[] }>();
		for (const w of activeWorkspaces) {
			map.set(normPath(w), { cwd: w, sessions: [] });
		}

		const ungroupedList: SessionListItem[] = [];
		for (const s of sessions) {
			const sNorm = normPath(s.cwd);
			if (sNorm && map.has(sNorm)) {
				map.get(sNorm)!.sessions.push(s);
			} else {
				ungroupedList.push(s);
			}
		}

		const isItemPinned = (p: string) => pinnedPaths.some((pinned) => normPath(pinned) === normPath(p));
		const sortSessions = (list: SessionListItem[]) =>
			[...list].sort((a, b) => {
				const pinA = isItemPinned(a.path) ? 1 : 0;
				const pinB = isItemPinned(b.path) ? 1 : 0;
				if (pinA !== pinB) return pinB - pinA;
				return b.modified.localeCompare(a.modified);
			});

		const groups: WorkspaceGroup[] = Array.from(map.values()).map(({ cwd, sessions: list }) => ({
			cwd,
			sessions: sortSessions(list),
			lastModified: list.reduce((acc, s) => (s.modified > acc ? s.modified : acc), ""),
		}));

		if (orderBy === "updated") {
			groups.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
		} else {
			groups.sort((a, b) => basename(a.cwd).localeCompare(basename(b.cwd)));
		}

		let ungrouped: WorkspaceGroup | null = null;
		if (ungroupedList.length > 0) {
			ungrouped = {
				cwd: "__ungrouped__",
				sessions: sortSessions(ungroupedList),
				lastModified: ungroupedList.reduce((acc, s) => (s.modified > acc ? s.modified : acc), ""),
			};
		}

		return { workspaceGroups: groups, ungroupedGroup: ungrouped };
	}, [sessions, addedWorkspaces, removedWorkspaces, orderBy, pinnedPaths]);

	// 工作区展开状态持久化：刷新后保持收起/展开，不被自动展开逻辑覆盖
	const [openSet, setOpenSet] = useState<Set<string>>(() => {
		try {
			const saved = JSON.parse(safeLocalStorage.getItem("piweb.openWorkspaces") ?? "[]");
			if (Array.isArray(saved)) return new Set(saved.filter((x) => typeof x === "string"));
		} catch {
			/* ignore */
		}
		return new Set();
	});
	useEffect(() => {
		try {
			safeLocalStorage.setItem("piweb.openWorkspaces", JSON.stringify([...openSet]));
		} catch {
			/* ignore */
		}
	}, [openSet]);

	// 仅在用户主动切换会话时展开其所在工作区一次；刷新恢复（sessionRestored 标记）
	// 与后续列表轮询/手动收起都不再自动撑开
	const lastExpandedFor = useRef<string | null>(null);
	useEffect(() => {
		if (!currentPath) {
			lastExpandedFor.current = null;
			return;
		}
		if (lastExpandedFor.current === currentPath) return;
		try {
			if (sessionStorage.getItem("piweb.sessionRestored")) {
				sessionStorage.removeItem("piweb.sessionRestored");
				lastExpandedFor.current = currentPath;
				return;
			}
		} catch {
			/* ignore */
		}
		const s = sessions.find((item) => normPath(item.path) === normPath(currentPath));
		if (!s) return; // 会话列表尚未加载，等轮询后重试
		lastExpandedFor.current = currentPath;
		const matchedGroup = workspaceGroups.find((g) => normPath(g.cwd) === normPath(s.cwd));
		if (matchedGroup) {
			setOpenSet((prev) => (prev.has(matchedGroup.cwd) ? prev : new Set([...prev, matchedGroup.cwd])));
		} else if (ungroupedGroup) {
			setOpenSet((prev) => (prev.has("__ungrouped__") ? prev : new Set([...prev, "__ungrouped__"])));
		}
	}, [currentPath, sessions, workspaceGroups, ungroupedGroup]);

	// 进入草稿态时展开其所属分组一次（对齐 dsh 新建 blank 会话即定位到该工作区）
	const lastDraftCwd = useRef<string | null>(null);
	useEffect(() => {
		if (!draftCwd) {
			lastDraftCwd.current = null;
			return;
		}
		if (lastDraftCwd.current === draftCwd) return;
		lastDraftCwd.current = draftCwd;
		const groupKey = workspaceGroups.find((g) => normPath(g.cwd) === normPath(draftCwd))?.cwd ?? "__ungrouped__";
		setOpenSet((prev) => (prev.has(groupKey) ? prev : new Set([...prev, groupKey])));
	}, [draftCwd, workspaceGroups]);

	const flatSessions = useMemo(() => {
		const isItemPinned = (p: string) => pinnedPaths.some((pinned) => normPath(pinned) === normPath(p));
		const list = [...sessions];
		list.sort((a, b) => {
			const pinA = isItemPinned(a.path) ? 1 : 0;
			const pinB = isItemPinned(b.path) ? 1 : 0;
			if (pinA !== pinB) return pinB - pinA;
			if (orderBy === "updated") return b.modified.localeCompare(a.modified);
			return a.created.localeCompare(b.created);
		});
		return list;
	}, [sessions, orderBy, pinnedPaths]);
	const searchSessions = useMemo(() => {
		if (onSearchQuery) return flatSessions;
		const unique = new Map([...flatSessions, ...sortedArchivedSessions].map((session) => [normPath(session.path), session]));
		const query = deferredQ.trim().toLowerCase();
		return [...unique.values()].filter((session) => session.name?.toLowerCase().includes(query)
			|| session.firstMessage.toLowerCase().includes(query) || session.cwd.toLowerCase().includes(query));
	}, [flatSessions, sortedArchivedSessions, deferredQ, onSearchQuery]);

	const toggleOpen = (cwd: string) => {
		setOpenSet((prev) => {
			const next = new Set(prev);
			if (next.has(cwd)) next.delete(cwd);
			else next.add(cwd);
			return next;
		});
	};

	const workspaceNavItems: { id: Exclude<WorkspaceView, "chat">; label: string; icon: React.ReactNode }[] = [
		{ id: "skills", label: t.navSkills, icon: <IconSkillOutline16 size={15} /> },
		{ id: "plugins", label: t.navPlugins, icon: <IconPluginOutline16 size={15} /> },
		// 已启用的资源面板排在「扩展」之后，与内置页并列，可直接在主区域打开。
		...resourcePanels.map((panel) => ({ id: `resource:${panel.id}` as const, label: panel.label, icon: panel.icon ?? <IconCubeOutline16 size={15} /> })),
		{ id: "prompts", label: t.navPromptTemplates, icon: <IconFileOutline16 size={15} /> },
	];

	if (collapsed) {
		return (
			<div
				className="flex h-full flex-col items-center gap-3"
				style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 12, paddingBottom: 12 }}
			>
				{/* dsh：导轨顶部是品牌标，点击展开侧栏 */}
				<button className="rail-btn" title="»" onClick={onToggleCollapse}>
					<PiMark size={22} />
				</button>
				<button className="rail-btn" title={t.newChat} onClick={onNew}>
					<IconNewChatOutline16 size={18} />
				</button>
				{onSelectView &&
					workspaceNavItems.map((item) => (
						<button
							key={item.id}
							className="rail-btn"
							title={item.label}
							aria-label={item.label}
							style={
								activeView === item.id
									? { background: "var(--dsw-label-primary)", color: "var(--dsw-bg-base)" }
									: undefined
							}
							onClick={() => onSelectView(item.id)}
						>
							{item.icon}
						</button>
					))}
				<button className="rail-btn" title={t.addWorkspace} onClick={onAddWorkspace}>
					<IconProjectAddOutline16 size={17} />
				</button>
				<button
					className="rail-btn"
					title={t.search}
					onClick={() => {
						setSearchOpen(true);
						onToggleCollapse();
					}}
				>
					<IconSearchOutline16 size={17} />
				</button>
				<div className="flex-1" />
				<button className="rail-btn" title={t.settings} onClick={onOpenSettings}>
					<IconSettingsOutline16 size={17} />
				</button>
			</div>
		);
	}

	const sessionRow = (s: SessionListItem, indented: boolean, archived = false) => {
		const selected = activeView === "chat" && !!currentKey && normPath(s.path) === currentKey;
		// dsh 合同：被归档的当前会话仍显示在主列表，菜单按真实归档态切换
		const reallyArchived = archived || archivedPaths.some((p) => normPath(p) === normPath(s.path));
		const pinned = !reallyArchived && pinnedPaths.some((p) => normPath(p) === normPath(s.path));
		// 归档列表内不再显示「已归档 X 天」，搜索或主列表里遇到已归档会话仅标「已归档」。
		const rightTag = reallyArchived
			? (archived ? null : { label: t.archivedSessions, title: t.archivedSessions })
			: (() => {
				const timestamp = Date.parse(s.modified);
				const knownTime = Number.isFinite(timestamp);
				const elapsed = knownTime ? relTime(timestamp, lang, Math.max(timeNow, Date.now())) : "";
				const justNow = knownTime && Math.max(timeNow, Date.now()) - timestamp < 60_000;
				const label = !knownTime ? t.sessionUpdateTimeUnknown : justNow ? t.sessionJustUpdated : t.sessionUpdatedAgo.replace("{time}", elapsed);
				const title = knownTime
					? t.sessionUpdateTime.replace("{time}", new Date(timestamp).toLocaleString(htmlLangOf(lang)))
					: label;
				return { label, title };
			})();
		return (
			<div key={s.path} className="group relative">
				<div
					data-active={selected ? "true" : undefined}
					className="isx-menu-item relative flex items-center rounded-lg"
					style={{
						paddingLeft: indented ? 38 : 10,
						paddingRight: 14,
						paddingTop: 6,
						paddingBottom: 6,
						// 选中/悬停框之间留缝，不互相粘连
						marginTop: 2,
						marginBottom: 2,
					}}
				>
				{s.streaming && <span className="state-dot running" style={{ position: "absolute", left: indented ? 26 : 6, width: 6, height: 6 }} />}
				<button className="flex min-w-0 flex-1 flex-col items-start text-left" onClick={() => onOpen(s.path)}>
					<span
						className="isx-menu-shift w-full truncate"
						style={{ fontSize: "var(--dsh-ui-font-sm)", fontWeight: selected ? 500 : 400 }}
					>
						{s.name || s.firstMessage || "(untitled)"}
					</span>
					{s.streaming && s.lastStep && (
						<span className="isx-menu-sub w-full truncate" style={{ fontSize: "var(--dsh-ui-font-2xs)", fontFamily: "var(--font-mono)", color: "var(--dsw-label-caption)", lineHeight: 1.45 }} title={s.lastStep}>
							{s.lastStep}
						</span>
					)}
				</button>
				{pinned && (
					<span
						className={`pw-touch-hide flex-none pl-1 ${sessionMenu === s.path ? "hidden" : "group-hover:hidden group-focus-within:hidden"}`}
						style={{ color: "var(--dsw-label-tertiary)" }}
						title={t.pinned}
					>
						<IconPinFill16 size={12} />
					</span>
				)}
				{rightTag && (
					<span
						className={`isx-menu-sub pw-touch-hide flex-none pl-1 ${sessionMenu === s.path ? "hidden" : "group-hover:hidden group-focus-within:hidden"}`}
						style={{ fontSize: "max(9px, calc(10.5px + var(--dsh-content-font-delta)))", color: "var(--dsw-label-caption)" }}
						title={rightTag.title}
					>
						{rightTag.label}
					</span>
				)}
				<span className={`pw-touch-actions flex-none items-center gap-0.5 pl-1 ${sessionMenu === s.path ? "flex" : "hidden group-hover:flex group-focus-within:flex"}`}>
					<button
						className="icon-btn"
						style={{ width: 22, height: 22 }}
						title={reallyArchived ? t.unarchiveSession : t.archiveSession}
						aria-label={reallyArchived ? t.unarchiveSession : t.archiveSession}
						disabled={archivePending || (!reallyArchived && !onArchive)}
						onClick={(e) => {
							e.stopPropagation();
							setSessionMenu(null);
							if (reallyArchived) onUnarchive?.(s.path);
							else void archiveSession(s.path);
						}}
					>
						<IconArchiveOutline20 size={14} />
					</button>
					{!reallyArchived && (
						<button
							className={`icon-btn ${pinned ? "rounded-full" : ""}`}
							style={{
								width: 22,
								height: 22,
								...(pinned ? { background: "var(--dsw-selector)", color: "var(--dsw-accent)" } : {}),
							}}
							title={pinned ? t.unpinSession : t.pinSession}
							aria-label={pinned ? t.unpinSession : t.pinSession}
							onClick={(e) => {
								e.stopPropagation();
								setSessionMenu(null);
								void toggleSessionPin(s.path, pinned);
							}}
						>
							{pinned ? <IconPinFill16 size={13} /> : <IconPinOutline16 size={13} />}
						</button>
					)}
					<button
						className="icon-btn"
						style={{ width: 22, height: 22 }}
						title="..."
						aria-label="session-actions"
						data-menu-trigger="session"
						onClick={(e) => {
							e.stopPropagation();
							setSessionMenu(sessionMenu === s.path ? null : s.path);
							setRowMenu(null);
						}}
					>
						<IconEllipsisOutline16 size={14} />
					</button>
				</span>
				</div>
				{sessionMenu === s.path && (
					<div className="popover absolute right-1 top-8 z-50 w-max min-w-[168px] py-1 shadow-xl" ref={sessionMenuRef}>
						<MenuItem
							icon={<IconEditOutline16 size={14} />}
							label={t.rename}
							onClick={(e) => {
								e.stopPropagation();
								setSessionMenu(null);
								setRenameTarget({
									type: "session",
									path: s.path,
									name: s.name || s.firstMessage || "",
								});
							}}
						/>
						{!reallyArchived && (
							<MenuItem
								icon={pinned ? <IconPinOutline16 size={14} /> : <IconPinFill16 size={14} />}
								label={pinned ? t.unpinSession : t.pinSession}
								onClick={(e) => {
									e.stopPropagation();
									setSessionMenu(null);
									void toggleSessionPin(s.path, pinned);
								}}
							/>
						)}
						<MenuItem
							icon={<IconDownloadOutline16 size={14} />}
							label={t.cmdExport}
							onClick={(e) => {
								e.stopPropagation();
								setSessionMenu(null);
								onExport?.(s.path);
							}}
						/>
						<MenuItem
							icon={<IconBranchOutline16 size={14} />}
							label={t.forkSession}
							onClick={(e) => {
								e.stopPropagation();
								setSessionMenu(null);
								onFork?.(s.path, s.cwd);
							}}
						/>
						<MenuItem
							icon={<IconTrashOutline16 size={14} />}
							label={t.deleteSession}
							danger
							onClick={(e) => {
								e.stopPropagation();
								setSessionMenu(null);
								setDeleteSessionError(null);
								setDeleteSessionTarget({
									path: s.path,
									name: s.name || s.firstMessage || "(untitled)",
								});
							}}
						/>
					</div>
				)}
			</div>
		);
	};

	const workspaceRow = (g: WorkspaceGroup) => {
		const isUngrouped = g.cwd === "__ungrouped__";
		const open = openSet.has(g.cwd);
		const isCurrent = !isUngrouped && !!currentCwd && normPath(g.cwd) === normPath(currentCwd);
		// 草稿新会话属于哪个分组：路径匹配的工作区，否则归未分组
		const draftInThisGroup = draftCwd
			? (isUngrouped
				? !workspaceGroups.some((wg) => normPath(wg.cwd) === normPath(draftCwd))
				: normPath(g.cwd) === normPath(draftCwd))
			: false;
		const displayName = isUngrouped
			? (t.ungrouped || "未分组")
			: (getWorkspaceName ? getWorkspaceName(g.cwd) : basename(g.cwd));

		return (
			<div key={g.cwd} className="relative">
				<div
					className="isx-menu-item group relative flex items-center rounded-lg"
					style={{
						background: open || isCurrent ? "var(--dsw-hover)" : "transparent",
						paddingLeft: 10,
						paddingRight: 12,
						paddingTop: 7,
						paddingBottom: 7,
						// 悬停/展开框之间留缝，不互相粘连（与会话行一致）
						marginTop: 2,
						marginBottom: 2,
					}}
				>
					<button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => toggleOpen(g.cwd)} title={displayName}>
						<span
							className="isx-menu-sub"
							style={{
								color: "var(--dsw-label-tertiary)",
								display: "inline-flex",
								transform: open ? "rotate(90deg)" : "none",
								transition: "transform 180ms var(--isx-ease)",
								flex: "none",
							}}
						>
							<IconTriangleRightFill14 size={11} />
						</span>
						<span className="isx-menu-icon" style={{ color: isCurrent ? "var(--dsw-accent)" : "var(--dsw-label-tertiary)", display: "inline-flex", flex: "none" }}>
							{open ? <IconFolderOpenOutline16 size={15} /> : <IconFolderClose16 size={15} />}
						</span>
						<span
							className="isx-menu-shift truncate"
							style={{ fontSize: "var(--dsh-ui-font-sm)", fontWeight: isCurrent ? 500 : 400 }}
						>
							{displayName}
						</span>
					</button>
					<span className="pw-touch-actions hidden flex-none items-center gap-0.5 pl-1 group-hover:flex group-focus-within:flex" style={{ color: "var(--dsw-label-tertiary)" }}>
						{!isUngrouped && (
							<button
								className="icon-btn"
								style={{ width: 22, height: 22 }}
								title="..."
								aria-label="workspace-actions"
								data-menu-trigger="workspace"
								onClick={() => {
									setRowMenu(rowMenu === g.cwd ? null : g.cwd);
									setSessionMenu(null);
								}}
							>
								<IconEllipsisOutline16 size={14} />
							</button>
						)}
						<button
							className="icon-btn"
							style={{ width: 22, height: 22 }}
							title={isUngrouped ? t.newChat : t.newSessionHere}
							onClick={() => (isUngrouped ? onNew() : onNewInWorkspace(g.cwd))}
						>
							<IconPlusOutline16 size={14} />
						</button>
					</span>
				</div>
				{!isUngrouped && rowMenu === g.cwd && (
					<div className="popover absolute right-1 top-9 z-50 w-max min-w-[168px] py-1 shadow-xl" ref={menuRef}>
						<MenuItem
							icon={<IconEditOutline16 size={14} />}
							label={t.rename}
							onClick={(e) => {
								e.stopPropagation();
								setRowMenu(null);
								setRenameTarget({
									type: "workspace",
									cwd: g.cwd,
									name: displayName,
								});
							}}
						/>
						<MenuItem
							icon={<IconTrashOutline16 size={14} />}
							label={t.deleteWorkspace}
							danger
							onClick={(e) => {
								e.stopPropagation();
								setRowMenu(null);
								setDeleteWorkspaceTarget({
									cwd: g.cwd,
									name: displayName,
								});
								setDeleteWorkspaceError(null);
							}}
						/>
					</div>
				)}
				{open && (
					<>
						{/* dsh 草稿新会话：显示在所属工作区分组内，发送第一条消息才真正创建，切走即消失 */}
						{draftInThisGroup && (
							<div
								className="flex items-center rounded-lg"
								style={{
									background: "var(--dsw-active)",
									paddingLeft: 38,
									paddingRight: 8,
									paddingTop: 6,
									paddingBottom: 6,
									marginTop: 2,
									marginBottom: 2,
								}}
							>
								<IconNewChatOutline16 size={14} style={{ color: "var(--dsw-accent)", flex: "none", marginRight: 8 }} />
								<span className="truncate" style={{ fontSize: "var(--dsh-ui-font-sm)", color: "var(--dsw-accent)" }}>
									{t.newChat}
								</span>
							</div>
						)}
						{g.sessions.map((s) => sessionRow(s, true))}
					</>
				)}
			</div>
		);
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 品牌行 */}
			<div className="flex items-center gap-1 px-4 pb-2 pt-4">
				<BrandPi />
				<div className="flex-1" />
				<button className="icon-btn" onClick={onToggleCollapse} title="«">
					<IconPanelLeftOutline16 size={15} />
				</button>
			</div>

			{/* 新会话（Iconsax .button-gradient 光晕胶囊） */}
			<div className="px-3 pt-1">
				<button className="btn-new-session w-full" onClick={onNew}>
					<IconNewChatOutline16 size={14} />
					{t.newChat}
				</button>
			</div>

			{/* 顶部工作区导航：技能 → 扩展 → 提示词模板 */}
			{onSelectView && (
				<nav className="flex flex-col gap-0.5 px-3 pt-2.5">
					{workspaceNavItems.map((item) => {
						const active = activeView === item.id;
						return (
							<button
								key={item.id}
								type="button"
								data-active={active ? "true" : undefined}
								className="isx-menu-item flex w-full items-center gap-2.5 rounded-lg text-left"
								style={{
									borderRadius: 8,
									padding: "7px 12px",
									lineHeight: 1.45,
									fontSize: "var(--dsh-ui-font-135)",
									fontWeight: active ? 500 : 400,
									color: active ? "var(--dsw-bg-base)" : "var(--dsw-label-secondary)",
								}}
								onClick={() => onSelectView(item.id)}
							>
								<span className="isx-menu-icon" style={{ display: "inline-flex" }}>
									{item.icon}
								</span>
								<span className="isx-menu-shift">{item.label}</span>
							</button>
						);
					})}
				</nav>
			)}

			{/* 工作区标题行 / 搜索框（互替，照 Iconsax .con-search） */}
			{searchOpen ? (
				<div className="px-3 pb-1 pt-3">
					<div className="isx-search flex items-center gap-2 px-3 py-2">
						<IconSearchOutline16 size={14} className="isx-search-icon" style={{ color: "var(--dsw-label-caption)", flex: "none" }} />
						<input
							autoFocus
							value={q}
							onChange={(e) => setQ(e.target.value)}
							onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { setQ(""); setSearchOpen(false); } }}
							placeholder={t.searchSessions}
							className="w-full"
							style={{ fontSize: "var(--dsh-ui-font-sm)" }}
						/>
						<button
							className="icon-btn"
							style={{ width: 20, height: 20 }}
							onClick={() => {
								setQ("");
								setSearchOpen(false);
							}}
						>
							<IconCloseOutline14 size={13} />
						</button>
					</div>
				</div>
			) : (
				<div className="flex items-center gap-0.5 px-4 pb-1 pt-3">
					<span style={{ fontSize: "var(--dsh-ui-font-sm)", color: "var(--dsw-label-primary)" }}>{t.workspaces}</span>
					<div className="flex-1" />
					<button className="icon-btn" style={{ width: 26, height: 26 }} title={t.search} onClick={() => setSearchOpen(true)}>
						<IconSearchOutline16 size={14} />
					</button>
					<div className="relative" ref={viewMenu ? menuRef : undefined}>
						<button
							className="icon-btn"
							style={{ width: 26, height: 26, background: viewMenu ? "var(--dsw-active)" : undefined, borderRadius: 8 }}
							title={t.groupBy}
							onClick={() => setViewMenu((v) => !v)}
						>
							<IconPersonalizationOutline16 size={14} />
						</button>
						{viewMenu && (
							<div className="popover absolute right-0 top-8 z-50 w-56 py-2">
								<div className="px-3 pb-1" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))", color: "var(--dsw-label-caption)" }}>
									{t.groupBy}
								</div>
								<MenuCheck label={t.byWorkspace} checked={groupBy === "workspace"} onClick={() => { setGroupBy("workspace"); setViewMenu(false); }} />
								<MenuCheck label={t.flatList} checked={groupBy === "flat"} onClick={() => { setGroupBy("flat"); setViewMenu(false); }} />
								<div className="my-1.5" style={{ borderTop: "1px solid var(--dsw-border-l2)" }} />
								<div className="px-3 pb-1" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))", color: "var(--dsw-label-caption)" }}>
									{t.sortBy}
								</div>
								<MenuCheck label={t.manualOrder} checked={orderBy === "manual"} onClick={() => { setOrderBy("manual"); setViewMenu(false); }} />
								<MenuCheck label={t.recentUpdated} checked={orderBy === "updated"} onClick={() => { setOrderBy("updated"); setViewMenu(false); }} />
							</div>
						)}
					</div>
					<button className="icon-btn" style={{ width: 26, height: 26 }} title={t.addWorkspace} onClick={onAddWorkspace}>
						<IconProjectAddOutline16 size={14} />
					</button>
				</div>
			)}

			{/* 列表区 */}
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
				{archiveError && (
					<div role="alert" className="mb-2 rounded-xl px-3 py-2" style={{ background: "var(--dsw-hover)", color: "var(--dsw-danger)", fontSize: "var(--dsh-ui-font-xs)" }}>
						{archiveError}
					</div>
				)}
				{workspaceRegistryWarning && (
					<div role="status" className="mb-2 rounded-xl px-3 py-2" style={{ background: "var(--dsw-hover)", color: "var(--dsw-warn-text)", fontSize: "var(--dsh-ui-font-xs)" }}>
						{workspaceRegistryWarning}
					</div>
				)}
				{sessionListError && (
					<div role="alert" className="mb-2 rounded-xl px-3 py-2" style={{ background: "var(--dsw-hover)", color: "var(--dsw-danger)", fontSize: "var(--dsh-ui-font-xs)" }}>
						<div>{t.sessionListLoadFailed}: {sessionListError}</div>
						<button type="button" className="mt-1 underline" onClick={onRetrySessionList}>{t.retry}</button>
					</div>
				)}
				{searchOpen && deferredQ.trim() ? (
					// 搜索结果：会话平铺
					searchSessions.length === 0 ? (
						<div className="px-2 py-6 text-center" style={{ fontSize: "var(--dsh-ui-font-125)", color: "var(--dsw-label-caption)" }}>
							{loadingMore ? t.panelLoading : "—"}
						</div>
					) : (
						searchSessions.map((s) => sessionRow(s, false))
					)
				) : searchOpen ? (
					// 空查询：工作区平铺（照 dsh 截图）
					[...workspaceGroups, ...(ungroupedGroup ? [ungroupedGroup] : [])].map((g) => (
						<div
							key={g.cwd}
							className="isx-menu-item flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2"
							onClick={() => {
								setSearchOpen(false);
								toggleOpen(g.cwd);
							}}
							title={g.cwd === "__ungrouped__" ? (t.ungrouped || "未分组") : g.cwd}
						>
							<span className="isx-menu-icon" style={{ color: "var(--dsw-label-tertiary)", display: "inline-flex" }}>
								<IconFolderClose16 size={15} />
							</span>
							<span className="isx-menu-shift truncate" style={{ fontSize: "var(--dsh-ui-font-sm)" }}>
								{g.cwd === "__ungrouped__"
									? (t.ungrouped || "未分组")
									: (getWorkspaceName ? getWorkspaceName(g.cwd) : basename(g.cwd))}
							</span>
						</div>
					))
				) : groupBy === "workspace" ? (
					// 按工作区分组
					workspaceGroups.length === 0 && !ungroupedGroup ? (
						<div className="px-2 py-6 text-center" style={{ fontSize: "var(--dsh-ui-font-125)", color: "var(--dsw-label-caption)" }}>
							{t.noSessions}
						</div>
					) : (
						<>
							{workspaceGroups.map(workspaceRow)}
							{ungroupedGroup && workspaceRow(ungroupedGroup)}
						</>
					)
					) : (
						// 单列表
						<>
							{draftCwd && (
								<div
									className="flex items-center rounded-lg"
									style={{
										background: "var(--dsw-active)",
										paddingLeft: 10,
										paddingRight: 8,
										paddingTop: 6,
										paddingBottom: 6,
										marginTop: 2,
										marginBottom: 2,
									}}
								>
									<IconNewChatOutline16 size={14} style={{ color: "var(--dsw-accent)", flex: "none", marginRight: 8 }} />
									<span className="truncate" style={{ fontSize: "var(--dsh-ui-font-sm)", color: "var(--dsw-accent)" }}>
										{t.newChat}
									</span>
								</div>
							)}
							{(flatSessions.length === 0
						? [...workspaceGroups, ...(ungroupedGroup ? [ungroupedGroup] : [])].map((g) => (
								<div key={g.cwd} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2" title={g.cwd}>
									<span style={{ color: "var(--dsw-label-tertiary)", display: "inline-flex" }}>
										<IconFolderClose16 size={15} />
									</span>
									<span className="truncate" style={{ fontSize: "var(--dsh-ui-font-sm)" }}>
										{g.cwd === "__ungrouped__"
											? (t.ungrouped || "未分组")
											: (getWorkspaceName ? getWorkspaceName(g.cwd) : basename(g.cwd))}
									</span>
								</div>
						  ))
						: flatSessions.map((s) => sessionRow(s, false)))}
							</>
					)}
				{!searchOpen && archivedSessions.length > 0 && (
					<div className="mt-2 border-t pt-2" style={{ borderColor: "var(--dsw-border-l2)" }}>
						<button
							type="button"
							className="isx-menu-item flex w-full items-center gap-2 rounded-lg text-left"
							style={{ padding: "8px 10px" }}
							aria-expanded={archiveOpen}
							title={t.archiveDetail}
							onClick={() => setArchiveOpen((open) => !open)}
						>
							<span
								className="isx-menu-sub"
								style={{
									display: "inline-flex",
									transform: archiveOpen ? "rotate(90deg)" : "none",
									transition: "transform 180ms var(--isx-ease)",
									color: "var(--dsw-label-tertiary)",
								}}
							>
								<IconTriangleRightFill14 size={11} />
							</span>
							<span className="isx-menu-icon" style={{ display: "inline-flex", color: "var(--dsw-label-tertiary)" }}>
								<IconArchiveOutline20 size={15} />
							</span>
							<span className="isx-menu-shift min-w-0 flex-1 truncate" style={{ fontSize: "var(--dsh-ui-font-sm)" }}>{t.archivedSessions}</span>
							<span className="isx-menu-sub pr-2" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>{archivedSessions.length}</span>
						</button>
						{archiveOpen && sortedArchivedSessions.map((session) => sessionRow(session, true, true))}
					</div>
				)}
				{hasMore && onLoadMore && (
					<button type="button" className="pw-chip mx-2 my-2" disabled={loadingMore} onClick={onLoadMore}>
						{loadingMore ? t.panelLoading : t.viewerDirMore}
					</button>
				)}
			</div>

			{/* 设置固定左下角 */}
			<div className="px-3 py-2.5">
				<button
					className="isx-menu-item flex w-full items-center gap-2.5 rounded-lg text-left"
					style={{ color: "var(--dsw-label-secondary)", padding: "8px 12px" }}
					onClick={onOpenSettings}
				>
					<span className="isx-menu-icon" style={{ display: "inline-flex" }}>
						<IconSettingsOutline16 size={16} />
					</span>
					<span className="isx-menu-shift" style={{ fontSize: "var(--dsh-content-font-size)" }}>{t.settings}</span>
				</button>
			</div>

			{/* 重命名弹窗（输入状态留在子组件内部，打字不触发整棵侧栏重渲染） */}
			{mounted && renameTarget && (
				<RenameDialog
					key={renameTarget.type === "session" ? `session:${renameTarget.path}` : `workspace:${renameTarget.cwd}`}
					target={renameTarget}
					addedWorkspaces={addedWorkspaces}
					getWorkspaceName={getWorkspaceName}
					onRename={onRename}
					onRenameWorkspace={onRenameWorkspace}
					onClose={closeRename}
				/>
			)}

			{/* 删除会话确认弹窗：文件直接进入运行 PiWeb 的电脑的系统回收站 */}
			{mounted && deleteSessionTarget && createPortal(
				<div
					className="modal-mask fixed inset-0 z-[9999] flex items-center justify-center p-4 animate-in fade-in duration-150"
					onClick={() => !deleteSessionPending && setDeleteSessionTarget(null)}
				>
					<div
						ref={deleteSessionDialogRef}
						className="glass-modal relative w-full max-w-[420px] p-6"
						style={{ boxShadow: "var(--pw-shadow-modal)", color: "var(--dsw-label-primary)" }}
						onClick={(e) => e.stopPropagation()}
						role="dialog"
						aria-modal="true"
						aria-labelledby="delete-session-dialog-title"
					>
						<button
							type="button"
							onClick={() => setDeleteSessionTarget(null)}
							disabled={deleteSessionPending}
							className="icon-btn absolute right-5 top-5"
							style={{ width: 28, height: 28 }}
							aria-label={t.close}
						>
							<IconCloseOutline14 size={16} />
						</button>
						<h3 id="delete-session-dialog-title" className="pr-8 text-lg font-medium" style={{ color: "var(--dsw-label-primary)" }}>
							{t.deleteSession}
						</h3>
						<p className="mt-3 text-[14.5px] leading-relaxed break-words" style={{ color: "var(--dsw-label-secondary)" }}>
							{t.deleteSessionConfirm.replace("{name}", deleteSessionTarget.name)}
						</p>
						{deleteSessionPending && (
							<p className="mt-4 text-sm" style={{ color: "var(--dsw-label-caption)" }} role="status">{t.deleteSessionPending}</p>
						)}
						{deleteSessionError && (
							<p className="mt-4 text-sm" style={{ color: "var(--dsw-danger)" }} role="alert">{deleteSessionError}</p>
						)}
						<div className="mt-6 flex items-center justify-end gap-2.5">
							<button
								type="button"
								onClick={() => setDeleteSessionTarget(null)}
								disabled={deleteSessionPending}
								className="btn-outline"
							>
								{t.cancel}
							</button>
							<button
								type="button"
								onClick={() => void handleConfirmDeleteSession()}
								disabled={deleteSessionPending}
								className="pw-btn-danger"
							>
								{t.deleteSession}
							</button>
						</div>
					</div>
				</div>,
				document.body
			)}

			{/* 删除工作区确认弹窗（通过 createPortal 挂载到 document.body 确保浏览器正居中） */}
			{mounted && deleteWorkspaceTarget && createPortal(
				<div
					className="modal-mask fixed inset-0 z-[9999] flex items-center justify-center p-4 animate-in fade-in duration-150"
					onClick={() => !deleteWorkspacePending && setDeleteWorkspaceTarget(null)}
				>
					<div
						ref={deleteWorkspaceDialogRef}
						className="glass-modal relative w-full max-w-[420px] p-6"
						style={{ boxShadow: "var(--pw-shadow-modal)", color: "var(--dsw-label-primary)" }}
						onClick={(e) => e.stopPropagation()}
						role="dialog"
						aria-modal="true"
						aria-labelledby="delete-workspace-dialog-title"
					>
						{/* 关闭按钮 */}
						<button
							type="button"
							onClick={() => setDeleteWorkspaceTarget(null)}
							disabled={deleteWorkspacePending}
							className="icon-btn absolute right-5 top-5"
							style={{ width: 28, height: 28 }}
							aria-label={t.close}
						>
							<IconCloseOutline14 size={16} />
						</button>

						{/* 标题 */}
						<h3 id="delete-workspace-dialog-title" className="pr-8 text-lg font-medium" style={{ color: "var(--dsw-label-primary)" }}>
							{t.deleteWorkspace}
						</h3>

						{/* 描述文本 */}
						<p className="mt-3 text-[14.5px] leading-relaxed break-words" style={{ color: "var(--dsw-label-secondary)" }}>
							{(t.deleteWorkspaceConfirm || "将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。").replace(
								"{name}",
								deleteWorkspaceTarget.name,
							)}
						</p>
						{deleteWorkspacePending && (
							<p className="mt-4 text-sm" style={{ color: "var(--dsw-label-caption)" }} role="status">{t.deleteWorkspacePending}</p>
						)}
						{deleteWorkspaceError && (
							<p className="mt-4 text-sm" style={{ color: "var(--dsw-danger)" }} role="alert">{deleteWorkspaceError}</p>
						)}

						{/* 按钮区 */}
						<div className="mt-6 flex items-center justify-end gap-2.5">
							<button
								type="button"
								onClick={() => setDeleteWorkspaceTarget(null)}
								disabled={deleteWorkspacePending}
								className="btn-outline"
							>
								{t.cancel}
							</button>
							<button
								type="button"
								onClick={() => void handleConfirmDeleteWorkspace()}
								disabled={deleteWorkspacePending}
								className="pw-btn-danger"
							>
								{t.deleteWorkspace}
							</button>
						</div>
					</div>
				</div>,
				document.body
			)}
		</div>
	);
}

/**
 * memo：流式期间 AppShell 每 16ms 重渲染一次（state.messages 换引用），侧栏的 props
 * （会话列表、回调）在此期间全部不变，几百行会话树的 reconciliation 是纯浪费。
 */
export const SessionSidebar = memo(SessionSidebarImpl);

type RenameTarget = { type: "session"; path: string; name: string } | { type: "workspace"; cwd: string; name: string };

/** 重命名弹窗：输入状态留在子组件内部，打字不触发整棵侧栏重渲染 */
function RenameDialog({
	target,
	addedWorkspaces,
	getWorkspaceName,
	onRename,
	onRenameWorkspace,
	onClose,
}: {
	target: RenameTarget;
	addedWorkspaces: string[];
	getWorkspaceName?: (cwd: string) => string;
	onRename: (path: string, newName: string) => Promise<void>;
	onRenameWorkspace?: (cwd: string, newName: string) => Promise<void>;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const [value, setValue] = useState(target.name);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const composingRef = useRef(false);

	const workspaceConflict = target.type === "workspace"
		&& value.trim().length > 0
		&& addedWorkspaces.some((cwd) => (
			normPath(cwd) !== normPath(target.cwd)
			&& (getWorkspaceName ? getWorkspaceName(cwd) : basename(cwd)) === value.trim()
		));

	useEffect(() => {
		const timer = setTimeout(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		}, 30);
		return () => clearTimeout(timer);
	}, []);

	const close = () => {
		if (pending) return;
		onClose();
	};
	useDialog({ open: true, onClose: close, ref: dialogRef });

	const confirm = async () => {
		if (pending) return;
		const val = value.trim();
		if (!val || (target.type === "workspace" && (val === target.name || workspaceConflict))) {
			if (workspaceConflict) {
				setError(t.workspaceNameConflict.replace("{name}", val));
			}
			return;
		}
		setPending(true);
		setError(null);
		try {
			if (target.type === "session") {
				await onRename(target.path, val);
			} else {
				await onRenameWorkspace?.(target.cwd, val);
			}
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	};

	return createPortal(
		<div
			className="modal-mask fixed inset-0 z-[9999] flex items-center justify-center p-4 animate-in fade-in duration-150"
			onClick={close}
		>
			<div
				ref={dialogRef}
				className="glass-modal relative w-full max-w-[420px] p-6"
				style={{ boxShadow: "var(--pw-shadow-modal)", color: "var(--dsw-label-primary)" }}
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-labelledby="rename-dialog-title"
			>
				{/* 关闭按钮 */}
				<button
					type="button"
					onClick={close}
					disabled={pending}
					className="icon-btn absolute right-5 top-5"
					style={{ width: 28, height: 28 }}
					aria-label={t.close}
				>
					<IconCloseOutline14 size={16} />
				</button>

				{/* 标题 */}
				<h3 id="rename-dialog-title" className="pr-8 text-lg font-medium" style={{ color: "var(--dsw-label-primary)" }}>
					{target.type === "session"
						? (t.renameSession || "重命名会话")
						: (t.renameWorkspace || "重命名工作区")}
				</h3>

				{/* 输入框 */}
				<div className="mt-5 mb-6">
					<input
						ref={inputRef}
						type="text"
						value={value}
						disabled={pending}
						onChange={(e) => {
							setValue(e.target.value);
							setError(null);
						}}
						onKeyDown={(e) => {
							if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
								e.stopPropagation();
								return;
							}
							if (e.key === "Enter") {
								e.preventDefault();
								void confirm();
							}
						}}
						onCompositionStart={() => { composingRef.current = true; }}
						onCompositionEnd={() => { composingRef.current = false; }}
						className="pw-modal-input w-full rounded-full px-4 py-2.5 text-[14.5px] outline-none transition"
						style={{
							background: "var(--dsw-bg-elevated)",
							border: "1px solid var(--dsw-border-l2)",
							color: "var(--dsw-label-primary)",
						}}
					/>
				</div>
				{error && (
					<p className="-mt-3 mb-5 text-sm" style={{ color: "var(--dsw-danger)" }} role="alert">{error}</p>
				)}

				{/* 按钮区 */}
				<div className="flex items-center justify-end gap-2.5">
					<button
						type="button"
						onClick={close}
						disabled={pending}
						className="btn-outline"
					>
						{t.cancel}
					</button>
					<button
						type="button"
						onClick={() => void confirm()}
						disabled={pending || !value.trim() || (target.type === "workspace" && (value.trim() === target.name || workspaceConflict))}
						className="btn-primary-white"
					>
						{t.rename}
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
}

function MenuItem({
	icon,
	label,
	title,
	danger,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	title?: string;
	danger?: boolean;
	onClick: (e: React.MouseEvent) => void;
}) {
	return (
		<button
			title={title}
			data-danger={danger ? "true" : undefined}
			className="isx-menu-item mx-1 flex w-[calc(100%-8px)] items-center gap-2.5 rounded-lg text-left"
			style={{ fontSize: "var(--dsh-ui-font-sm)", padding: "8px 12px", color: danger ? "var(--dsw-danger)" : "var(--dsw-label-primary)" }}
			onClick={onClick}
		>
			<span className="isx-menu-icon shrink-0" style={{ display: "inline-flex" }}>{icon}</span>
			<span className="isx-menu-shift whitespace-nowrap">{label}</span>
		</button>
	);
}

function MenuCheck({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
	return (
		<button
			data-active={checked ? "true" : undefined}
			className="isx-menu-item mx-1 flex w-[calc(100%-8px)] items-center justify-between rounded-lg text-left"
			style={{ fontSize: "var(--dsh-ui-font-sm)", padding: "8px 16px", color: "var(--dsw-label-primary)" }}
			onClick={onClick}
		>
			<span className="isx-menu-shift">{label}</span>
			{checked && <IconCheckOutline14 size={13} />}
		</button>
	);
}
