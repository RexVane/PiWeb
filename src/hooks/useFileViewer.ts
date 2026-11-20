"use client";

/**
 * 文件查看器的页签状态（AppShell 持有；项目栏与查看器内部都能打开文件）。
 * 单独成文件是为了让 FileViewer 组件本体保持按需加载。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { safeLocalStorage } from "@/lib/browser-storage";
import { workspaceTabPath } from "@/lib/workspace-tab-path";

export interface ViewerGitSource {
	mode: "worktree" | "staged" | "untracked" | "commit";
	hash?: string;
	label?: string;
}

export interface ViewerOpenOptions {
	from?: string;
	lazy?: boolean;
	/** upload = 输入框里上传、还没发出去的附件（不在工作区内，走只读的 uploads 接口） */
	kind?: "dir" | "file" | "upload";
	git?: ViewerGitSource;
}

export interface ViewerTab {
	path: string;
	/** 重命名前的路径(取 diff 用) */
	from?: string;
	/** 快照之外的文件(node_modules 等):只能看磁盘上的当前内容 */
	lazy?: boolean;
	/** dir = 打开的是文件夹:正文区列目录(可逐层进入),不是文件内容 */
	kind?: "dir" | "file" | "upload";
	/** 内容由调用方直接提供(如技能文档):不取 diff、不读磁盘 */
	staticContent?: string;
	/** 最初打开的已发现来源：后续相对链接沿用它的读取边界。 */
	sourcePath?: string;
	/** Resources can be opened from a workspace other than the current chat. */
	sourceCwd?: string;
	/** 来自 Git 面板实时工作区/暂存区/提交的差异视图 */
	git?: ViewerGitSource;
}

export interface ViewerState {
	open: boolean;
	tabs: ViewerTab[];
	/** 当前页签：null = 「文件」树页签 */
	active: string | null;
}

interface ViewerScope {
	sessionPath?: string | null;
	cwd?: string;
}

const emptyState = (): ViewerState => ({ open: false, tabs: [], active: null });

function scopeKey(scope?: ViewerScope): string | null {
	const normalize = (value: string) => {
		const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
		return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
	};
	if (scope?.sessionPath) return `piweb.fileViewer.session:${normalize(scope.sessionPath)}`;
	return scope?.cwd ? `piweb.fileViewer.workspace:${normalize(scope.cwd)}` : null;
}

function parseGitSource(raw: unknown): ViewerGitSource | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	if (obj.mode !== "worktree" && obj.mode !== "staged" && obj.mode !== "untracked" && obj.mode !== "commit") return undefined;
	return {
		mode: obj.mode,
		...(typeof obj.hash === "string" ? { hash: obj.hash } : {}),
		...(typeof obj.label === "string" ? { label: obj.label } : {}),
	};
}

function restoreState(key: string | null, cwd?: string): ViewerState {
	if (!key) return emptyState();
	try {
		const saved = JSON.parse(safeLocalStorage.getItem(key) ?? "null");
		if (!saved || saved.version !== 1 || saved.open !== true || !Array.isArray(saved.tabs)) return emptyState();
		const tabs: ViewerTab[] = [];
		const paths = new Set<string>();
		let restoredActive: string | null = null;
		for (const item of saved.tabs) {
			if (!item || typeof item.path !== "string" || !item.path.trim()) continue;
			// 上传/已发现文档保留专用读取边界；普通页签保留工作区内路径，丢弃越界路径。
			const path = item.kind === "upload" || typeof item.sourcePath === "string" ? item.path : workspaceTabPath(item.path, cwd);
			if (path === null) continue;
			if (item.path === saved.active) restoredActive = path;
			if (paths.has(path)) continue;
			paths.add(path);
			const git = parseGitSource(item.git);
			tabs.push({
				path,
				...(typeof item.from === "string" ? { from: item.from } : {}),
				...(typeof item.lazy === "boolean" ? { lazy: item.lazy } : {}),
				...(item.kind === "file" || item.kind === "dir" || item.kind === "upload" ? { kind: item.kind } : {}),
				...(typeof item.sourcePath === "string" ? {
					sourcePath: item.sourcePath, lazy: true,
					...(typeof item.sourceCwd === "string" && item.sourceCwd.length <= 4096 ? { sourceCwd: item.sourceCwd } : {}),
				} : {}),
				...(git ? { git } : {}),
			});
		}
		const active = saved.active === null ? null : restoredActive ?? tabs.at(-1)?.path ?? null;
		return { open: true, tabs, active };
	} catch { return emptyState(); }
}

