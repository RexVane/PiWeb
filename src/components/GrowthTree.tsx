"use client";

/**
 * 项目树（项目栏与文件查看器「文件」页签共用）：
 * 紧凑行（22px）、material 图标、名字按状态着色、行尾 +/− 与 A/M/D/R 角标、目录汇总角标、
 * 生成中呼吸态、新步入场动画、窗口化渲染、键盘导航（↑↓ 移动，←→ 收展，Enter 打开）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconEditOutline16, IconFileOutline16, IconTriangleRightFill14 } from "@/components/icons";
import { useI18n } from "@/i18n";
import { fileIconSrc, folderIconSrc } from "@/lib/file-icons";
import { flattenTree, treeNodeKey, type FlatRow, type TreeNode } from "@/lib/growth-tree";

const ROW_H = 22;
const OVERSCAN = 12;

export interface GrowthTreeProps {
	tree: TreeNode;
	expanded: Set<string>;
	fresh?: Set<string>;
	filter?: string;
	onlyChanges?: boolean;
	/** 查看器里正在看的文件 */
	selectedPath?: string | null;
	onToggleDir: (path: string) => void;
	onExpandLazy?: (path: string) => void;
	onOpenFile: (node: TreeNode) => void;
	onReference?: (path: string) => void;
	onOpenEditor?: (path: string) => void;
	/** 需要滚到并聚焦的路径（面包屑跳转）；revealKey 变化时即使路径相同也重新滚动 */
	revealPath?: string | null;
	revealKey?: number;
	emptyText?: string;
}

function statusColor(status?: TreeNode["status"]): string | undefined {
	if (status === "A") return "var(--dsw-success)";
	if (status === "M") return "var(--dsw-warn)";
	if (status === "D") return "var(--dsw-danger)";
	if (status === "R") return "var(--dsw-accent)";
	return undefined;
}

function dirBadge(node: TreeNode): { text: string; color: string } | null {
	const c = node.counts;
	if (!c) return null;
	const total = c.added + c.modified + c.deleted + c.renamed;
	if (c.pending && !total) return { text: "…", color: "var(--dsw-label-caption)" };
	if (!total) return null;
	const color = c.deleted >= c.added && c.deleted >= c.modified ? "var(--dsw-danger)" : c.added >= c.modified ? "var(--dsw-success)" : "var(--dsw-warn)";
	return { text: String(total), color };
}

export const GrowthTree = memo(function GrowthTree({
	tree,
	expanded,
	fresh,
	filter = "",
	onlyChanges = false,
	selectedPath,
	onToggleDir,
	onExpandLazy,
	onOpenFile,
	onReference,
	onOpenEditor,
	revealPath,
	revealKey,
	emptyText,
}: GrowthTreeProps) {
	const { t } = useI18n();
	const rows = useMemo(() => flattenTree(tree, expanded, { onlyChanges, filter }), [tree, expanded, onlyChanges, filter]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState({ top: 0, height: 600 });
	const [focused, setFocused] = useState<string | null>(null);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
		update();
		el.addEventListener("scroll", update, { passive: true });
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => {
			el.removeEventListener("scroll", update);
			ro.disconnect();
		};
	}, []);

	// 面包屑跳转：滚到目标行并聚焦
	useEffect(() => {
		if (!revealPath) return;
		const idx = rows.findIndex((r) => r.node.path === revealPath);
		if (idx < 0) return;
		setFocused(treeNodeKey(rows[idx].node));
		const el = scrollRef.current;
		if (!el) return;
		const top = idx * ROW_H;
		if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2) });
	}, [revealPath, revealKey, rows]);

	const activate = useCallback(
		(row: FlatRow) => {
			const node = row.node;
			if (node.kind === "dir") {
				if (node.lazy && !row.expanded && onExpandLazy) void onExpandLazy(node.path);
				onToggleDir(node.path);
			} else onOpenFile(node);
		},
		[onExpandLazy, onToggleDir, onOpenFile],
	);

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (!rows.length) return;
		const idx = Math.max(0, rows.findIndex((r) => treeNodeKey(r.node) === focused));
		const row = rows[idx];
		const focusRow = (i: number) => {
			const target = rows[Math.max(0, Math.min(rows.length - 1, i))];
			setFocused(treeNodeKey(target.node));
			const el = scrollRef.current;
			if (!el) return;
			const top = Math.max(0, Math.min(rows.length - 1, i)) * ROW_H;
			if (top < el.scrollTop) el.scrollTop = top;
			else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
		};
		if (e.key === "ArrowDown") {
			e.preventDefault();
			focusRow(focused === null ? 0 : idx + 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			focusRow(idx - 1);
		} else if (e.key === "ArrowRight" && row) {
			e.preventDefault();
			if (row.node.kind === "dir" && !row.expanded) activate(row);
			else focusRow(idx + 1);
		} else if (e.key === "ArrowLeft" && row) {
			e.preventDefault();
			if (row.node.kind === "dir" && row.expanded) onToggleDir(row.node.path);
			else {
				const parent = row.node.path.includes("/") ? row.node.path.slice(0, row.node.path.lastIndexOf("/")) : "";
					const pi = rows.findIndex((r) => r.node.kind === "dir" && r.node.path === parent);
				if (pi >= 0) focusRow(pi);
			}
		} else if ((e.key === "Enter" || e.key === " ") && row) {
			e.preventDefault();
			activate(row);
		} else if (e.key === "Home") {
			e.preventDefault();
			focusRow(0);
		} else if (e.key === "End") {
			e.preventDefault();
			focusRow(rows.length - 1);
		}
	};

	const start = Math.max(0, Math.floor(viewport.top / ROW_H) - OVERSCAN);
	const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_H) + OVERSCAN);
	const visible = rows.slice(start, end);

	return (
		<div
			ref={scrollRef}
			className="pw-tree min-h-0 flex-1 overflow-auto outline-none"
			tabIndex={0}
			role="tree"
			onKeyDown={onKeyDown}
			// 焦点落到行内的「引用 / 编辑器」按钮上仍算在树里，不清键盘焦点行
			onBlur={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null);
			}}
		>
			{rows.length === 0 ? (
				<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "10px 12px" }}>{emptyText ?? t.filesEmpty}</div>
			) : (
				<div style={{ height: rows.length * ROW_H, position: "relative" }}>
					{visible.map((row, i) => (
						<TreeRow
							key={treeNodeKey(row.node)}
							row={row}
							top={(start + i) * ROW_H}
							fresh={row.node.kind === "file" && Boolean(fresh?.has(row.node.path))}
							selected={row.node.kind === "file" && selectedPath === row.node.path}
							focused={focused === treeNodeKey(row.node)}
							onActivate={activate}
							onFocusRow={setFocused}
							onReference={onReference}
							onOpenEditor={onOpenEditor}
							pendingLabel={t.growthPending}
								lazyLabel={t.growthLazyDir}
								deletedLabel={t.growthStatD}
								referenceLabel={t.fileReference}
							editorLabel={t.fileOpenEditor}
						/>
					))}
				</div>
			)}
		</div>
	);
});

