"use client";

/**
 * 文件面板（详情栏）：工作区目录浏览 + 文本预览（语法高亮 / Markdown 渲染）。
 * 与对话联动：引用到输入框、在编辑器打开、标出本会话被 pi 改过的文件、回合结束自动刷新。
 * 只读——不提供编辑与删除，浏览范围被 /api/files 钉死在工作区内。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";
import {
	IconChevronLeft14,
	IconCloseOutline14,
	IconEditOutline16,
	IconFileOutline16,
	IconFolderClose16,
	IconRefreshOutline14,
	IconSearchOutline16,
} from "@/components/icons";
import { useI18n } from "@/i18n";

interface FileEntry {
	name: string;
	kind: "dir" | "file";
	size?: number;
}

interface DirListing {
	dir: string;
	entries: FileEntry[];
	truncated: boolean;
}

interface FilePreview {
	path: string;
	binary: boolean;
	truncated: boolean;
	content: string;
}

/** 默认隐藏的“噪音目录”，一键可显示 */
const NOISE = new Set(["node_modules", ".git", ".next", ".next-dev", ".next-dev-webpack", ".next-dev-clean", "dist", "build", "out", ".venv", "venv", "__pycache__", ".cache", "target", ".turbo", ".pytest_cache", ".mypy_cache"]);
/** 超过此大小不做语法高亮（只显示纯文本） */
const HIGHLIGHT_MAX = 120 * 1024;

const EXT_LANG: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", jsonc: "json", css: "css", scss: "scss", less: "less",
	html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
	md: "markdown", mdx: "markdown", py: "python", rb: "ruby", go: "go", rs: "rust",
	java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
	sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psm1: "powershell",
	yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", env: "ini",
	sql: "sql", php: "php", swift: "swift", lua: "lua", r: "r", pl: "perl", diff: "diff", patch: "diff", makefile: "makefile",
};

/** 每个工作区记住上次浏览的目录 */
const lastDirByCwd = new Map<string, string>();

function fmtSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
	return `${bytes}B`;
}

function basename(p: string): string {
	return p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p;
}

function extOf(name: string): string {
	const lower = name.toLowerCase();
	if (lower === "makefile") return "makefile";
	const i = lower.lastIndexOf(".");
	return i >= 0 ? lower.slice(i + 1) : "";
}

