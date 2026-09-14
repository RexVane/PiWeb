"use client";

/**
 * 文件查看器的页签状态（AppShell 持有；项目栏与查看器内部都能打开文件）。
 * 单独成文件是为了让 FileViewer 组件本体保持按需加载。
 */
import { useCallback, useState } from "react";

export interface ViewerTab {
	path: string;
	/** 重命名前的路径（取 diff 用） */
	from?: string;
	/** 快照之外的文件（node_modules 等）：只能看磁盘上的当前内容 */
	lazy?: boolean;
	/** 内容由调用方直接提供（如技能文档）：不取 diff、不读磁盘 */
	staticContent?: string;
}

export interface ViewerState {
	open: boolean;
	tabs: ViewerTab[];
	/** 当前页签：null = 「文件」树页签 */
	active: string | null;
}

export function useFileViewer() {
	const [state, setState] = useState<ViewerState>({ open: false, tabs: [], active: null });
	const open = useCallback((path: string, opts: { from?: string; lazy?: boolean } = {}) => {
		setState((s) => {
			const exists = s.tabs.some((tab) => tab.path === path);
			const tabs = exists ? s.tabs.map((tab) => (tab.path === path ? { ...tab, ...opts } : tab)) : [...s.tabs, { path, ...opts }];
			return { open: true, tabs, active: path };
		});
	}, []);
	const openTree = useCallback(() => setState((s) => ({ ...s, open: true, active: null })), []);
	/** 打开内容已就绪的文件（如技能文档）：无需 cwd / 磁盘读取 */
	const openStatic = useCallback((path: string, content: string) => {
		setState((s) => {
			const exists = s.tabs.some((tab) => tab.path === path);
			const tabs = exists ? s.tabs.map((tab) => (tab.path === path ? { ...tab, staticContent: content, lazy: true } : tab)) : [...s.tabs, { path, staticContent: content, lazy: true }];
			return { open: true, tabs, active: path };
		});
	}, []);
	const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
	const reset = useCallback(() => setState({ open: false, tabs: [], active: null }), []);
	const closeTab = useCallback((path: string) => {
		setState((s) => {
			const idx = s.tabs.findIndex((tab) => tab.path === path);
			if (idx < 0) return s;
			const tabs = s.tabs.filter((tab) => tab.path !== path);
			let active = s.active;
			if (active === path) active = tabs[idx]?.path ?? tabs[idx - 1]?.path ?? null;
			return { ...s, tabs, active };
		});
	}, []);
	const select = useCallback((path: string | null) => setState((s) => ({ ...s, active: path })), []);
	return { state, open, openStatic, openTree, close, closeTab, select, reset };
}
