"use client";

/**
 * 文件查看器：点击项目树里的文件弹出，80vw × 80vh 居中，右上全屏 / 关闭。
 * 页签行照 dsh：首个页签「文件」是同一棵项目树，每个打开的文件一个页签（可关），「+」模糊打开。
 * 文件页签：面包屑 + 模式（变更 / 内容 / 渲染）+ 折叠未改动 + 上一处 / 下一处 + 引用 / 编辑器打开。
 * 「变更」= 整文件行内 diff（FullDiff）；「内容」= 所选步的全文（被删文件显示删除前）；「渲染」= Markdown。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { parseUnifiedDiff, type DiffLine } from "@/components/DiffView";
import { FullDiff, type FullDiffHandle } from "@/components/FullDiff";
import { GrowthTree } from "@/components/GrowthTree";
import { IconAtOutline16, IconChevronDown14, IconChevronUp14, IconCloseOutline14, IconEditOutline16, IconFileOutline16, IconPlusOutline16, IconSearchOutline16 } from "@/components/icons";
import type { GrowthApi } from "@/hooks/useGrowth";
import { useI18n } from "@/i18n";
import { fileIconSrc } from "@/lib/file-icons";
import { fmtBytes } from "@/lib/format";
import { fuzzyScore, type TreeNode } from "@/lib/growth-tree";
import type { ViewerState } from "@/hooks/useFileViewer";
import { useWorkspaceFiles } from "@/hooks/useWorkspaceFiles";
import { highlightCode, languageForPath } from "@/lib/highlight";

type Mode = "diff" | "content" | "render";

const fetchCache = new Map<string, Promise<unknown>>();
async function requestJson<T>(url: string): Promise<T> {
	const r = await fetch(url);
	const j = await r.json();
	if (!r.ok || !j.success) {
		const err = new Error(j.error || `request failed (${r.status})`) as Error & { status?: number };
		err.status = r.status;
		throw err;
	}
	return j.data as T;
}

function cachedJson<T>(url: string): Promise<T> {
	let p = fetchCache.get(url) as Promise<T> | undefined;
	if (!p) {
		p = requestJson<T>(url);
		p.catch(() => fetchCache.delete(url));
		fetchCache.set(url, p);
		if (fetchCache.size > 200) fetchCache.delete(fetchCache.keys().next().value as string);
	}
	return p;
}

/** 文件夹预览：一页目录条目（分页；后端已按 .gitignore 过滤） */
interface DirEntry { name: string; kind: "dir" | "file"; size?: number }
interface DirPage { dir: string; entries: DirEntry[]; nextOffset: number | null; truncated: boolean }

interface Loaded {
	key: string;
	diff: DiffLine[] | null;
	content: string | null;
	binary: boolean;
	truncated: boolean;
	notice: "deleted" | "historical" | "missing" | "disk" | "nochange" | null;
	error: string | null;
}

/** 代码全文：行号栏 + 高亮正文 */
function CodeBlock({ content, name }: { content: string; name: string }) {
	const html = useMemo(() => highlightCode(content, languageForPath(name)), [content, name]);
	const lines = content.split("\n").length;
	const gutterWidth = `${String(lines).length + 1}ch`;
	return (
		<div className="flex min-h-0 flex-1 overflow-auto" style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: "20px" }}>
			<pre aria-hidden className="flex-none select-none py-2 pl-3 pr-2 text-right" style={{ width: gutterWidth, minWidth: gutterWidth, color: "var(--dsw-label-caption)", margin: 0, position: "sticky", left: 0, background: "var(--dsw-glass-modal)" }}>
				{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
			</pre>
			{html !== null ? (
				<pre className="hljs min-w-0 flex-1 py-2 pl-3 pr-4" style={{ margin: 0, background: "transparent", color: "var(--dsw-label-secondary)" }}>
					<code dangerouslySetInnerHTML={{ __html: html }} />
				</pre>
			) : (
				<pre className="min-w-0 flex-1 py-2 pl-3 pr-4" style={{ margin: 0, color: "var(--dsw-label-secondary)" }}>{content}</pre>
			)}
		</div>
	);
}