/** 按对话保存页签与当前文件；仅存路径等元数据，正文在打开时重新读取。 */
export function useFileViewer(scope?: ViewerScope) {
	const key = scopeKey(scope);
	const cwd = scope?.cwd;
	const currentKey = useRef(key);
	currentKey.current = key;
	const [saved, setSaved] = useState(() => ({ key, ready: key === null, value: emptyState() }));
	useEffect(() => {
		setSaved((current) => current.key === key && current.ready ? current : { key, ready: true, value: restoreState(key, cwd) });
	}, [key, cwd]);
	useEffect(() => {
		if (!saved.ready || !saved.key) return;
		if (!saved.value.open) {
			safeLocalStorage.removeItem(saved.key);
			return;
		}
		// 不把技能文档等正文复制进浏览器存储，恢复时仍走原来的来源校验。
		const tabs = saved.value.tabs.map(({ staticContent: _content, ...tab }) => tab);
		safeLocalStorage.setItem(saved.key, JSON.stringify({ version: 1, ...saved.value, tabs }));
	}, [saved]);
	const state = saved.key === key ? saved.value : emptyState();
	const setState = useCallback((change: (state: ViewerState) => ViewerState) => {
		// 旧对话里尚未完成的文档请求不能打开或关闭新对话的文件。
		if (currentKey.current !== key) return;
		setSaved((current) => {
			if (currentKey.current !== key) return current;
			const value = current.key === key && current.ready ? current.value : restoreState(key, cwd);
			return { key, ready: true, value: change(value) };
		});
	}, [key, cwd]);
	const open = useCallback((rawPath: string, opts: ViewerOpenOptions = {}) => {
		const path = opts.kind === "upload" ? rawPath : workspaceTabPath(rawPath, cwd) ?? rawPath;
		setState((s) => {
			const nextTab: ViewerTab = {
				path,
				...(opts.from ? { from: opts.from } : {}),
				...(opts.lazy !== undefined ? { lazy: opts.lazy } : {}),
				...(opts.kind ? { kind: opts.kind } : {}),
				...(opts.git ? { git: opts.git } : {}),
			};
			const exists = s.tabs.some((tab) => tab.path === path);
			const tabs = exists ? s.tabs.map((tab) => (tab.path === path ? nextTab : tab)) : [...s.tabs, nextTab];
			return { open: true, tabs, active: path };
		});
	}, [setState, cwd]);
	const openTree = useCallback(() => setState((s) => ({ ...s, open: true, active: null })), [setState]);
	/** 打开内容已就绪的文件（如技能文档）：无需 cwd / 磁盘读取 */
	const openStatic = useCallback((path: string, content: string, sourcePath = path, sourceCwd?: string) => {
		setState((s) => {
			const exists = s.tabs.some((tab) => tab.path === path);
			const documentTab = { path, staticContent: content, sourcePath, ...(sourceCwd ? { sourceCwd } : {}), lazy: true };
			const tabs = exists ? s.tabs.map((tab) => (tab.path === path ? documentTab : tab)) : [...s.tabs, documentTab];
			return { open: true, tabs, active: path };
		});
	}, [setState]);
	const close = useCallback(() => setState(emptyState), [setState]);
	const reset = close;
	const closeTab = useCallback((path: string) => {
		setState((s) => {
			const idx = s.tabs.findIndex((tab) => tab.path === path);
			if (idx < 0) return s;
			const tabs = s.tabs.filter((tab) => tab.path !== path);
			let active = s.active;
			if (active === path) active = tabs[idx]?.path ?? tabs[idx - 1]?.path ?? null;
			return { ...s, tabs, active };
		});
	}, [setState]);
	const select = useCallback((path: string | null) => setState((s) => ({ ...s, active: path })), [setState]);
	return { state, open, openStatic, openTree, close, closeTab, select, reset };
}