/** 代码预览：行号栏 + 高亮正文（同一 line-height，横向可滚） */
function CodePreview({ content, name }: { content: string; name: string }) {
	const html = useMemo(() => {
		const lang = EXT_LANG[extOf(name)];
		if (content.length > HIGHLIGHT_MAX) return null;
		try {
			if (lang && hljs.getLanguage(lang)) return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
			if (content.length < 30 * 1024) return hljs.highlightAuto(content).value;
		} catch {
			/* fall through to plain */
		}
		return null;
	}, [content, name]);
	const lines = content.split("\n").length;
	const gutterWidth = `${String(lines).length + 1}ch`;
	return (
		<div className="flex overflow-x-auto rounded-xl" style={{ background: "var(--dsw-hover)", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: "17px" }}>
			<pre
				aria-hidden
				className="flex-none select-none py-2 pl-2 pr-2 text-right"
				style={{ width: gutterWidth, minWidth: gutterWidth, color: "var(--dsw-label-caption)", borderRight: "0.5px solid var(--dsw-border-l2)", margin: 0 }}
			>
				{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
			</pre>
			{html !== null ? (
				<pre className="hljs min-w-0 flex-1 py-2 pl-3 pr-3" style={{ margin: 0, background: "transparent", color: "var(--dsw-label-secondary)" }}>
					<code dangerouslySetInnerHTML={{ __html: html }} />
				</pre>
			) : (
				<pre className="min-w-0 flex-1 py-2 pl-3 pr-3" style={{ margin: 0, color: "var(--dsw-label-secondary)" }}>{content}</pre>
			)}
		</div>
	);
}

export function FilesPanel({
	cwd,
	onClose,
	refreshKey = 0,
	changedPaths,
	onReference,
	onOpenFile,
}: {
	cwd: string;
	onClose: () => void;
	/** 外部触发刷新（回合结束 / pi 改了文件） */
	refreshKey?: number;
	/** 本会话被 pi 修改过的文件（相对工作区、"/" 分隔） */
	changedPaths?: Set<string>;
	/** 把文件路径引用到输入框 */
	onReference?: (relPath: string) => void;
	/** 在本机编辑器打开 */
	onOpenFile?: (relPath: string) => void;
}) {
	const { t } = useI18n();
	const [dir, setDir] = useState(() => lastDirByCwd.get(cwd) ?? "");
	const [listing, setListing] = useState<DirListing | null>(null);
	const [preview, setPreview] = useState<FilePreview | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [filter, setFilter] = useState("");
	const [showNoise, setShowNoise] = useState(() => typeof window !== "undefined" && localStorage.getItem("piweb.files.showNoise") === "1");
	const [renderMd, setRenderMd] = useState(true);
	const filterRef = useRef<HTMLInputElement>(null);

	const load = useCallback(
		async (target: string, silent = false) => {
			if (!cwd) return;
			if (!silent) setLoading(true);
			setError("");
			try {
				const r = await fetch(`/api/files?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(target)}`);
				const j = await r.json();
				if (!j.success) throw new Error(j.error || "failed to list directory");
				const data = j.data as DirListing;
				setListing(data);
				const next = data.dir === "." ? "" : data.dir;
				setDir(next);
				lastDirByCwd.set(cwd, next);
			} catch (e) {
				setError(e instanceof Error ? e.message : "failed to list directory");
				// 记住的目录已不存在：回根
				if (target) void load("", silent);
			} finally {
				if (!silent) setLoading(false);
			}
		},
		[cwd],
	);

	useEffect(() => {
		setListing(null);
		setPreview(null);
		setFilter("");
		void load(lastDirByCwd.get(cwd) ?? "");
	}, [cwd, load]);

	const openFile = useCallback(
		async (rel: string, silent = false) => {
			if (!silent) setLoading(true);
			setError("");
			try {
				const r = await fetch(`/api/files?read=1&cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(rel)}`);
				const j = await r.json();
				if (!j.success) throw new Error(j.error || "failed to read file");
				setPreview(j.data as FilePreview);
			} catch (e) {
				setError(e instanceof Error ? e.message : "failed to read file");
			} finally {
				if (!silent) setLoading(false);
			}
		},
		[cwd],
	);

	// 外部刷新：静默重拉当前目录 / 当前预览
	useEffect(() => {
		if (refreshKey <= 0) return;
		if (preview) void openFile(preview.path, true);
		else void load(dir, true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refreshKey]);

	const toggleNoise = () => {
		const next = !showNoise;
		setShowNoise(next);
		localStorage.setItem("piweb.files.showNoise", next ? "1" : "0");
	};

	const segments = dir ? dir.split("/") : [];
	const rootName = basename(cwd) || cwd;
	const previewName = preview ? basename(preview.path) : "";
	const previewIsMd = preview ? /\.(md|mdx|markdown)$/i.test(preview.path) : false;
	const title = preview ? previewName : t.filesPanel;

	const needle = filter.trim().toLowerCase();
	const visible = useMemo(() => {
		if (!listing) return [];
		return listing.entries.filter((e) => (showNoise || !NOISE.has(e.name)) && (!needle || e.name.toLowerCase().includes(needle)));
	}, [listing, showNoise, needle]);
	const hiddenNoise = listing ? listing.entries.filter((e) => NOISE.has(e.name)).length : 0;
	const relOf = (name: string) => (dir ? `${dir}/${name}` : name);
	const isChanged = (rel: string) => Boolean(changedPaths?.has(rel));
	const dirHasChange = (name: string) => {
		if (!changedPaths?.size) return false;
		const prefix = `${relOf(name)}/`;
		for (const p of changedPaths) if (p.startsWith(prefix)) return true;
		return false;
	};

	return (
		<div className="flex h-full min-h-0 flex-col p-4">
			<div className="mb-3 flex items-center gap-2">
				{preview && (
					<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.filesBack} onClick={() => setPreview(null)}>
						<IconChevronLeft14 size={13} />
					</button>
				)}
				<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, fontWeight: 600 }} title={preview?.path}>
					{title}
				</span>
				{preview && previewIsMd && (
					<button
						type="button"
						className="rounded-md px-1.5 py-0.5"
						style={{ fontSize: 11, border: "0.5px solid var(--dsw-border-l3)", color: "var(--dsw-label-tertiary)" }}
						onClick={() => setRenderMd((v) => !v)}
					>
						{renderMd ? t.fileRawSource : t.fileRenderMarkdown}
					</button>
				)}
				{preview && onReference && (
					<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.fileReference} onClick={() => onReference(preview.path)}>
						<IconEditOutline16 size={13} />
					</button>
				)}
				{preview && onOpenFile && (
					<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.fileOpenEditor} onClick={() => onOpenFile(preview.path)}>
						<IconFileOutline16 size={13} />
					</button>
				)}
				<button
					className="icon-btn"
					style={{ width: 22, height: 22 }}
					title={t.panelRefresh}
					onClick={() => (preview ? void openFile(preview.path) : void load(dir))}
				>
					<IconRefreshOutline14 size={13} />
				</button>
				<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.close} onClick={onClose}>
					<IconCloseOutline14 size={13} />
				</button>
			</div>

			{!preview && (
				<>
					{/* 面包屑：工作区名 → 子目录，点击跳层 */}
					<div className="mb-2 flex flex-wrap items-center gap-0.5" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
						<button style={{ color: dir ? "var(--dsw-accent)" : "inherit", fontWeight: 500 }} onClick={() => void load("")} title={cwd}>
							{rootName}
						</button>
						{segments.map((seg, i) => (
							<span key={i} className="flex items-center gap-0.5">
								<span aria-hidden>/</span>
								<button style={{ color: i === segments.length - 1 ? "inherit" : "var(--dsw-accent)" }} onClick={() => void load(segments.slice(0, i + 1).join("/"))}>
									{seg}
								</button>
							</span>
						))}
					</div>
					{/* 过滤框 */}
					<div className="mb-2 flex items-center gap-2 rounded-lg px-2" style={{ background: "var(--dsw-hover)", height: 28 }}>
						<IconSearchOutline16 size={13} style={{ flex: "none", color: "var(--dsw-label-caption)" }} />
						<input
							ref={filterRef}
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder={t.filesFilter}
							className="min-w-0 flex-1"
							style={{ fontSize: 12 }}
							onKeyDown={(e) => {
								if (e.key === "Escape") setFilter("");
							}}
						/>
					</div>
				</>
			)}

			{error && (
				<div className="mb-2 rounded-xl px-3 py-2" style={{ fontSize: 12.5, background: "var(--dsw-danger)", color: "white" }} role="alert">
					{error}
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto">
				{loading && !listing && !preview && (
					<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "8px 2px" }}>{t.panelLoading}</div>
				)}
				{preview ? (
					preview.binary ? (
						<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "8px 2px" }}>{t.fileBinary}</div>
					) : (
						<>
							{preview.truncated && (
								<div className="mb-2 rounded-lg px-2 py-1" style={{ fontSize: 11.5, color: "var(--dsw-warn)", background: "var(--dsw-hover)" }}>
									{t.filePreviewTruncated}
								</div>
							)}
							{isChanged(preview.path) && (
								<div className="mb-2 flex items-center gap-1.5" style={{ fontSize: 11.5, color: "var(--dsw-accent)" }}>
									<span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: "var(--dsw-accent)", display: "inline-block" }} />
									{t.fileChangedByPi}
								</div>
							)}
							{previewIsMd && renderMd ? (
								<div className="md rounded-xl px-3 py-2" style={{ fontSize: 13, background: "var(--dsw-hover)" }}>
									<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}>
										{preview.content}
									</ReactMarkdown>
								</div>
							) : (
								<CodePreview content={preview.content} name={previewName} />
							)}
						</>
					)
				) : (
					!loading &&
					listing &&
					(visible.length === 0 ? (
						<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "8px 2px" }}>{t.filesEmpty}</div>
					) : (
						<div className="flex flex-col">
							{visible.map((entry) => {
								const rel = relOf(entry.name);
								const changed = entry.kind === "file" ? isChanged(rel) : dirHasChange(entry.name);
								return (
									<div
										key={entry.name}
										className="group/row flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors"
										style={{ fontSize: 12.5 }}
										onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
										onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
									>
										<button
											type="button"
											className="flex min-w-0 flex-1 items-center gap-2 text-left"
											onClick={() => (entry.kind === "dir" ? void load(rel) : void openFile(rel))}
											title={rel}
										>
											{entry.kind === "dir" ? (
												<IconFolderClose16 size={14} style={{ flex: "none", color: "var(--dsw-label-tertiary)" }} />
											) : (
												<IconFileOutline16 size={14} style={{ flex: "none", color: "var(--dsw-label-tertiary)" }} />
											)}
											<span className="min-w-0 flex-1 truncate" style={{ color: NOISE.has(entry.name) ? "var(--dsw-label-caption)" : "var(--dsw-label-primary)" }}>
												{entry.name}
											</span>
											{changed && (
												<span
													aria-label={t.fileChangedByPi}
													title={t.fileChangedByPi}
													style={{ width: 6, height: 6, borderRadius: 999, background: "var(--dsw-accent)", flex: "none", display: "inline-block" }}
												/>
											)}
										</button>
										{entry.kind === "file" && (
											<span className="flex flex-none items-center gap-0.5 opacity-0 group-hover/row:opacity-100">
												{onReference && (
													<button className="icon-btn" style={{ width: 20, height: 20 }} title={t.fileReference} onClick={() => onReference(rel)}>
														<IconEditOutline16 size={12} />
													</button>
												)}
												{onOpenFile && (
													<button className="icon-btn" style={{ width: 20, height: 20 }} title={t.fileOpenEditor} onClick={() => onOpenFile(rel)}>
														<IconFileOutline16 size={12} />
													</button>
												)}
											</span>
										)}
										{entry.kind === "file" && entry.size !== undefined && (
											<span className="flex-none group-hover/row:hidden" style={{ fontSize: 11, color: "var(--dsw-label-caption)" }}>{fmtSize(entry.size)}</span>
										)}
									</div>
								);
							})}
							{(listing.truncated || hiddenNoise > 0) && (
								<div className="flex items-center gap-3" style={{ fontSize: 11, color: "var(--dsw-label-caption)", padding: "6px 2px" }}>
									{listing.truncated && <span>{t.entriesTruncated}</span>}
									{hiddenNoise > 0 && (
										<button type="button" style={{ color: "var(--dsw-accent)" }} onClick={toggleNoise}>
											{showNoise ? t.filesHideNoise : `${t.filesShowAll} (${hiddenNoise})`}
										</button>
									)}
								</div>
							)}
						</div>
					))
				)}
			</div>
		</div>
	);
}
