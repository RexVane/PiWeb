"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


/**
 * 文件查看器：点击项目树里的文件弹出，80vw × 80vh 居中，右上全屏 / 关闭。
 * 页签行照 dsh：首个页签「文件」是同一棵项目树，每个打开的文件一个页签（可关），「+」模糊打开。
 * 文件页签：面包屑 + 模式（变更 / 内容 / 渲染）+ 折叠未改动 + 上一处 / 下一处 + 引用 / 编辑器打开。
 * 「变更」= 整文件行内 diff（FullDiff）；「内容」= 所选步的全文（被删文件显示删除前）；「渲染」= Markdown。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownBlock } from "@/components/MarkdownBlock";
import { MarkdownActionsProvider } from "@/components/chat/markdown-actions";
import { diffStats, parseUnifiedDiff, type DiffLine } from "@/components/DiffView";
import { FullDiff, type DiffHunkAnchor, type DiffLayout, type FullDiffHandle } from "@/components/FullDiff";
import { GrowthTree } from "@/components/GrowthTree";
import { IconAtOutline16, IconChevronDown14, IconChevronUp14, IconCloseOutline14, IconFileOutline16, IconPlusOutline16, IconSearchOutline16, IconRefreshOutline14 } from "@/components/icons";
import type { GrowthApi } from "@/hooks/useGrowth";
import { useI18n } from "@/i18n";
import { fileIconSrc } from "@/lib/file-icons";
import { fmtBytes } from "@/lib/format";
import { fuzzyScore, type TreeNode } from "@/lib/growth-tree";
import type { ViewerOpenOptions, ViewerState } from "@/hooks/useFileViewer";
import { useWorkspaceFiles } from "@/hooks/useWorkspaceFiles";
import { highlightCode, languageForPath } from "@/lib/highlight";
import { markdownDocumentImageUrl, resolveMarkdownDocumentPath } from "@/lib/chat/file-path";
import { useDialog } from "@/hooks/useDialog";
import { copyText } from "@/lib/clipboard";
import { IconCopyOutline16, IconDownloadOutline16 } from "@/components/icons";
import type { FilePreview } from "@/lib/files-service";

type Mode = "diff" | "content" | "render";
type SnapshotPreview = FilePreview & { contentOmitted?: boolean };
type ReadError = Error & { status?: number; code?: string };

function canTryAnotherSource(error: unknown): boolean {
	const status = (error as ReadError).status;
	return status === undefined || status === 404 || status >= 500;
}

interface CacheEntry { promise: Promise<unknown>; bytes: number; expires: number }
const fetchCache = new Map<string, CacheEntry>();
const CACHE_BYTES = 8 * 1024 * 1024;
const CACHE_ENTRIES = 32;
const CACHE_TTL_MS = 60_000;
let cachedBytes = 0;

function forgetCached(url: string): void {
	const entry = fetchCache.get(url);
	if (entry) cachedBytes -= entry.bytes;
	fetchCache.delete(url);
}
function trimCache(): void {
	for (const [url, entry] of fetchCache) if (entry.expires <= Date.now()) forgetCached(url);
	while (fetchCache.size > CACHE_ENTRIES || cachedBytes > CACHE_BYTES) {
		const oldest = fetchCache.keys().next().value;
		if (oldest === undefined) break;
		forgetCached(oldest);
	}
}
async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	const r = await fetch(url, signal ? { signal } : undefined);
	const j = await r.json();
	if (!r.ok || !j.success) {
		const err = new Error(j.error || `request failed (${r.status})`) as ReadError;
		err.status = r.status;
		err.code = j.errorCode;
		throw err;
	}
	return j.data as T;
}

function cachedJson<T>(url: string): Promise<T> {
	trimCache();
	const cached = fetchCache.get(url);
	if (cached) {
		fetchCache.delete(url);
		fetchCache.set(url, cached);
		return cached.promise as Promise<T>;
	}
	const entry: CacheEntry = { promise: Promise.resolve(), bytes: url.length * 2, expires: Date.now() + CACHE_TTL_MS };
	entry.promise = requestJson<T>(url).then((data) => {
		if (fetchCache.get(url) === entry) {
			// UTF-16 size conservatively bounds retained JSON strings, including ASCII.
			cachedBytes -= entry.bytes;
			entry.bytes += JSON.stringify(data).length * 2;
			cachedBytes += entry.bytes;
			trimCache();
		}
		return data;
	}, (error) => {
		if (fetchCache.get(url) === entry) forgetCached(url);
		throw error;
	});
	fetchCache.set(url, entry);
	cachedBytes += entry.bytes;
	trimCache();
	return entry.promise as Promise<T>;
}

function refreshCachedFile(cwd: string, path: string): void {
	for (const url of fetchCache.keys()) {
		const query = new URL(url, "http://piweb.local").searchParams;
		if (query.get("cwd") === cwd && query.get("path") === path) forgetCached(url);
	}
}

/** 文件夹预览：一页目录条目（分页；后端已按 .gitignore 过滤） */
interface DirEntry { name: string; kind: "dir" | "file"; size?: number }
interface DirPage { dir: string; entries: DirEntry[]; nextOffset: number | null; truncated: boolean }