const TreeRow = memo(function TreeRow({
	row,
	top,
	fresh,
	selected,
	focused,
	onActivate,
	onFocusRow,
	onReference,
	onOpenEditor,
	pendingLabel,
	lazyLabel,
	deletedLabel,
	referenceLabel,
	editorLabel,
}: {
	row: FlatRow;
	top: number;
	fresh: boolean;
	selected: boolean;
	focused: boolean;
	onActivate: (row: FlatRow) => void;
	onFocusRow: (path: string) => void;
	onReference?: (path: string) => void;
	onOpenEditor?: (path: string) => void;
	pendingLabel: string;
	lazyLabel: string;
	deletedLabel: string;
	referenceLabel: string;
	editorLabel: string;
}) {
	const { node, depth, expanded } = row;
	const isDir = node.kind === "dir";
	const color = statusColor(node.status);
	const badge = isDir ? dirBadge(node) : null;
	const diskOnly = Boolean(node.lazy && !node.counts);
	const title = [isDir ? `${node.path}/` : node.path, node.status === "D" ? deletedLabel : "", node.status === "R" && node.from ? `← ${node.from}` : "", node.pending ? pendingLabel : "", diskOnly ? lazyLabel : ""].filter(Boolean).join("\n");
	return (
		<div
			className="pw-tree-row group/row"
			role="treeitem"
			aria-expanded={isDir ? expanded : undefined}
			aria-selected={selected}
			data-selected={selected || undefined}
			data-focused={focused || undefined}
			data-fresh={fresh ? node.status ?? "M" : undefined}
			data-status={node.status}
			data-pending={node.pending || undefined}
			data-lazy={diskOnly ? "1" : undefined}
			style={{ top, paddingLeft: depth * 12 + 6 }}
			title={title}
			onClick={() => {
				onFocusRow(treeNodeKey(node));
				onActivate(row);
			}}
		>
			<span className="pw-tree-chevron" aria-hidden>
				{isDir && <IconTriangleRightFill14 size={10} style={{ transform: expanded ? "rotate(90deg)" : undefined, transition: "transform var(--ds-duration-fast)" }} />}
			</span>
			<img className="pw-tree-icon" data-kind={node.kind} src={isDir ? folderIconSrc(node.name, expanded) : fileIconSrc(node.name)} alt="" draggable={false} />
			<span className="pw-tree-name" style={{ color, textDecoration: node.status === "D" ? "line-through" : undefined }}>
				{node.name}{isDir ? "/" : ""}
				{node.status === "D" && <span className="pw-tree-from">({deletedLabel})</span>}
				{node.status === "R" && node.from && <span className="pw-tree-from">← {node.from.split("/").pop()}</span>}
			</span>
			{node.pending && <span className="pw-tree-pulse" aria-label={pendingLabel} />}
			{!isDir && (onReference || onOpenEditor) && !node.lazy && (
				<span className="pw-tree-actions">
					{onReference && (
						<button
							type="button"
							className="icon-btn"
							style={{ width: 18, height: 18, borderRadius: 5 }}
							title={referenceLabel}
							onClick={(e) => {
								e.stopPropagation();
								onReference(node.path);
							}}
						>
							<IconEditOutline16 size={11} />
						</button>
					)}
					{onOpenEditor && (
						<button
							type="button"
							className="icon-btn"
							style={{ width: 18, height: 18, borderRadius: 5 }}
							title={editorLabel}
							onClick={(e) => {
								e.stopPropagation();
								onOpenEditor(node.path);
							}}
						>
							<IconFileOutline16 size={11} />
						</button>
					)}
				</span>
			)}
			{!isDir && node.status && (node.add || node.del) ? (
				<span className="pw-tree-stat">
					{node.add ? <span style={{ color: "var(--dsw-success)" }}>+{node.add}</span> : null}
					{node.del ? <span style={{ color: "var(--dsw-danger)" }}>−{node.del}</span> : null}
				</span>
			) : null}
			{!isDir && node.status && (
				<span className="pw-tree-badge" style={{ color, borderColor: color }}>
					{node.status}
				</span>
			)}
			{badge && (
				<span className="pw-tree-badge" style={{ color: badge.color, borderColor: badge.color }}>
					{badge.text}
				</span>
			)}
		</div>
	);
});
