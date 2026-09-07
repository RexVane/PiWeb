"use client";

/**
 * 侧栏 —— 照抄 dsh ui-sidebar：
 * 品牌行（mark + 字标 + 描边徽章 + 侧栏开合）、新会话按钮（h38 r12），
 * 工作区标题行（搜索 / 滑杆菜单 / 添加工作区=原生文件夹选择器），
 * 工作区树（▶/▼ 三角 + 文件夹 + 名称；展开行 hover 显 … 和 ＋；会话缩进 + 相对时间），
 * 搜索模式（输入框替身标题行，空查询=工作区平铺，输入=会话平铺），
 * 滑杆菜单（分组方式：按工作区/单列表；排序方式：手动排序/最近更新）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrandPi, PiMark } from "@/components/PiMark";
import {
	IconArchiveOutline20,
	IconBranchOutline16,
	IconCheckOutline14,
	IconEditOutline16,
	IconEllipsisOutline16,
	IconFolderClose16,
	IconFolderOpenOutline16,
	IconNewChatOutline16,
	IconPanelLeftOutline16,
	IconPersonalizationOutline16,
	IconPlusOutline16,
	IconProjectAddOutline16,
	IconSearchOutline16,
	IconCloseOutline14,
	IconSettingsOutline16,
	IconTrashOutline16,
	IconTriangleRightFill14,
} from "@/components/icons";
import { useI18n } from "@/i18n";
import type { SessionListItem } from "@/hooks/usePiWeb";

function relTime(iso: string, lang: "zh" | "en"): string {
	const d = Date.now() - new Date(iso).getTime();
	const m = Math.floor(d / 60000);
	if (m < 1) return lang === "zh" ? "刚刚" : "now";
	if (m < 60) return lang === "zh" ? `${m}分钟` : `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return lang === "zh" ? `${h}小时` : `${h}h`;
	const days = Math.floor(h / 24);
	if (days < 30) return lang === "zh" ? `${days}天` : `${days}d`;
	return lang === "zh" ? `${Math.floor(days / 30)}月` : `${Math.floor(days / 30)}mo`;
}

function basename(p: string): string {
	const norm = p.replace(/\\/g, "/");
	return norm.split("/").filter(Boolean).pop() ?? norm;
}

function normPath(p: string): string {
	if (!p) return "";
	return p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

type GroupBy = "workspace" | "flat";
type OrderBy = "updated" | "manual";

interface WorkspaceGroup {
	cwd: string;
	sessions: SessionListItem[];
	lastModified: string;
}

export function SessionSidebar({
	sessions,
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
	onDelete,
	onFork,
	onArchive,
	getWorkspaceName,
	onRenameWorkspace,
	onDeleteWorkspace,
	onOpenSettings,
	onAddWorkspace,
	onRemoveWorkspace,
}: {
	sessions: SessionListItem[];
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
	onRename: (path: string, newName: string) => void;
	onDelete: (path: string) => void;
	onFork?: (path: string, cwd: string) => void;
	onArchive?: (path: string) => void;
	getWorkspaceName?: (cwd: string) => string;
	onRenameWorkspace?: (cwd: string, newName: string) => void;
	onDeleteWorkspace?: (cwd: string) => void;
	onOpenSettings: () => void;
	onAddWorkspace: () => void;
	onRemoveWorkspace: (cwd: string) => void;
}) {
	const { t, lang } = useI18n();
	const [q, setQ] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [openSet, setOpenSet] = useState<Set<string>>(new Set());
	const [viewMenu, setViewMenu] = useState(false);
	const [rowMenu, setRowMenu] = useState<string | null>(null); // 展开工作区行菜单的 cwd
	const [sessionMenu, setSessionMenu] = useState<string | null>(null); // 展开会话行菜单的 session path
	const menuRef = useRef<HTMLDivElement>(null);
	const sessionMenuRef = useRef<HTMLDivElement>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);

	// 自定义弹窗状态（重命名与删除工作区）
	const [renameTarget, setRenameTarget] = useState<
		{ type: "session"; path: string; name: string } | { type: "workspace"; cwd: string; name: string } | null
	>(null);
	const [renameValue, setRenameValue] = useState("");
	const [deleteWorkspaceTarget, setDeleteWorkspaceTarget] = useState<{ cwd: string; name: string } | null>(null);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		if (renameTarget) {
			setRenameValue(renameTarget.name);
			setTimeout(() => {
				renameInputRef.current?.focus();
				renameInputRef.current?.select();
			}, 30);
		}
	}, [renameTarget]);

	const handleConfirmRename = () => {
		if (!renameTarget) return;
		const val = renameValue.trim();
		if (val) {
			if (renameTarget.type === "session") {
				onRename(renameTarget.path, val);
			} else {
				onRenameWorkspace?.(renameTarget.cwd, val);
			}
		}
		setRenameTarget(null);
	};

	const handleConfirmDeleteWorkspace = () => {
		if (!deleteWorkspaceTarget) return;
		const targetCwd = deleteWorkspaceTarget.cwd;
		setDeleteWorkspaceTarget(null);
		onDeleteWorkspace?.(targetCwd);
	};

	const currentCwd = sessions.find((s) => s.path === currentPath)?.cwd;

	useEffect(() => {
		if (!viewMenu && !rowMenu && !sessionMenu) return;
		const h = (e: MouseEvent) => {
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

		const groups: WorkspaceGroup[] = Array.from(map.values()).map(({ cwd, sessions: list }) => ({
			cwd,
			sessions: [...list].sort((a, b) => b.modified.localeCompare(a.modified)),
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
				sessions: [...ungroupedList].sort((a, b) => b.modified.localeCompare(a.modified)),
				lastModified: ungroupedList.reduce((acc, s) => (s.modified > acc ? s.modified : acc), ""),
			};
		}

		return { workspaceGroups: groups, ungroupedGroup: ungrouped };
	}, [sessions, addedWorkspaces, removedWorkspaces, orderBy]);

	// 默认展开所有活跃工作区和未分组
	const initializedRef = useRef(false);
	useEffect(() => {
		if (!initializedRef.current && (workspaceGroups.length > 0 || ungroupedGroup)) {
			initializedRef.current = true;
			setOpenSet(new Set([...workspaceGroups.map((g) => g.cwd), "__ungrouped__"]));
		}
	}, [workspaceGroups, ungroupedGroup]);

	// 确保当前选中的会话所在工作区是展开的
	useEffect(() => {
		if (!currentPath) return;
		const s = sessions.find((item) => item.path === currentPath);
		if (!s) return;
		const matchedGroup = workspaceGroups.find((g) => normPath(g.cwd) === normPath(s.cwd));
		if (matchedGroup) {
			setOpenSet((prev) => (prev.has(matchedGroup.cwd) ? prev : new Set([...prev, matchedGroup.cwd])));
		} else if (ungroupedGroup) {
			setOpenSet((prev) => (prev.has("__ungrouped__") ? prev : new Set([...prev, "__ungrouped__"])));
		}
	}, [currentPath, sessions, workspaceGroups, ungroupedGroup]);

	const flatSessions = useMemo(() => {
		const list = [...sessions];
		if (orderBy === "updated") list.sort((a, b) => b.modified.localeCompare(a.modified));
		else list.sort((a, b) => a.created.localeCompare(b.created));
		return list;
	}, [sessions, orderBy]);

	const toggleOpen = (cwd: string) => {
		setOpenSet((prev) => {
			const next = new Set(prev);
			if (next.has(cwd)) next.delete(cwd);
			else next.add(cwd);
			return next;
		});
	};

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

	const sessionRow = (s: SessionListItem, indented: boolean) => {
		const selected = s.path === currentPath;
		return (
			<div
				key={s.path}
				className="group relative flex items-center rounded-xl transition-colors"
				style={{
					background: selected ? "var(--dsw-active)" : "transparent",
					paddingLeft: indented ? 38 : 10,
					paddingRight: 8,
					paddingTop: 6,
					paddingBottom: 6,
				}}
				onMouseEnter={(e) => {
					if (!selected) e.currentTarget.style.background = "var(--dsw-hover)";
				}}
				onMouseLeave={(e) => {
					if (!selected) e.currentTarget.style.background = "transparent";
				}}
			>
				{s.streaming && <span className="state-dot running" style={{ position: "absolute", left: indented ? 26 : 6, width: 6, height: 6 }} />}
				<button className="flex min-w-0 flex-1 items-center text-left" onClick={() => onOpen(s.path)}>
					<span
						className="truncate"
						style={{ fontSize: 13, color: selected ? "var(--dsw-accent)" : "var(--dsw-label-primary)" }}
					>
						{s.name || s.firstMessage || "(untitled)"}
					</span>
				</button>
				<span
					className={`flex-none pl-1 ${sessionMenu === s.path ? "hidden" : "group-hover:hidden"}`}
					style={{ fontSize: 10.5, color: "var(--dsw-label-caption)" }}
				>
					{relTime(s.modified, lang)}
				</span>
				<span className={`flex-none items-center pl-1 ${sessionMenu === s.path ? "flex" : "hidden group-hover:flex"}`}>
					<button
						className="icon-btn"
						style={{ width: 22, height: 22 }}
						title="..."
						aria-label="session-actions"
						onClick={(e) => {
							e.stopPropagation();
							setSessionMenu(sessionMenu === s.path ? null : s.path);
							setRowMenu(null);
						}}
					>
						<IconEllipsisOutline16 size={14} />
					</button>
				</span>
				{sessionMenu === s.path && (
					<div className="popover absolute right-1 top-8 z-50 w-36 py-1 shadow-xl" ref={sessionMenuRef}>
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
							icon={<IconArchiveOutline20 size={14} />}
							label={t.archiveSession}
							onClick={(e) => {
								e.stopPropagation();
								setSessionMenu(null);
								onArchive?.(s.path);
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
		const isCurrent = !isUngrouped && g.cwd === currentCwd;
		const displayName = isUngrouped
			? (t.ungrouped || "未分组")
			: (getWorkspaceName ? getWorkspaceName(g.cwd) : basename(g.cwd));

		return (
			<div key={g.cwd}>
				<div
					className="group relative flex items-center rounded-xl transition-colors"
					style={{
						background: open || isCurrent ? "var(--dsw-hover)" : "transparent",
						paddingLeft: 10,
						paddingRight: 6,
						paddingTop: 7,
						paddingBottom: 7,
					}}
					onMouseEnter={(e) => {
						if (!(open || isCurrent)) e.currentTarget.style.background = "var(--dsw-hover)";
					}}
					onMouseLeave={(e) => {
						if (!(open || isCurrent)) e.currentTarget.style.background = "transparent";
					}}
				>
					<button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => toggleOpen(g.cwd)} title={displayName}>
						<span
							style={{
								color: "var(--dsw-label-tertiary)",
								display: "inline-flex",
								transform: open ? "rotate(90deg)" : "none",
								transition: "transform 120ms var(--ds-ease-in-out)",
								flex: "none",
							}}
						>
							<IconTriangleRightFill14 size={11} />
						</span>
						<span style={{ color: isCurrent ? "var(--dsw-accent)" : "var(--dsw-label-tertiary)", display: "inline-flex", flex: "none" }}>
							{open ? <IconFolderOpenOutline16 size={15} /> : <IconFolderClose16 size={15} />}
						</span>
						<span
							className="truncate"
							style={{ fontSize: 13, color: isCurrent ? "var(--dsw-accent)" : "var(--dsw-label-primary)" }}
						>
							{displayName}
						</span>
					</button>
					<span className="hidden flex-none items-center gap-0.5 pl-1 group-hover:flex" style={{ color: "var(--dsw-label-tertiary)" }}>
						{!isUngrouped && (
							<button
								className="icon-btn"
								style={{ width: 22, height: 22 }}
								title="..."
								aria-label="workspace-actions"
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
					{!isUngrouped && rowMenu === g.cwd && (
						<div className="popover absolute right-1 top-9 z-50 w-44 py-1 shadow-xl" ref={menuRef}>
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
								}}
							/>
						</div>
					)}
				</div>
				{open && g.sessions.map((s) => sessionRow(s, true))}
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

			{/* 新会话（dsh .newSession） */}
			<div className="px-3 pt-1">
				<button className="btn-new-session w-full" onClick={onNew}>
					<IconNewChatOutline16 size={14} />
					{t.newChat}
				</button>
			</div>

			{/* 工作区标题行 / 搜索框（互替，照 dsh） */}
			{searchOpen ? (
				<div className="px-3 pb-1 pt-3">
					<div className="flex items-center gap-2 rounded-xl px-2.5 py-2" style={{ background: "var(--dsw-hover)" }}>
						<IconSearchOutline16 size={14} style={{ color: "var(--dsw-label-caption)" }} />
						<input
							autoFocus
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder={t.searchSessions}
							className="w-full"
							style={{ fontSize: 13 }}
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
					<span style={{ fontSize: 13, color: "var(--dsw-label-primary)" }}>{t.workspaces}</span>
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
								<div className="px-3 pb-1" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
									{t.groupBy}
								</div>
								<MenuCheck label={t.byWorkspace} checked={groupBy === "workspace"} onClick={() => { setGroupBy("workspace"); setViewMenu(false); }} />
								<MenuCheck label={t.flatList} checked={groupBy === "flat"} onClick={() => { setGroupBy("flat"); setViewMenu(false); }} />
								<div className="my-1.5" style={{ borderTop: "0.5px solid var(--dsw-border-l2)" }} />
								<div className="px-3 pb-1" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
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
				{searchOpen && q.trim() ? (
					// 搜索结果：会话平铺
					flatSessions.filter(
						(s) =>
							s.name?.toLowerCase().includes(q.trim().toLowerCase()) ||
							s.firstMessage.toLowerCase().includes(q.trim().toLowerCase()) ||
							basename(s.cwd).toLowerCase().includes(q.trim().toLowerCase()),
					).length === 0 ? (
						<div className="px-2 py-6 text-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>
							—
						</div>
					) : (
						flatSessions
							.filter(
								(s) =>
									s.name?.toLowerCase().includes(q.trim().toLowerCase()) ||
									s.firstMessage.toLowerCase().includes(q.trim().toLowerCase()) ||
									basename(s.cwd).toLowerCase().includes(q.trim().toLowerCase()),
							)
							.map((s) => sessionRow(s, false))
					)
				) : searchOpen ? (
					// 空查询：工作区平铺（照 dsh 截图）
					[...workspaceGroups, ...(ungroupedGroup ? [ungroupedGroup] : [])].map((g) => (
						<div
							key={g.cwd}
							className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors"
							onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
							onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
							onClick={() => {
								setSearchOpen(false);
								toggleOpen(g.cwd);
							}}
							title={g.cwd === "__ungrouped__" ? (t.ungrouped || "未分组") : g.cwd}
						>
							<span style={{ color: "var(--dsw-label-tertiary)", display: "inline-flex" }}>
								<IconFolderClose16 size={15} />
							</span>
							<span className="truncate" style={{ fontSize: 13 }}>
								{g.cwd === "__ungrouped__"
									? (t.ungrouped || "未分组")
									: (getWorkspaceName ? getWorkspaceName(g.cwd) : basename(g.cwd))}
							</span>
						</div>
					))
				) : groupBy === "workspace" ? (
					// 按工作区分组
					workspaceGroups.length === 0 && !ungroupedGroup ? (
						<div className="px-2 py-6 text-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>
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
					(flatSessions.length === 0
						? [...workspaceGroups, ...(ungroupedGroup ? [ungroupedGroup] : [])].map((g) => (
								<div key={g.cwd} className="flex items-center gap-2.5 rounded-xl px-2.5 py-2" title={g.cwd}>
									<span style={{ color: "var(--dsw-label-tertiary)", display: "inline-flex" }}>
										<IconFolderClose16 size={15} />
									</span>
									<span className="truncate" style={{ fontSize: 13 }}>
										{g.cwd === "__ungrouped__"
											? (t.ungrouped || "未分组")
											: (getWorkspaceName ? getWorkspaceName(g.cwd) : basename(g.cwd))}
									</span>
								</div>
						  ))
						: flatSessions.map((s) => sessionRow(s, false)))
				)}
			</div>

			{/* 设置固定左下角 */}
			<div className="px-3 py-2.5">
				<button
					className="flex w-full items-center gap-2.5 rounded-xl px-4 py-2 text-left transition-colors"
					style={{ color: "var(--dsw-label-secondary)" }}
					onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
					onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
					onClick={onOpenSettings}
				>
					<IconSettingsOutline16 size={16} />
					<span style={{ fontSize: "var(--dsh-content-font-size)" }}>{t.settings}</span>
				</button>
			</div>

			{/* 重命名弹窗（照用户截图 media_1788745548711.png，通过 createPortal 挂载到 document.body 确保浏览器正居中） */}
			{mounted && renameTarget && createPortal(
				<div
					className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150"
					onClick={() => setRenameTarget(null)}
				>
					<div
						className="relative w-full max-w-[420px] rounded-[24px] bg-[#212121] p-6 text-white shadow-2xl border border-white/10"
						onClick={(e) => e.stopPropagation()}
						role="dialog"
						aria-modal="true"
					>
						{/* 关闭按钮 */}
						<button
							type="button"
							onClick={() => setRenameTarget(null)}
							className="absolute right-5 top-5 rounded-full p-1 text-zinc-400 hover:text-white hover:bg-white/10 transition"
							aria-label={t.close}
						>
							<IconCloseOutline14 size={16} />
						</button>

						{/* 标题 */}
						<h3 className="text-lg font-medium text-white pr-8">
							{renameTarget.type === "session"
								? (t.renameSession || "重命名会话")
								: (t.renameWorkspace || "重命名工作区")}
						</h3>

						{/* 输入框 */}
						<div className="mt-5 mb-6">
							<input
								ref={renameInputRef}
								type="text"
								value={renameValue}
								onChange={(e) => setRenameValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleConfirmRename();
									if (e.key === "Escape") setRenameTarget(null);
								}}
								className="w-full rounded-full bg-white/[0.05] border border-white/15 px-4 py-2.5 text-[14.5px] text-white outline-none focus:border-white/40 focus:ring-1 focus:ring-white/30 transition"
							/>
						</div>

						{/* 按钮区 */}
						<div className="flex items-center justify-end gap-3">
							<button
								type="button"
								onClick={() => setRenameTarget(null)}
								className="rounded-full bg-[#2c2c2c] px-5 py-2 text-sm font-medium text-zinc-200 hover:bg-[#383838] transition"
							>
								{t.cancel}
							</button>
							<button
								type="button"
								onClick={handleConfirmRename}
								className="rounded-full bg-white px-5 py-2 text-sm font-medium text-black hover:bg-zinc-200 transition"
							>
								{t.rename}
							</button>
						</div>
					</div>
				</div>,
				document.body
			)}

			{/* 删除工作区确认弹窗（照用户截图 media_1788745235179.png 与 media_1788746156687.png，通过 createPortal 挂载到 document.body 确保浏览器正居中） */}
			{mounted && deleteWorkspaceTarget && createPortal(
				<div
					className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150"
					onClick={() => setDeleteWorkspaceTarget(null)}
				>
					<div
						className="relative w-full max-w-[420px] rounded-[24px] bg-[#212121] p-6 text-white shadow-2xl border border-white/10"
						onClick={(e) => e.stopPropagation()}
						role="dialog"
						aria-modal="true"
					>
						{/* 关闭按钮 */}
						<button
							type="button"
							onClick={() => setDeleteWorkspaceTarget(null)}
							className="absolute right-5 top-5 rounded-full p-1 text-zinc-400 hover:text-white hover:bg-white/10 transition"
							aria-label={t.close}
						>
							<IconCloseOutline14 size={16} />
						</button>

						{/* 标题 */}
						<h3 className="text-lg font-medium text-white pr-8">
							{t.deleteWorkspace}
						</h3>

						{/* 描述文本 */}
						<p className="mt-3 text-[14.5px] leading-relaxed text-zinc-300">
							{(t.deleteWorkspaceConfirm || "将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。").replace(
								"{name}",
								deleteWorkspaceTarget.name,
							)}
						</p>

						{/* 按钮区 */}
						<div className="mt-6 flex items-center justify-end gap-3">
							<button
								type="button"
								onClick={() => setDeleteWorkspaceTarget(null)}
								className="rounded-full bg-[#2c2c2c] px-5 py-2 text-sm font-medium text-zinc-200 hover:bg-[#383838] transition"
							>
								{t.cancel}
							</button>
							<button
								type="button"
								onClick={handleConfirmDeleteWorkspace}
								className="rounded-full bg-[#2c2c2c] px-5 py-2 text-sm font-medium text-[#f87171] hover:bg-[#383838] hover:text-[#ef4444] transition"
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

function MenuItem({
	icon,
	label,
	danger,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	danger?: boolean;
	onClick: (e: React.MouseEvent) => void;
}) {
	return (
		<button
			className="flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors"
			style={{ fontSize: 13, color: danger ? "var(--dsw-danger)" : "var(--dsw-label-primary)" }}
			onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
			onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
			onClick={onClick}
		>
			{icon}
			{label}
		</button>
	);
}

function MenuCheck({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
	return (
		<button
			className="flex w-full items-center justify-between pl-6 pr-4 py-2 text-left transition-colors"
			style={{ fontSize: 13, color: "var(--dsw-label-primary)" }}
			onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
			onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
			onClick={onClick}
		>
			{label}
			{checked && <IconCheckOutline14 size={13} />}
		</button>
	);
}