interface Loaded {
	key: string;
	diff: DiffLine[] | null;
	patch: string | null;
	content: string | null;
	binary: boolean;
	truncated: boolean;
	encodingUnsupported?: boolean;
	notice: "deleted" | "historical" | "missing" | "omitted" | "omittedDisk" | "revisionDisk" | "patchUnavailable" | "disk" | "nochange" | "metadata" | null;
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
	gitRefreshKey = 0,
	onClose,
	onSelectTab,
	onCloseTab,
	onOpen,
	onOpenContent,
	onReference,
	onOpenEditor,
	onGitMutated,
}: {
	state: ViewerState;
	growth: GrowthApi;
	cwd: string;
	gitRefreshKey?: number;
	onClose: () => void;
	onSelectTab: (path: string | null) => void;
	onCloseTab: (path: string) => void;
	onOpen: (path: string, opts?: ViewerOpenOptions) => void;
	onOpenContent?: (path: string, content: string, sourcePath?: string) => void;
	onReference?: (path: string) => void;
	onOpenEditor?: (path: string) => void;
	onGitMutated?: () => void;
}) {
	const { t } = useI18n();
	const [refreshKey, setRefreshKey] = useState(0);
	const [fullscreen, setFullscreen] = useState(false);
	const [mode, setMode] = useState<Mode>("diff");
	const [diffLayout, setDiffLayout] = useState<DiffLayout>("split");
	const [modeTouched, setModeTouched] = useState(false);
	const [folded, setFolded] = useState(true);
	const [busyHunk, setBusyHunk] = useState<number | null>(null);
	const [busyFileAction, setBusyFileAction] = useState(false);
	const [quickOpen, setQuickOpen] = useState(false);
	const [quickQuery, setQuickQuery] = useState("");
	const [quickIndex, setQuickIndex] = useState(0);
	const openQuickSearch = useCallback((query = "") => {
		setQuickQuery(query);
		setQuickIndex(0);
		setQuickOpen(true);
	}, []);
	const workspaceFiles = useWorkspaceFiles(cwd, state.open && quickOpen);
	const [linkError, setLinkError] = useState<string | null>(null);
	const [treeFilter, setTreeFilter] = useState("");
	const [reveal, setReveal] = useState<{ path: string; key: number } | null>(null);
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [copyStatus, setCopyStatus] = useState<{ key: string | null; ok: boolean } | null>(null);
	const [dirPage, setDirPage] = useState<(DirPage & { key: string; error?: string }) | null>(null);
	const diffRef = useRef<FullDiffHandle>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const quickDialogRef = useRef<HTMLDivElement>(null);
	const quickInputRef = useRef<HTMLInputElement>(null);
	const quickComposingRef = useRef(false);
	useDialog({ open: state.open, onClose, ref: rootRef });
	useDialog({ open: state.open && quickOpen, onClose: () => setQuickOpen(false), ref: quickDialogRef });

	const activeTab = state.tabs.find((tab) => tab.path === state.active) ?? null;
	const change = useMemo(() => (activeTab ? growth.changes.find((c) => c.path === activeTab.path) ?? null : null), [activeTab, growth.changes]);
	const isMarkdown = Boolean(activeTab && /\.(md|mdx|markdown)$/i.test(activeTab.path));
	const range = growth.range;
	const gitKeyPart = activeTab?.git ? `${activeTab.git.mode}:${activeTab.git.hash ?? ""}:${gitRefreshKey}` : "";
	const contentKey = activeTab ? `${cwd}|${activeTab.path}|${mode}|${gitKeyPart}|${range?.from ?? ""}|${range?.to ?? ""}|${change?.status ?? ""}|${refreshKey}` : null;

	// 切页签：模式按是否有改动自动选，用户手动切过才保留
	useEffect(() => {
		setModeTouched(false);
		setDirFallback(null);
		setLinkError(null);
	}, [state.active, activeTab?.git?.mode, activeTab?.git?.hash, cwd]);
	useEffect(() => {
		if (modeTouched || !activeTab) return;
		setMode(activeTab.kind !== "upload" && (activeTab.git || (change && !activeTab.lazy)) ? "diff" : isMarkdown ? "render" : "content");
	}, [activeTab, change, isMarkdown, modeTouched]);

	/** A file link may point at a directory. List it only when the file API identifies it as one. */
	const [dirFallback, setDirFallback] = useState<string | null>(null);
	const dirPath = activeTab?.kind === "dir" ? activeTab.path : dirFallback;
	const isDir = Boolean(dirPath);
	// @src/ 这类带尾斜杠的引用：列目录时去掉
	const dirRel = dirPath ? dirPath.replace(/\/+$/, "") : null;
	const dirKey = dirRel !== null && cwd ? `dir|${cwd}|${dirRel}|${refreshKey}` : null;
	// 只认当前目录的那一页：从一个文件夹页签切到另一个时，上一个目录的条目不能在新请求回来前冒充新目录
	// （点上去会拼出不存在的路径），「加载更多」也不能接着上一个目录的偏移拉
	const page = dirPage && dirPage.key === dirKey ? dirPage : null;
	// 文件夹：列目录（分页，后端已按 .gitignore 过滤），不读文件内容
	useEffect(() => {
		if (!state.open || dirRel === null || !cwd || !dirKey) {
			setDirPage(null);
			return;
		}
		let alive = true;
		const controller = new AbortController();
		setDirPage(null);
		void (async () => {
			try {
				const data = await requestJson<DirPage>(`/api/files?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(dirRel)}&offset=0`, controller.signal);
				if (alive) setDirPage({ key: dirKey, ...data });
			} catch (error) {
				if (alive) setDirPage({ key: dirKey, dir: dirRel, entries: [], nextOffset: null, truncated: false, error: error instanceof Error ? error.message : t.viewerLoadFailed });
			}
		})();
		return () => {
			alive = false;
			controller.abort();
		};
	}, [state.open, dirRel, dirKey, cwd, refreshKey, t.viewerLoadFailed]);

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
		if (!state.open || !activeTab || activeTab.kind === "dir" || !contentKey) {
			setLoaded(null);
			return;
		}
		const tab = activeTab;
		const key = contentKey;
		setLoaded(null);
		const controller = new AbortController();
		let alive = true;
		const done = (partial: Partial<Loaded>) => {
			if (alive) setLoaded({ key, diff: null, patch: null, content: null, binary: false, truncated: false, notice: null, error: null, ...partial });
		};
		// 静态内容页签（技能文档等）：调用方已带内容，不读磁盘
		if (tab.staticContent !== undefined) {
			done({ content: tab.staticContent });
			return () => {
				alive = false;
			};
		}
		// 输入框里上传的附件不在工作区内：走只读的 uploads 预览接口
		if (tab.kind === "upload") {
			void (async () => {
				try {
					const data = await requestJson<FilePreview>(`/api/files?upload=1&path=${encodeURIComponent(tab.path)}`, controller.signal);
					done({ content: data.content, binary: data.binary, truncated: data.truncated, encodingUnsupported: data.encodingUnsupported, notice: null });
				} catch (error) {
					if (!alive) return;
					done({ error: error instanceof Error ? error.message : t.viewerLoadFailed });
				}
			})();
			return () => {
				alive = false;
				controller.abort();
			};
		}
		if (!cwd) {
			setLoaded(null);
			return;
		}
		const q = `cwd=${encodeURIComponent(cwd)}`;
		const diskContent = async (notice: Loaded["notice"], snapshotError?: unknown) => {
			try {
				const data = await requestJson<FilePreview>(`/api/files?read=1&${q}&path=${encodeURIComponent(tab.path)}`, controller.signal);
				done({ content: data.content, binary: data.binary, truncated: data.truncated, encodingUnsupported: data.encodingUnsupported, notice });
			} catch (error) {
				const failure = error as ReadError;
				if (failure.code === "IS_DIRECTORY" || (failure.status === 400 && failure.message === "not a file")) {
					if (alive) setDirFallback(tab.path);
					done({ notice: null });
				} else if (failure.status === 404 && (!failure.code || failure.code === "FILE_NOT_FOUND" || failure.code === "ENOENT")) {
					if (snapshotError) throw snapshotError;
					done({ notice: notice === "omittedDisk" ? "omitted" : "missing" });
				} else throw error;
			}
		};
		const readSnapshot = (tree: string) => cachedJson<SnapshotPreview>(
			`/api/growth?${q}&tree=${encodeURIComponent(tree)}&path=${encodeURIComponent(tab.path)}&content=1`,
		);
		const snapshotContent = async (tree: string, notice: Loaded["notice"]) => {
			let data: SnapshotPreview;
			try {
				data = await readSnapshot(tree);
			} catch (error) {
				if (!alive) return;
				if (!canTryAnotherSource(error)) throw error;
				if ((error as ReadError).status !== 404) return diskContent("revisionDisk", error);
				// A deleted or renamed file may still have a readable version in an earlier round.
				const upto = growth.selected ? growth.rounds.findIndex((round) => round.commit === growth.selected!.commit) : growth.rounds.length - 1;
				const prior = growth.rounds.slice(0, upto + 1).reverse().find((round) =>
					round.changes.some((item) => item.path === tab.path || item.from === tab.path),
				);
				const priorTree = prior?.changes.some((item) => (item.status === "D" && item.path === tab.path) || (item.status === "R" && item.from === tab.path))
					? prior.parentTree : prior?.tree;
				if (!priorTree || priorTree === tree) return diskContent("disk");
				try {
					data = await readSnapshot(priorTree);
					notice = "historical";
				} catch (priorError) {
					if (!alive) return;
					if (!canTryAnotherSource(priorError)) throw priorError;
					return (priorError as ReadError).status === 404 ? diskContent("disk") : diskContent("revisionDisk", priorError);
				}
			}
			if (!alive) return;
			if (data.contentOmitted) return diskContent("omittedDisk");
			done({ content: data.content, binary: data.binary, truncated: data.truncated, encodingUnsupported: data.encodingUnsupported, notice });
		};
		const gitContent = async (notice: Loaded["notice"]) => {
			if (tab.git?.mode !== "commit" && tab.git?.mode !== "staged") return diskContent(notice);
			const rev = tab.git.mode === "commit" ? (tab.git.hash ?? "HEAD") : "INDEX";
			try {
				const data = await requestJson<FilePreview>(`/api/git?${q}&cat=${encodeURIComponent(tab.path)}&rev=${encodeURIComponent(rev)}`, controller.signal);
				done({ content: data.content, binary: data.binary, truncated: data.truncated, encodingUnsupported: data.encodingUnsupported, notice });
			} catch (error) {
				if (!alive) return;
				if (!canTryAnotherSource(error)) throw error;
				return diskContent("revisionDisk", (error as ReadError).status === 404 ? undefined : error);
			}
		};
		void (async () => {
			try {
				if (tab.sourcePath !== undefined) {
					const response = await fetch("/api/prompts", {
						method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
						body: JSON.stringify({ action: "read", cwd, filePath: tab.path, sourcePath: tab.sourcePath }),
					});
					const payload = await response.json();
					if (!response.ok || !payload.success) throw new Error(payload.error || t.viewerLoadFailed);
					done({ content: payload.data.content });
					return;
				}
				if (tab.git) {
					if (mode === "diff") {
						const gitUrl = `/api/git?${q}&diff=${encodeURIComponent(tab.path)}&mode=${encodeURIComponent(tab.git.mode)}&full=1${tab.git.hash ? `&hash=${encodeURIComponent(tab.git.hash)}` : ""}${tab.from ? `&from=${encodeURIComponent(tab.from)}` : ""}`;
						let data: { patch: string; binary: boolean; truncated: boolean };
						try {
							data = await requestJson(gitUrl, controller.signal);
						} catch (error) {
							if (!alive) return;
							if (!canTryAnotherSource(error)) throw error;
							await gitContent("patchUnavailable");
							return;
						}
						if (data.binary) {
							done({ binary: true });
							return;
						}
						const lines = parseUnifiedDiff(data.patch);
						if (!lines) {
							done({ notice: "nochange" });
							return;
						}
						done({ diff: lines, patch: data.patch, truncated: data.truncated, notice: null });
						return;
					}
					await gitContent(null);
					return;
				}
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
					let data: { patch: string; binary: boolean; truncated: boolean; contentOmitted?: boolean };
					try {
						data = await cachedJson(`/api/growth?${q}&from=${range.from}&to=${range.to}&path=${encodeURIComponent(tab.path)}${tab.from ?? change.from ? `&renamedFrom=${encodeURIComponent(tab.from ?? change.from ?? "")}` : ""}`);
					} catch (error) {
						if (!canTryAnotherSource(error)) throw error;
						await snapshotContent(change.status === "D" ? range.from : range.to, "patchUnavailable");
						return;
					}
					if (data.contentOmitted) {
						await snapshotContent(change.status === "D" ? range.from : range.to, "omitted");
						return;
					}
					if (data.binary) {
						done({ binary: true });
						return;
					}
					const lines = parseUnifiedDiff(data.patch);
					if (!lines) {
						await snapshotContent(change.status === "D" ? range.from : range.to, "metadata");
						return;
					}
					done({ diff: lines, patch: data.patch, truncated: data.truncated, notice: change.status === "D" ? "deleted" : null });
					return;
				}
				await snapshotContent(change?.status === "D" ? range.from : range.to, change?.status === "D" ? "historical" : null);
			} catch (error) {
				done({ error: error instanceof Error ? error.message : t.viewerLoadFailed });
			}
		})();
		return () => {
			alive = false;
			controller.abort();
		};
	}, [state.open, activeTab, contentKey, cwd, mode, range, change, growth.rounds, growth.selected, refreshKey, t.viewerLoadFailed]);

	// 键盘：Esc 关（先关快速打开）、Ctrl/⌘+W 关页签、Ctrl/⌘+P 快速打开、[ ] 上一处下一处
	useEffect(() => {
		if (!state.open) return;
		const h = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
			const target = e.target as HTMLElement | null;
			if (target && !rootRef.current?.contains(target)) return;
			const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
			const mod = e.ctrlKey || e.metaKey;
			if (mod && e.key.toLowerCase() === "w") {
				e.preventDefault();
				if (state.active) onCloseTab(state.active);
				else onClose();
				return;
			}
			if (mod && e.key.toLowerCase() === "p") {
				e.preventDefault();
				openQuickSearch();
				return;
			}
			if (!typing && !mod && mode === "diff") {
				if (e.key === "]") diffRef.current?.nextChange();
				else if (e.key === "[") diffRef.current?.prevChange();
			}
		};
		document.addEventListener("keydown", h);
		return () => document.removeEventListener("keydown", h);
	}, [state.open, state.active, mode, onClose, onCloseTab, openQuickSearch]);

	useEffect(() => {
		if (!quickOpen) return;
		const timer = setTimeout(() => quickInputRef.current?.focus(), 0);
		return () => clearTimeout(timer);
	}, [quickOpen]);
	useEffect(() => {
		if (!state.open) setQuickOpen(false);
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
			// MarkdownActions already decoded the path and removed the link's query/fragment.
			const target = resolveMarkdownDocumentPath(activeTab.path, href.split("/").map(encodeURIComponent).join("/"));
			if ((activeTab.staticContent === undefined && activeTab.sourcePath === undefined) || !onOpenContent) {
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
	const toggleGitHunk = useCallback(async (blockIndex: number, anchor: DiffHunkAnchor) => {
		if (!activeTab?.git || activeTab.git.mode === "commit" || busyHunk !== null || busyFileAction) return;
		const action = activeTab.git.mode === "staged" ? "unstageHunk" : "stageHunk";
		setBusyHunk(blockIndex);
		setLinkError(null);
		try {
			const response = await fetch("/api/git", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, cwd, path: activeTab.path, mode: activeTab.git.mode, blockIndex, anchor }),
			});
			const payload = await response.json();
			if (!response.ok || !payload.success) throw new Error(payload.error || t.viewerLoadFailed);
			const nextEntry = (payload.data?.info?.files as Array<{ path: string; from?: string; kind: string }> | undefined)?.find((f) => f.path === activeTab.path);
			if (action === "unstageHunk" && nextEntry?.kind === "untracked") {
				onOpen(activeTab.path, {
					...(nextEntry.from ? { from: nextEntry.from } : {}),
					git: { mode: "untracked", label: t.gitUntracked },
				});
			}
			setRefreshKey((k) => k + 1);
			onGitMutated?.();
		} catch (error) {
			setLinkError(error instanceof Error ? error.message : t.viewerLoadFailed);
			setRefreshKey((k) => k + 1);
		} finally {
			setBusyHunk(null);
		}
	}, [activeTab, busyFileAction, busyHunk, cwd, onGitMutated, onOpen, t.gitUntracked, t.viewerLoadFailed]);
	const mutateActiveGitFile = useCallback(async () => {
		if (!activeTab?.git || activeTab.git.mode === "commit" || busyFileAction || busyHunk !== null) return;
		const isStaged = activeTab.git.mode === "staged";
		const action = isStaged ? "unstage" : "stage";
		setBusyFileAction(true);
		setLinkError(null);
		try {
			const response = await fetch("/api/git", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, cwd, paths: activeTab.from ? [activeTab.from, activeTab.path] : [activeTab.path] }),
			});
			const payload = await response.json();
			if (!response.ok || !payload.success) throw new Error(payload.error || t.viewerLoadFailed);
			const nextEntry = (payload.data?.info?.files as Array<{ path: string; from?: string; kind: string }> | undefined)?.find((f) => f.path === activeTab.path);
			const nextMode = isStaged ? (nextEntry?.kind === "untracked" ? "untracked" : "worktree") : "staged";
			const nextLabel = nextMode === "staged" ? t.gitStagedDiff : nextMode === "untracked" ? t.gitUntracked : t.gitWorktreeDiff;
			onOpen(activeTab.path, {
				...(nextEntry?.from ? { from: nextEntry.from } : {}),
				git: { mode: nextMode, label: nextLabel },
			});
			setRefreshKey((k) => k + 1);
			onGitMutated?.();
		} catch (error) {
			setLinkError(error instanceof Error ? error.message : t.viewerLoadFailed);
		} finally {
			setBusyFileAction(false);
		}
	}, [activeTab, busyFileAction, busyHunk, cwd, onGitMutated, onOpen, t.gitStagedDiff, t.gitUntracked, t.gitWorktreeDiff, t.viewerLoadFailed]);

	if (!state.open) return null;

	const isUpload = activeTab?.kind === "upload";
	const segments = activeTab
		? (isUpload ? [activeTab.path.split(/[/\\]/).pop() || activeTab.path] : activeTab.path.split("/"))
		: [];
	const goCrumb = (i: number) => {
		const dir = segments.slice(0, i + 1).join("/");
		growth.revealPath(dir);
		setReveal({ path: dir, key: Date.now() });
		onSelectTab(null);
	};
	const currentLoaded = loaded?.key === contentKey ? loaded : null;
	const roundName = growth.selected ? (growth.selected.n ? t.growthRoundLabel.replace("{n}", String(growth.selected.n)) : t.growthKindUser) : "";
	const gitBadgeText = activeTab?.git
		? (activeTab.git.label ?? (activeTab.git.mode === "staged" ? t.gitStagedDiff : activeTab.git.mode === "untracked" ? t.gitUntracked : activeTab.git.mode === "commit" ? (activeTab.git.hash ?? t.gitCommitMode) : t.gitWorktreeDiff))
		: "";
	const gitStats = activeTab?.git && currentLoaded?.diff ? diffStats(currentLoaded.diff) : null;
	const stepBadge = activeTab?.git
		? `${gitBadgeText}${gitStats ? ` · +${gitStats.add} −${gitStats.del}` : ""}`
		: roundName
			? `${roundName}${change ? ` · +${change.add ?? 0} −${change.del ?? 0}` : ""}`
			: "";
	const isDiffMode = mode === "diff" && Boolean(currentLoaded?.diff);
	const diffPaneLabels = activeTab?.git
		? activeTab.git.mode === "staged"
			? { left: t.viewerDiffHead, right: t.viewerDiffStaged }
			: activeTab.git.mode === "untracked"
				? { left: "/dev/null", right: t.viewerDiffWorktree }
				: activeTab.git.mode === "commit"
					? { left: `${activeTab.git.hash ?? "commit"}^`, right: activeTab.git.hash ?? t.gitCommitMode }
					: { left: t.viewerDiffStaged, right: t.viewerDiffWorktree }
		: { left: t.viewerDiffBefore, right: t.viewerDiffAfter };
	const hunkAction = activeTab?.git && activeTab.git.mode !== "commit" && !activeTab.from && !currentLoaded?.truncated
		? {
			label: activeTab.git.mode === "staged" ? t.gitUnstageHunk : t.gitStageHunk,
			checked: activeTab.git.mode === "staged",
			busyBlock: busyHunk,
			disabled: busyFileAction,
			onToggle: (blockIndex: number, anchor: DiffHunkAnchor) => void toggleGitHunk(blockIndex, anchor),
		}
		: undefined;
	const copyLabel = currentLoaded?.patch ? (currentLoaded.truncated ? t.viewerCopyPatchPreview : t.viewerCopyPatch)
		: currentLoaded?.truncated ? t.viewerCopyPreview : t.viewerCopyAll;
	const copyCurrent = async () => {
		const value = currentLoaded?.patch ?? currentLoaded?.content;
		if (value === null || value === undefined) return;
		setCopyStatus({ key: contentKey, ok: await copyText(value) });
	};
	const noticeText = currentLoaded?.notice && {
		omitted: t.viewerOmitted, omittedDisk: t.viewerOmittedDisk, revisionDisk: t.viewerRevisionDisk, patchUnavailable: t.viewerPatchUnavailable,
		deleted: t.viewerDeleted, historical: t.viewerHistorical, missing: t.viewerMissing, disk: t.viewerNotInSnapshot,
		nochange: t.viewerNoChanges, metadata: t.viewerMetadataChanged,
	}[currentLoaded.notice];

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
					<button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={`${t.viewerQuickOpen} (Ctrl/⌘+P)`} onClick={() => openQuickSearch()}>
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
							{stepBadge && !isUpload && (Boolean(activeTab.git) || !activeTab.lazy) && (
								<span className="flex-none truncate" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)", maxWidth: 220 }}>
									{stepBadge}
								</span>
							)}
							{activeTab.git && activeTab.git.mode !== "commit" && !isDir && (
								<button
									type="button"
									className="pw-chip"
									disabled={busyFileAction || busyHunk !== null}
									onClick={() => void mutateActiveGitFile()}
								>
									{activeTab.git.mode === "staged" ? `− ${t.gitUnstage}` : `+ ${t.gitStage}`}
								</button>
							)}
							{(Boolean(activeTab.git) || (!activeTab.lazy && !isUpload)) && !isDir && (
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
							{!isDir && (activeTab.lazy || isUpload) && !activeTab.git && isMarkdown && (
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
									<span className="pw-seg" role="radiogroup" aria-label="Diff layout">
										{(["split", "inline"] as DiffLayout[]).map((layoutOption) => (
											<button
												key={layoutOption}
												type="button"
												role="radio"
												aria-checked={diffLayout === layoutOption}
												data-active={diffLayout === layoutOption}
												onClick={() => setDiffLayout(layoutOption)}
											>
												{layoutOption === "split" ? t.viewerDiffSplit : t.viewerDiffInline}
											</button>
										))}
									</span>
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
							{activeTab.staticContent === undefined && activeTab.kind !== "upload" && (
								<button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title={t.panelRefresh} aria-label={t.panelRefresh} onClick={() => {
									refreshCachedFile(cwd, activeTab.path);
									setRefreshKey((key) => key + 1);
								}}>
									<IconRefreshOutline14 size={12} />
								</button>
							)}
							{!isDir && <>
								<button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title={copyLabel} aria-label={copyLabel}
									disabled={!currentLoaded || currentLoaded.binary || currentLoaded.encodingUnsupported || (currentLoaded.content === null && currentLoaded.patch === null)} onClick={() => void copyCurrent()}>
									<IconCopyOutline16 size={13} />
								</button>
								{activeTab.staticContent === undefined && activeTab.sourcePath === undefined && activeTab.kind !== "upload" && <a className="icon-btn" style={{ width: 24, height: 24 }} download
									title={t.viewerDownloadCurrent} aria-label={t.viewerDownloadCurrent}
									href={`/api/files/download?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(activeTab.path)}`}>
									<IconDownloadOutline16 size={13} />
								</a>}
							</>}
							{onReference && !isUpload && (
								<button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title={t.fileReference} onClick={() => onReference(activeTab.path)}>
									<IconAtOutline16 size={13} />
								</button>
							)}
							{onOpenEditor && !isUpload && (
								<button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title={t.fileOpenEditor} onClick={() => onOpenEditor(activeTab.path)}>
									<IconFileOutline16 size={13} />
								</button>
							)}
						</div>

						{/* 正文 */}
						{copyStatus?.key === contentKey && <div role={copyStatus.ok ? "status" : "alert"} className="pw-viewer-notice">{copyStatus.ok ? t.updateCopied : t.copyFailed}</div>}
						{linkError && <div role="alert" className="px-4 py-2" style={{ color: "var(--dsw-danger)", fontSize: 12.5 }}>{linkError}</div>}
						{noticeText && (
							<div className="pw-viewer-notice" data-kind={currentLoaded?.notice}>
								{noticeText}
								{currentLoaded?.notice === "missing" && activeTab && (
									<button type="button" className="pw-chip ml-2" onClick={() => openQuickSearch(activeTab.path.split("/").at(-1))}>{t.viewerFindByName}</button>
								)}
							</div>
						)}
						{currentLoaded?.truncated && <div className="pw-viewer-notice" data-kind="warn">{currentLoaded.patch ? t.viewerPatchTruncated : t.filePreviewTruncated}</div>}
						{currentLoaded?.encodingUnsupported && <div role="status" className="pw-viewer-notice" data-kind="warn">{t.viewerEncodingUnsupported}</div>}
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
										<img className="pw-tree-icon" src={entry.kind === "dir" ? "/file-icons/folder.svg" : fileIconSrc(entry.name)} alt="" />
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
						) : !currentLoaded || currentLoaded.key !== contentKey ? (
							<div className="flex min-h-0 flex-1 items-center justify-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.panelLoading}</div>
						) : currentLoaded.error ? (
							<div className="flex min-h-0 flex-1 items-center justify-center" style={{ fontSize: 12.5, color: "var(--dsw-danger)" }}>{currentLoaded.error}</div>
						) : currentLoaded.binary ? (
							<div className="flex min-h-0 flex-1 items-center justify-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.fileBinary}</div>
						) : currentLoaded.encodingUnsupported ? null : currentLoaded.diff ? (
							<FullDiff
								lines={currentLoaded.diff}
								language={languageForPath(activeTab.path)}
								folded={folded}
								layout={diffLayout}
								leftLabel={diffPaneLabels.left}
								rightLabel={diffPaneLabels.right}
								hunkAction={hunkAction}
								handle={diffRef}
								initialChange
							/>
						) : mode === "render" && currentLoaded.content !== null ? (
							<div className="min-h-0 flex-1 overflow-auto px-6 py-4" style={{ fontSize: 14 }}>
								<MarkdownActionsProvider value={{
									allowDocumentParents: true,
									openFile: (href) => void openDocumentLink(href),
									resolveImage: (href) => markdownDocumentImageUrl(cwd, activeTab.path, href, activeTab.sourcePath ?? (activeTab.staticContent === undefined ? undefined : activeTab.path)),
								}}>
									<MarkdownBlock text={currentLoaded.content} />
								</MarkdownActionsProvider>
							</div>
						) : currentLoaded.content !== null ? (
							<CodeBlock content={currentLoaded.content} name={activeTab.path} />
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
							<button type="button" className="icon-btn" title={t.panelRefresh} aria-label={t.panelRefresh} onClick={() => void growth.refresh()}>
								<IconRefreshOutline14 size={12} />
							</button>
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
						<div ref={quickDialogRef} className="pw-quick-box popover" role="dialog" aria-modal="true" aria-label={t.viewerQuickOpen} tabIndex={-1}>
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
									onCompositionStart={() => { quickComposingRef.current = true; }}
									onCompositionEnd={() => { quickComposingRef.current = false; }}
									onKeyDown={(e) => {
										if (quickComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
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
								{workspaceFiles.warning ? <div role="status" className="px-2.5 py-2" style={{ fontSize: 12.5, color: "var(--dsw-warn)" }}>{t.mentionGitFallback}</div> : null}
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