export function FileViewer({
	state,
	growth,
	cwd,
	onClose,
	onSelectTab,
	onCloseTab,
	onOpen,
	onOpenContent,
	onReference,
	onOpenEditor,
}: {
	state: ViewerState;
	growth: GrowthApi;
	cwd: string;
	onClose: () => void;
	onSelectTab: (path: string | null) => void;
	onCloseTab: (path: string) => void;
	onOpen: (path: string, opts?: { from?: string; lazy?: boolean; kind?: "dir" | "file" }) => void;
	onOpenContent?: (path: string, content: string, sourcePath?: string) => void;
	onReference?: (path: string) => void;
	onOpenEditor?: (path: string) => void;
}) {
	const { t } = useI18n();
	const [fullscreen, setFullscreen] = useState(false);
	const [mode, setMode] = useState<Mode>("diff");
	const [modeTouched, setModeTouched] = useState(false);
	const [folded, setFolded] = useState(true);
	const [quickOpen, setQuickOpen] = useState(false);
	const [quickQuery, setQuickQuery] = useState("");
	const [quickIndex, setQuickIndex] = useState(0);
	const workspaceFiles = useWorkspaceFiles(cwd, state.open && quickOpen);
	const [linkError, setLinkError] = useState<string | null>(null);
	const [treeFilter, setTreeFilter] = useState("");
	const [reveal, setReveal] = useState<{ path: string; key: number } | null>(null);
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [dirPage, setDirPage] = useState<(DirPage & { key: string; error?: string }) | null>(null);
	const diffRef = useRef<FullDiffHandle>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const quickInputRef = useRef<HTMLInputElement>(null);

	const activeTab = state.tabs.find((tab) => tab.path === state.active) ?? null;
	const change = useMemo(() => (activeTab ? growth.changes.find((c) => c.path === activeTab.path) ?? null : null), [activeTab, growth.changes]);
	const isMarkdown = Boolean(activeTab && /\.(md|mdx|markdown)$/i.test(activeTab.path));
	const range = growth.range;

	// 切页签：模式按是否有改动自动选，用户手动切过才保留
	useEffect(() => {
		setModeTouched(false);
		setDirFallback(null);
		setLinkError(null);
	}, [state.active]);
	useEffect(() => {
		if (modeTouched || !activeTab) return;
		setMode(change && !activeTab.lazy ? "diff" : isMarkdown ? "render" : "content");
	}, [activeTab, change, isMarkdown, modeTouched]);

	/** 目录兜底：文件读取报 400（不存在 / 不是文件）时探一下目录接口，成功就当文件夹显示 */
	const [dirFallback, setDirFallback] = useState<string | null>(null);
	const dirPath = activeTab?.kind === "dir" ? activeTab.path : dirFallback;
	const isDir = Boolean(dirPath);
	// @src/ 这类带尾斜杠的引用：列目录时去掉
	const dirRel = dirPath ? dirPath.replace(/\/+$/, "") : null;
	const dirKey = dirRel !== null && cwd ? `dir|${cwd}|${dirRel}` : null;
	// 只认当前目录的那一页：从一个文件夹页签切到另一个时，上一个目录的条目不能在新请求回来前冒充新目录
	// （点上去会拼出不存在的路径），「加载更多」也不能接着上一个目录的偏移拉
	const page = dirPage && dirPage.key === dirKey ? dirPage : null;
	// 文件夹：列目录（分页，后端已按 .gitignore 过滤），不读文件内容
	useEffect(() => {
		if (dirRel === null || !cwd || !dirKey) {
			setDirPage(null);
			return;
		}
		let alive = true;
		void (async () => {
			try {
				const data = await requestJson<DirPage>(`/api/files?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(dirRel)}&offset=0`);
				if (alive) setDirPage({ key: dirKey, ...data });
			} catch (error) {
				if (alive) setDirPage({ key: dirKey, dir: dirRel, entries: [], nextOffset: null, truncated: false, error: error instanceof Error ? error.message : t.viewerLoadFailed });
			}
		})();
		return () => {
			alive = false;
		};
	}, [dirRel, dirKey, cwd, t.viewerLoadFailed]);

	/** 目录还有下一页时接着拉（大目录：node_modules 这种已被忽略，剩下的也不会太多） */
	const loadMore = useCallback(async () => {
		if (!page?.nextOffset || dirRel === null || !cwd) return;
		const base = page;
		try {
			const data = await requestJson<DirPage>(`/api/files?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(dirRel)}&offset=${base.nextOffset}`);
			// 请求途中切走了（或别的请求先换了这一页）就丢掉结果
			setDirPage((current) => (current === base ? { ...base, ...data, key: base.key, entries: [...base.entries, ...data.entries] } : current));
		} catch {
			// 下一页失败就留在当前这页，用户可以再点
		}
	}, [page, dirRel, cwd]);

	// 取数据
	useEffect(() => {
		if (!activeTab || activeTab.kind === "dir") {
			setLoaded(null);
			return;
		}
		const tab = activeTab;
		const key = `${tab.path}|${mode}|${range?.from ?? ""}|${range?.to ?? ""}|${change?.status ?? ""}`;
		let alive = true;
		const done = (partial: Partial<Loaded>) => {
			if (alive) setLoaded({ key, diff: null, content: null, binary: false, truncated: false, notice: null, error: null, ...partial });
		};
		// 静态内容页签（技能文档等）：调用方已带内容，不读磁盘
		if (tab.staticContent !== undefined) {
			done({ content: tab.staticContent });
			return () => {
				alive = false;
			};
		}
		if (!cwd) {
			setLoaded(null);
			return;
		}
		const q = `cwd=${encodeURIComponent(cwd)}`;
		const diskContent = async (notice: Loaded["notice"]) => {
			try {
				const data = await requestJson<{ content: string; binary: boolean; truncated: boolean }>(`/api/files?read=1&${q}&path=${encodeURIComponent(tab.path)}`);
				done({ content: data.content, binary: data.binary, truncated: data.truncated, notice });
			} catch (error) {
				if ((error as { status?: number }).status !== 400) throw error;
				// 400 有两种：文件不存在 / 路径其实是目录。探一下目录接口，能列出条目就当文件夹打开
				try {
					await requestJson<DirPage>(`/api/files?${q}&path=${encodeURIComponent(tab.path)}&offset=0`);
					done({ notice: null });
					setDirFallback(tab.path);
					return;
				} catch {
					// 目录也列不出来：照旧报「文件不存在」
				}
				done({ notice: "missing" });
			}
		};
		const snapshotContent = async (tree: string, notice: Loaded["notice"]) => {
			try {
				const data = await cachedJson<{ content: string; binary: boolean; truncated: boolean }>(`/api/growth?${q}&tree=${tree}&path=${encodeURIComponent(tab.path)}&content=1`);
				done({ content: data.content, binary: data.binary, truncated: data.truncated, notice });
			} catch (error) {
				if ((error as { status?: number }).status === 404) {
					// 跟随中的文件可能在本轮后续工具里被删掉；从最近一次涉及它的快照取回最后内容。
					const upto = growth.selected ? growth.rounds.findIndex((round) => round.commit === growth.selected!.commit) : growth.rounds.length - 1;
					const prior = growth.rounds.slice(0, upto + 1).reverse().find((round) =>
						round.changes.some((item) => item.path === tab.path || item.from === tab.path),
					);
					const priorTree = prior?.changes.some((item) => (item.status === "D" && item.path === tab.path) || (item.status === "R" && item.from === tab.path))
						? prior.parentTree
						: prior?.tree;
					if (priorTree && priorTree !== tree) {
						try {
							const data = await cachedJson<{ content: string; binary: boolean; truncated: boolean }>(`/api/growth?${q}&tree=${priorTree}&path=${encodeURIComponent(tab.path)}&content=1`);
							done({ content: data.content, binary: data.binary, truncated: data.truncated, notice: "historical" });
							return;
						} catch (priorError) {
							if ((priorError as { status?: number }).status !== 404) throw priorError;
						}
					}
					await diskContent("disk");
					return;
				}
				throw error;
			}
		};
		void (async () => {
			try {
				if (tab.lazy || !range) {
					// 会话还没有任何快照时整棵树都是磁盘条目，「不在快照里」的提示会误导
					await diskContent(tab.lazy && growth.rounds.length > 0 ? "disk" : null);
					return;
				}
				if (mode === "diff") {
					if (!change) {
						await snapshotContent(range.to, "nochange");
						return;
					}
					const data = await cachedJson<{ patch: string; binary: boolean; truncated: boolean }>(
						`/api/growth?${q}&from=${range.from}&to=${range.to}&path=${encodeURIComponent(tab.path)}${tab.from ?? change.from ? `&renamedFrom=${encodeURIComponent(tab.from ?? change.from ?? "")}` : ""}`,
					);
					if (data.binary) {
						done({ binary: true });
						return;
					}
					const lines = parseUnifiedDiff(data.patch);
					if (!lines) {
						await snapshotContent(range.to, "nochange");
						return;
					}
					done({ diff: lines, truncated: data.truncated, notice: change.status === "D" ? "deleted" : null });
					return;
				}
				await snapshotContent(range.to, null);
			} catch (error) {
				done({ error: error instanceof Error ? error.message : t.viewerLoadFailed });
			}
		})();
		return () => {
			alive = false;
		};
	}, [activeTab, cwd, mode, range, change, growth.rounds, growth.selected, t.viewerLoadFailed]);

	// 键盘：Esc 关（先关快速打开）、Ctrl/⌘+W 关页签、Ctrl/⌘+P 快速打开、[ ] 上一处下一处
	useEffect(() => {
		if (!state.open) return;
		const h = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
			if (e.key === "Escape") {
				e.preventDefault();
				if (quickOpen) setQuickOpen(false);
				else onClose();
				return;
			}
			const mod = e.ctrlKey || e.metaKey;
			if (mod && e.key.toLowerCase() === "w") {
				e.preventDefault();
				if (state.active) onCloseTab(state.active);
				else onClose();
				return;
			}
			if (mod && e.key.toLowerCase() === "p") {
				e.preventDefault();
				setQuickOpen(true);
				return;
			}
			if (!typing && !mod && mode === "diff") {
				if (e.key === "]") diffRef.current?.nextChange();
				else if (e.key === "[") diffRef.current?.prevChange();
			}
		};
		document.addEventListener("keydown", h);
		return () => document.removeEventListener("keydown", h);
	}, [state.open, state.active, quickOpen, mode, onClose, onCloseTab]);

	useEffect(() => {
		if (quickOpen) {
			setQuickQuery("");
			setQuickIndex(0);
			setTimeout(() => quickInputRef.current?.focus(), 0);
		}
	}, [quickOpen]);
	useEffect(() => {
		if (state.open) setTimeout(() => rootRef.current?.focus(), 0);
	}, [state.open]);

	const quickMatches = useMemo(() => {
		if (!quickOpen) return [];
		const q = quickQuery.trim();
		// 树只加载已展开的节点；快速打开必须同时搜索完整索引，并保留快照里的历史文件。
		const paths = new Set([...growth.filePaths, ...workspaceFiles.candidates.filter((candidate) => !candidate.dir).map((candidate) => candidate.path)]);
		const scored = [...paths]
			.map((p) => ({ p, s: fuzzyScore(q, p) }))
			.filter((x) => x.s >= 0)
			.sort((a, b) => b.s - a.s || a.p.length - b.p.length)
			.slice(0, 50);
		return scored.map((x) => x.p);
	}, [quickOpen, quickQuery, growth.filePaths, workspaceFiles.candidates]);
	const selectedQuickIndex = Math.max(0, Math.min(quickIndex, quickMatches.length - 1));
	const linkScope = useRef(activeTab);
	useEffect(() => {
		linkScope.current = state.open ? activeTab : null;
		return () => { linkScope.current = null; };
	}, [activeTab, state.open]);

	const openDocumentLink = async (href: string) => {
		if (!activeTab) return;
		setLinkError(null);
		try {
			const current = activeTab.path.replaceAll("\\", "/");
			const absolute = current.startsWith("/") || /^[a-z]:\//i.test(current);
			const url = new URL(href, `file:///${current.replace(/^\//, "").split("/").map(encodeURIComponent).join("/")}`);
			let target = decodeURIComponent(url.pathname);
			if (!absolute || /^\/[a-z]:\//i.test(target)) target = target.slice(1);
			if (activeTab.staticContent === undefined || !onOpenContent) {
				onOpen(target, { lazy: true });
				return;
			}
			// 技能等工作区外文档仍走发现来源校验，不把文档路径当成任意 cwd。
			const sourcePath = activeTab.sourcePath ?? activeTab.path;
			const response = await fetch("/api/prompts", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "read", cwd, filePath: target, sourcePath }),
			});
			const payload = await response.json();
			if (!response.ok || !payload.success) throw new Error(payload.error || t.viewerLoadFailed);
			// 请求回来时用户可能已经切到另一份文档或关闭查看器。
			if (linkScope.current === activeTab) onOpenContent(target, payload.data.content, sourcePath);
		} catch (error) {
			if (linkScope.current === activeTab) setLinkError(error instanceof Error ? error.message : t.viewerLoadFailed);
		}
	};

	if (!state.open) return null;

	const segments = activeTab ? activeTab.path.split("/") : [];
	const goCrumb = (i: number) => {
		const dir = segments.slice(0, i + 1).join("/");
		growth.revealPath(dir);
		setReveal({ path: dir, key: Date.now() });
		onSelectTab(null);
	};
	const roundName = growth.selected ? (growth.selected.n ? t.growthRoundLabel.replace("{n}", String(growth.selected.n)) : t.growthKindUser) : "";
	const stepBadge = roundName
		? `${roundName}${change ? ` · +${change.add ?? 0} −${change.del ?? 0}` : ""}`
		: "";
	const isDiffMode = mode === "diff" && Boolean(loaded?.diff);
	const noticeText = loaded?.notice === "deleted" ? t.viewerDeleted : loaded?.notice === "historical" ? t.viewerHistorical : loaded?.notice === "missing" ? t.viewerMissing : loaded?.notice === "disk" ? t.viewerNotInSnapshot : loaded?.notice === "nochange" ? t.viewerNoChanges : "";

	return (
		<div className="pw-viewer-mask modal-mask fixed inset-0 z-[105] flex items-center justify-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div
				ref={rootRef}
				className="pw-viewer glass-modal flex flex-col overflow-hidden outline-none"
				data-fullscreen={fullscreen || undefined}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				data-testid="file-viewer"
			>
				{/* 页签行 */}
				<div className="pw-viewer-tabs hairline-b" onDoubleClick={(e) => e.target === e.currentTarget && setFullscreen((f) => !f)}>
					<button type="button" className="pw-viewer-tab" data-active={state.active === null} onClick={() => onSelectTab(null)}>
						<img className="pw-tree-icon" src="/file-icons/folder-open.svg" alt="" />
						<span>{t.projectPanel}</span>
					</button>
					<div className="pw-viewer-tabstrip">
						{state.tabs.map((tab) => (
							<div
								key={tab.path}
								className="pw-viewer-tab"
								data-active={state.active === tab.path}
								onAuxClick={(e) => {
									if (e.button === 1) onCloseTab(tab.path);
								}}
							>
								<button type="button" className="pw-viewer-tab-main" title={tab.path} onClick={() => onSelectTab(tab.path)}>
									<img className="pw-tree-icon" src={fileIconSrc(tab.path.split("/").pop() ?? tab.path)} alt="" />
									<span className="truncate">{tab.path.split("/").pop()}</span>
								</button>
								<button
									type="button"
									className="pw-viewer-tab-close"
									title={t.viewerCloseTab}
									aria-label={`${t.viewerCloseTab}: ${tab.path}`}
									onClick={() => onCloseTab(tab.path)}
								>
									<IconCloseOutline14 size={10} />
								</button>
							</div>
						))}
					</div>
					<button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={`${t.viewerQuickOpen} (Ctrl/⌘+P)`} onClick={() => setQuickOpen(true)}>
						<IconPlusOutline16 size={13} />
					</button>
					<div className="flex-1" />
					<button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={fullscreen ? t.viewerExitFullscreen : t.viewerFullscreen} onClick={() => setFullscreen((f) => !f)} data-testid="viewer-fullscreen">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
							{fullscreen ? (
								<path d="M6 1v5H1M10 1v5h5M6 15v-5H1M10 15v-5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
							) : (
								<path d="M1 6V1h5M15 6V1h-5M1 10v5h5M15 10v5h-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
							)}
						</svg>
					</button>
					<button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={`${t.close} (Esc)`} onClick={onClose} data-testid="viewer-close">
						<IconCloseOutline14 size={13} />
					</button>
				</div>

				{activeTab ? (
					<>
						{/* 面包屑 + 工具 */}
						<div className="pw-viewer-toolbar hairline-b">
							<div className="pw-crumb min-w-0 flex-1">
								{segments.map((seg, i) => (
									<span key={i} className="flex items-center">
										{i > 0 && <span className="pw-crumb-sep">/</span>}
										{i < segments.length - 1 ? (
											<button type="button" onClick={() => goCrumb(i)}>{seg}</button>
										) : (
											<span style={{ color: "var(--dsw-label-primary)", fontWeight: 500 }}>{seg}</span>
										)}
									</span>
								))}
							</div>
							{stepBadge && !activeTab.lazy && (
								<span className="flex-none truncate" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)", maxWidth: 220 }}>
									{stepBadge}
								</span>
							)}
							{!activeTab.lazy && !isDir && (
								<span className="pw-seg" role="radiogroup">
									{(["diff", "content", ...(isMarkdown ? ["render" as const] : [])] as Mode[]).map((m) => (
										<button
											key={m}
											type="button"
											role="radio"
											aria-checked={mode === m}
											data-active={mode === m}
											onClick={() => {
												setModeTouched(true);
												setMode(m);
											}}
										>
											{m === "diff" ? t.viewerModeDiff : m === "content" ? t.viewerModeContent : t.viewerModeRender}
										</button>
									))}
								</span>
							)}
							{!isDir && activeTab.lazy && isMarkdown && (
								<span className="pw-seg" role="radiogroup">
									{(["content", "render"] as Mode[]).map((m) => (
										<button key={m} type="button" role="radio" aria-checked={mode === m} data-active={mode === m} onClick={() => { setModeTouched(true); setMode(m); }}>
											{m === "content" ? t.viewerModeContent : t.viewerModeRender}
										</button>
									))}
								</span>
							)}
							{isDiffMode && !isDir && (
								<>
									<button type="button" className="pw-chip" data-active={folded} onClick={() => setFolded((f) => !f)}>
										{folded ? t.viewerFold : t.viewerUnfold}
									</button>
									<button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title={`${t.viewerPrevChange} ([)`} onClick={() => diffRef.current?.prevChange()}>
										<IconChevronUp14 size={12} />
									</button>
									<button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title={`${t.viewerNextChange} (])`} onClick={() => diffRef.current?.nextChange()}>
										<IconChevronDown14 size={12} />
									</button>
								</>
							)}
							{onReference && (
								<button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title={t.fileReference} onClick={() => onReference(activeTab.path)}>
									<IconAtOutline16 size={13} />
								</button>
							)}
							{onOpenEditor && (
								<button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title={t.fileOpenEditor} onClick={() => onOpenEditor(activeTab.path)}>
									<IconFileOutline16 size={13} />
								</button>
							)}
						</div>

						{/* 正文 */}
						{linkError && <div role="alert" className="px-4 py-2" style={{ color: "var(--dsw-danger)", fontSize: 12.5 }}>{linkError}</div>}
						{noticeText && (
							<div className="pw-viewer-notice" data-kind={loaded?.notice}>
								{noticeText}
							</div>
						)}
						{loaded?.truncated && <div className="pw-viewer-notice" data-kind="warn">{mode === "diff" ? t.viewerPatchTruncated : t.filePreviewTruncated}</div>}
						{isDir ? (
							<div className="min-h-0 flex-1 overflow-auto" data-testid="viewer-dir">
								<div className="px-3 py-2" style={{ fontSize: 11.5, color: page?.error ? "var(--dsw-danger)" : "var(--dsw-label-caption)" }}>
									{!page ? t.panelLoading : page.error ? page.error : t.viewerDirHint.replace("{n}", String(page.entries.length))}
								</div>
								{page?.entries.map((entry) => (
									<button
										key={entry.name}
										type="button"
										className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--dsw-hover)]"
										onClick={() => (entry.kind === "dir"
											? onOpen(`${dirPath!.replace(/\/+$/, "")}/${entry.name}`, { kind: "dir", lazy: true })
											: onOpen(`${dirPath!.replace(/\/+$/, "")}/${entry.name}`, { lazy: true }))}
									>
										<img className="pw-tree-icon" src={entry.kind === "dir" ? "/file-icons/folder-close.svg" : fileIconSrc(entry.name)} alt="" />
										<span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5, fontFamily: entry.kind === "dir" ? "inherit" : "var(--font-mono)" }}>{entry.name}</span>
										{entry.kind === "file" && entry.size !== undefined && (
											<span style={{ fontSize: 11, color: "var(--dsw-label-caption)", fontVariantNumeric: "tabular-nums" }}>{fmtBytes(entry.size)}</span>
										)}
									</button>
								))}
								{page?.nextOffset ? (
									<button type="button" className="pw-chip mx-3 my-2" onClick={() => void loadMore()}>{t.viewerDirMore}</button>
								) : null}
							</div>
						) : !loaded || loaded.key !== `${activeTab.path}|${mode}|${range?.from ?? ""}|${range?.to ?? ""}|${change?.status ?? ""}` ? (
							<div className="flex min-h-0 flex-1 items-center justify-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.panelLoading}</div>
						) : loaded.error ? (
							<div className="flex min-h-0 flex-1 items-center justify-center" style={{ fontSize: 12.5, color: "var(--dsw-danger)" }}>{loaded.error}</div>
						) : loaded.notice === "missing" ? (
							<div className="flex min-h-0 flex-1 items-center justify-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.viewerMissing}</div>
						) : loaded.binary ? (
							<div className="flex min-h-0 flex-1 items-center justify-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.fileBinary}</div>
						) : loaded.diff ? (
							<FullDiff lines={loaded.diff} language={languageForPath(activeTab.path)} folded={folded} handle={diffRef} initialChange />
						) : mode === "render" && loaded.content !== null ? (
							<div className="md min-h-0 flex-1 overflow-auto px-6 py-4" style={{ fontSize: 14 }}>
								<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
									components={{ a: ({ node: _node, href, children, ...props }) => (
										<a {...props} href={href} onClick={(event) => {
											if (!href || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href)) return;
											event.preventDefault();
											void openDocumentLink(href);
										}}>{children}</a>
									) }}>
									{loaded.content}
								</ReactMarkdown>
							</div>
						) : loaded.content !== null ? (
							<CodeBlock content={loaded.content} name={activeTab.path} />
						) : null}
					</>
				) : (
					<>
						<div className="pw-viewer-toolbar hairline-b">
							<div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2" style={{ background: "var(--dsw-hover)", height: 26, maxWidth: 360 }}>
								<IconSearchOutline16 size={12} style={{ flex: "none", color: "var(--dsw-label-caption)" }} />
								<input value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} placeholder={t.growthFilter} className="min-w-0 flex-1 bg-transparent" style={{ fontSize: 12 }} />
							</div>
							<span style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
								{roundName}
							</span>
							<button type="button" className="pw-chip" onClick={growth.expandAll}>{t.growthExpandAll}</button>
							<button type="button" className="pw-chip" onClick={growth.collapseAll}>{t.growthCollapseAll}</button>
						</div>
						<GrowthTree
							tree={growth.tree}
							expanded={growth.expanded}
							fresh={growth.fresh}
							filter={treeFilter}
							selectedPath={null}
							onToggleDir={growth.toggleDir}
							onExpandLazy={growth.expandLazy}
							onOpenFile={(node: TreeNode) => onOpen(node.path, { from: node.from, lazy: node.lazy, kind: node.kind })}
							onReference={onReference}
							onOpenEditor={onOpenEditor}
							revealPath={reveal?.path ?? null}
							revealKey={reveal?.key}
							emptyText={t.viewerEmpty}
						/>
					</>
				)}

				{/* 快速打开 */}
				{quickOpen && (
					<div className="pw-quick" onMouseDown={(e) => e.target === e.currentTarget && setQuickOpen(false)}>
						<div className="pw-quick-box popover">
							<div className="flex items-center gap-2 px-2" style={{ height: 34 }}>
								<IconSearchOutline16 size={14} style={{ flex: "none", color: "var(--dsw-label-caption)" }} />
								<input
									ref={quickInputRef}
									value={quickQuery}
									onChange={(e) => {
										setQuickQuery(e.target.value);
										setQuickIndex(0);
									}}
									placeholder={t.viewerQuickOpen}
									className="min-w-0 flex-1 bg-transparent"
									style={{ fontSize: 13 }}
									onKeyDown={(e) => {
										if (e.key === "ArrowDown") {
											e.preventDefault();
											setQuickIndex(Math.min(Math.max(0, quickMatches.length - 1), selectedQuickIndex + 1));
										} else if (e.key === "ArrowUp") {
											e.preventDefault();
											setQuickIndex(Math.max(0, selectedQuickIndex - 1));
										} else if (e.key === "Enter") {
											e.preventDefault();
											const p = quickMatches[selectedQuickIndex];
											if (p) {
												onOpen(p);
												setQuickOpen(false);
											}
										}
									}}
								/>
							</div>
							<div className="pw-quick-list">
								{workspaceFiles.status === "loading" || workspaceFiles.status === "idle" ? <div role="status" className="px-2.5 py-2" style={{ fontSize: 12.5 }}>{t.panelLoading}</div> : null}
								{workspaceFiles.error ? <div role="alert" className="px-2.5 py-2" style={{ fontSize: 12.5, color: "var(--dsw-danger)" }}>{workspaceFiles.error}</div> : null}
								{workspaceFiles.truncated ? <div role="status" className="px-2.5 py-2" style={{ fontSize: 12.5 }}>{t.mentionTruncated}</div> : null}
								{quickMatches.length === 0 && workspaceFiles.status === "ready" ? (
									<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "8px 10px" }}>{t.viewerQuickOpenEmpty}</div>
								) : (
									quickMatches.map((p, i) => (
										<button
											key={p}
											type="button"
											className="pw-quick-item"
											data-active={i === selectedQuickIndex}
											onMouseEnter={() => setQuickIndex(i)}
											onClick={() => {
												onOpen(p);
												setQuickOpen(false);
											}}
										>
											<img className="pw-tree-icon" src={fileIconSrc(p.split("/").pop() ?? p)} alt="" />
											<span className="truncate">{p.split("/").pop()}</span>
											<span className="min-w-0 truncate" style={{ color: "var(--dsw-label-caption)", fontSize: 11.5 }}>{p}</span>
										</button>
									))
								)}
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
