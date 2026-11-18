"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";

/**
 * Git 工作台面板（右侧抽屉）：
 * - 分支 / 上游 / ↑ahead ↓behind + 拉取 / 推送；
 * - 紧凑 Commit 提交区（支持提交 / 提交并推送，Ctrl/⌘+Enter 快捷提交）；
 * - 冲突 / 暂存区 / 工作区 文件分组 + 分组/单文件 + / - 暂存操作；
 * - 点文件优先交给 FileViewer 居中大窗打开并排曲线 Diff（独立渲染回退到内联 DiffView）；
 * - 最近提交点开就地展开改动文件清单，点文件进 FileViewer 看提交差异。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffView, diffStats, parseUnifiedDiff } from "@/components/DiffView";
import { languageForPath } from "@/lib/highlight";
import { IconChevronLeft14, IconCloseOutline14, IconCopyOutline16, IconFileOutline16, IconGitOutline16, IconRefreshOutline14 } from "@/components/icons";
import { useI18n } from "@/i18n";
import { copyText } from "@/lib/clipboard";

interface GitFileEntry {
	path: string;
	from?: string;
	indexStatus: string;
	workStatus: string;
	kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";
}

interface GitCommit {
	hash: string;
	subject: string;
	author: string;
	relative: string;
}

interface GitCommitFile {
	path: string;
	from?: string;
	status: "A" | "M" | "D" | "R" | "C";
	add: number;
	del: number;
	binary: boolean;
}

interface GitInfo {
	available: boolean;
	isRepo: boolean;
	root: string | null;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	detached: boolean;
	files: GitFileEntry[];
	commits: GitCommit[];
	statusError?: string;
}

interface GithubIdentity {
	login: string;
	name?: string;
	avatar?: string;
	url?: string;
	repo?: string;
}

interface DiffResult {
	patch: string;
	truncated: boolean;
	binary: boolean;
	stats?: { add: number; del: number };
	title?: string;
}

export interface GitDiffOpenTarget {
	path: string;
	from?: string;
	mode: "worktree" | "staged" | "untracked" | "commit";
	hash?: string;
	label?: string;
}

type View = { kind: "file"; path: string; from?: string; mode: "staged" | "worktree" | "untracked"; label: string } | { kind: "commit"; hash: string };

const KIND_COLOR: Record<GitFileEntry["kind"], string> = {
	modified: "var(--dsw-warn)",
	added: "var(--dsw-success)",
	deleted: "var(--dsw-danger)",
	renamed: "var(--dsw-accent)",
	untracked: "var(--dsw-label-caption)",
	conflict: "var(--dsw-danger)",
};

const COMMIT_STATUS_COLOR: Record<GitCommitFile["status"], string> = {
	A: "var(--dsw-success)",
	M: "var(--dsw-warn)",
	D: "var(--dsw-danger)",
	R: "var(--dsw-accent)",
	C: "var(--dsw-accent)",
};

export function GitPanel({
	cwd,
	onClose,
	refreshKey = 0,
	onOpenFile,
	onOpenDiff,
	onMutated,
}: {
	cwd: string;
	onClose: () => void;
	/** 外部触发刷新（回合结束 / pi 改了文件 / 查看器按块暂存） */
	refreshKey?: number;
	/** 在本机编辑器打开（绝对路径） */
	onOpenFile?: (absPath: string) => void;
	/** 在居中 FileViewer 打开并排差异视图 */
	onOpenDiff?: (target: GitDiffOpenTarget) => void;
	/** Git 状态变更通知上层刷新关联面板 */
	onMutated?: () => void;
}) {
	const { t } = useI18n();
	const [info, setInfo] = useState<GitInfo | null>(null);
	const [identity, setIdentity] = useState<GithubIdentity | null>(null);
	const [loading, setLoading] = useState(false);
	const [statusError, setStatusError] = useState("");
	const [actionError, setActionError] = useState("");
	const [actionNotice, setActionNotice] = useState("");
	const [busyAction, setBusyAction] = useState<string | null>(null);
	const [commitMessage, setCommitMessage] = useState("");
	const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
	const [commitFiles, setCommitFiles] = useState<Record<string, GitCommitFile[]>>({});
	const [commitLoading, setCommitLoading] = useState<string | null>(null);

	// 仅在独立渲染（未传 onOpenDiff）时保留的内联差异子页状态
	const [diffError, setDiffError] = useState("");
	const [view, setView] = useState<View | null>(null);
	const [diff, setDiff] = useState<DiffResult | null>(null);
	const [copiedDiff, setCopiedDiff] = useState<DiffResult | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);

	const statusRequest = useRef<{ version: number; controller?: AbortController }>({ version: 0 });
	const diffRequest = useRef<{ version: number; controller?: AbortController }>({ version: 0 });
	const commitRequest = useRef<{ version: number; controller?: AbortController }>({ version: 0 });

	const load = useCallback(async () => {
		statusRequest.current.controller?.abort();
		const controller = new AbortController();
		const version = ++statusRequest.current.version;
		statusRequest.current.controller = controller;
		const isCurrent = () => !controller.signal.aborted && statusRequest.current.version === version;
		if (!cwd) return;
		setLoading(true);
		setStatusError("");
		try {
			const r = await fetch(`/api/git?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || "failed to load git status");
			if (isCurrent()) setInfo(j.data as GitInfo);
		} catch (e) {
			if (isCurrent()) setStatusError(e instanceof Error ? e.message : "failed to load git status");
		} finally {
			if (isCurrent()) setLoading(false);
		}
	}, [cwd]);

	// GitHub 身份单独拉：要走网络（gh / 头像），不能拖慢纯本地状态读取
	useEffect(() => {
		setIdentity(null);
		if (!cwd) return;
		const controller = new AbortController();
		void (async () => {
			try {
				const r = await fetch(`/api/github?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
				const j = await r.json();
				if (j?.success && j.data?.identity) setIdentity(j.data.identity as GithubIdentity);
			} catch {
				/* 取不到就只显示分支，不报错 */
			}
		})();
		return () => controller.abort();
	}, [cwd, refreshKey]);

	useEffect(() => {
		setInfo(null);
		setView(null);
		setDiff(null);
		setDiffError("");
		setStatusError("");
		setActionError("");
		setActionNotice("");
		setExpandedCommit(null);
		setCommitFiles({});
		setCommitLoading(null);
		setLoading(false);
		const statusReq = statusRequest.current;
		const diffReq = diffRequest.current;
		const commitReq = commitRequest.current;
		return () => {
			statusReq.controller?.abort();
			statusReq.version += 1;
			diffReq.controller?.abort();
			diffReq.version += 1;
			commitReq.controller?.abort();
			commitReq.version += 1;
		};
	}, [cwd]);
	useEffect(() => {
		setCommitFiles({});
		void load();
	}, [load, refreshKey]);

	useEffect(() => {
		if (!actionNotice) return;
		const timer = setTimeout(() => setActionNotice(""), 3000);
		return () => clearTimeout(timer);
	}, [actionNotice]);

	const loadDiff = useCallback(async (target: View) => {
		diffRequest.current.controller?.abort();
		const controller = new AbortController();
		const version = ++diffRequest.current.version;
		diffRequest.current.controller = controller;
		const isCurrent = () => !controller.signal.aborted && diffRequest.current.version === version;
		setDiffLoading(true);
		setDiff(null);
		setDiffError("");
		try {
			const url = target.kind === "file"
				? `/api/git?cwd=${encodeURIComponent(cwd)}&diff=${encodeURIComponent(target.path)}&mode=${target.mode}`
				: `/api/git?cwd=${encodeURIComponent(cwd)}&show=${encodeURIComponent(target.hash)}`;
			const r = await fetch(url, { signal: controller.signal });
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || "failed to load diff");
			if (isCurrent()) setDiff(j.data as DiffResult);
		} catch (e) {
			if (isCurrent()) setDiffError(e instanceof Error ? e.message : "failed to load diff");
		} finally {
			if (isCurrent()) setDiffLoading(false);
		}
	}, [cwd]);

	useEffect(() => {
		setDiff(null);
		setDiffError("");
		setDiffLoading(false);
		if (view) void loadDiff(view);
		const diffReq = diffRequest.current;
		return () => {
			diffReq.controller?.abort();
			diffReq.version += 1;
		};
	}, [view, loadDiff, refreshKey]);

	const changeView = (next: View | null) => {
		diffRequest.current.controller?.abort();
		diffRequest.current.version += 1;
		setDiff(null);
		setDiffError("");
		setView(next);
	};

	const runMutation = useCallback(async (
		key: string,
		payload: Record<string, unknown>,
		onSuccess?: (data: Record<string, unknown>) => void,
	) => {
		if (!cwd || busyAction !== null) return;
		setBusyAction(key);
		setActionError("");
		setActionNotice("");
		try {
			const response = await fetch("/api/git", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd, ...payload }),
			});
			const result = await response.json();
			if (!response.ok || !result.success) throw new Error(result.error || "Git action failed");
			if (result.data?.info) setInfo(result.data.info as GitInfo);
			else void load();
			onSuccess?.((result.data ?? {}) as Record<string, unknown>);
			onMutated?.();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : "Git action failed");
		} finally {
			setBusyAction(null);
		}
	}, [busyAction, cwd, load, onMutated]);

	const toggleCommitFiles = useCallback(async (hash: string) => {
		if (!onOpenDiff) {
			changeView({ kind: "commit", hash });
			return;
		}
		if (expandedCommit === hash) {
			setExpandedCommit(null);
			return;
		}
		setExpandedCommit(hash);
		if (commitFiles[hash]) return;
		commitRequest.current.controller?.abort();
		const controller = new AbortController();
		const version = ++commitRequest.current.version;
		commitRequest.current.controller = controller;
		setCommitLoading(hash);
		try {
			const r = await fetch(`/api/git?cwd=${encodeURIComponent(cwd)}&commitFiles=${encodeURIComponent(hash)}`, { signal: controller.signal });
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || "failed to load commit files");
			if (!controller.signal.aborted && commitRequest.current.version === version) {
				setCommitFiles((prev) => ({ ...prev, [hash]: (j.data?.files ?? []) as GitCommitFile[] }));
			}
		} catch (err) {
			if (!controller.signal.aborted && commitRequest.current.version === version) {
				setActionError(err instanceof Error ? err.message : "failed to load commit files");
			}
		} finally {
			if (!controller.signal.aborted && commitRequest.current.version === version) setCommitLoading(null);
		}
	}, [commitFiles, cwd, expandedCommit, onOpenDiff]);

	const error = view ? diffError : statusError || actionError || info?.statusError || "";

	const parsed = useMemo(() => (diff?.patch ? parseUnifiedDiff(diff.patch) : null), [diff]);
	const stats = diff?.binary ? null : diff?.stats ?? (parsed && !diff?.truncated ? diffStats(parsed) : null);

	const conflicts = info?.files.filter((f) => f.kind === "conflict") ?? [];
	const staged = info?.files.filter((f) => f.kind !== "conflict" && f.kind !== "untracked" && f.indexStatus !== " ") ?? [];
	const unstaged = info?.files.filter((f) => f.kind !== "conflict" && f.kind !== "untracked" && f.workStatus !== " ") ?? [];
	const untracked = info?.files.filter((f) => f.kind === "untracked") ?? [];

	const areas: Array<{ key: "conflict" | "staged" | "worktree"; label: string; entries: Array<{ file: GitFileEntry; mode: "staged" | "worktree" | "untracked" }>; danger?: boolean }> = [
		{ key: "conflict" as const, label: t.gitConflict, entries: conflicts.map((file) => ({ file, mode: "worktree" as const })), danger: true },
		{ key: "staged" as const, label: t.gitStagingArea, entries: staged.map((file) => ({ file, mode: "staged" as const })) },
		{
			key: "worktree" as const,
			label: t.gitWorkingTree,
			entries: [...unstaged.map((file) => ({ file, mode: "worktree" as const })), ...untracked.map((file) => ({ file, mode: "untracked" as const }))],
		},
	].filter((area) => area.entries.length > 0);

	const openFile = (f: GitFileEntry, mode: "staged" | "worktree" | "untracked", label: string) => {
		if (onOpenDiff) {
			onOpenDiff({ path: f.path, ...(f.from ? { from: f.from } : {}), mode, label });
			return;
		}
		changeView({ kind: "file", path: f.path, ...(f.from ? { from: f.from } : {}), mode, label });
	};

	const submitCommit = (andPush: boolean) => {
		if (!commitMessage.trim() || staged.length === 0 || busyAction !== null) return;
		void runMutation(andPush ? "commit-push" : "commit", { action: "commit", message: commitMessage, push: andPush }, (data) => {
			setCommitMessage("");
			const hash = typeof data.hash === "string" ? data.hash : "";
			if (andPush && typeof data.pushError === "string" && data.pushError) {
				setActionNotice(t.gitCommitSuccess.replace("{hash}", hash));
				setActionError(data.pushError);
			} else if (andPush && data.pushed) {
				setActionNotice(`${t.gitCommitSuccess.replace("{hash}", hash)} · ${t.gitPushSuccess}`);
			} else {
				setActionNotice(t.gitCommitSuccess.replace("{hash}", hash));
			}
		});
	};

	const headerTitle = view
		? view.kind === "file"
			? view.path.split("/").pop() ?? view.path
			: diff?.title?.split("\n")[0] ?? view.hash
		: t.gitPanel;

	const canCommit = staged.length > 0 && commitMessage.trim().length > 0 && conflicts.length === 0 && busyAction === null;

	return (
		<div className="flex h-full min-h-0 flex-col p-4" data-testid="git-panel">
			<div className="mb-3 flex items-center gap-2">
				{view ? (
					<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.gitBack} onClick={() => changeView(null)}>
						<IconChevronLeft14 size={13} />
					</button>
				) : (
					<IconGitOutline16 size={15} style={{ flex: "none" }} />
				)}
				<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, fontWeight: 600 }} title={view?.kind === "file" ? view.path : undefined}>
					{headerTitle}
				</span>
				{view?.kind === "file" && onOpenFile && info?.root && (
					<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.fileOpenEditor} onClick={() => onOpenFile(`${info.root}/${view.path}`)}>
						<IconFileOutline16 size={13} />
					</button>
				)}
				<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.panelRefresh} onClick={() => (view ? void loadDiff(view) : void load())}>
					<IconRefreshOutline14 size={13} className={loading ? "piweb-spin" : undefined} />
				</button>
				<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.close} onClick={onClose}>
					<IconCloseOutline14 size={13} />
				</button>
			</div>

			{error && (
				<div className="mb-2 rounded-xl px-3 py-2" style={{ fontSize: 12, background: "var(--dsw-danger)", color: "white", wordBreak: "break-word" }} role="alert">
					{!view && (statusError || info?.statusError) && <div>{t.gitStatusUnknown}</div>}
					{error}
				</div>
			)}

			{!view && !statusError && actionNotice && (
				<div role="status" className="mb-2 rounded-xl px-3 py-1.5" style={{ fontSize: 12, background: "var(--dsw-accent-soft)", color: "var(--dsw-accent)" }}>
					{actionNotice}
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
				{/* ---------- 兼容独立渲染的内联差异子页（未接 onOpenDiff 时） ---------- */}
				{view && (
					<div>
						<div className="mb-2 flex flex-wrap items-center gap-2" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
							{view.kind === "file" ? <span>{view.label}</span> : diff?.title?.split("\n")[1] ? <span>{diff.title.split("\n")[1]}</span> : null}
							{stats && (
								<span style={{ fontFamily: "var(--font-mono)" }}>
									<span style={{ color: "var(--dsw-success)" }}>+{stats.add}</span> <span style={{ color: "var(--dsw-danger)" }}>−{stats.del}</span>
								</span>
							)}
							{diff?.truncated && <span style={{ color: "var(--dsw-warn)" }}>{t.gitDiffTruncated}</span>}
							{diff?.patch && <button type="button" className="icon-btn" title={diff.truncated ? t.viewerCopyPatchPreview : t.viewerCopyPatch} aria-label={diff.truncated ? t.viewerCopyPatchPreview : t.viewerCopyPatch}
								onClick={() => void copyText(diff.patch).then((ok) => { if (ok) setCopiedDiff(diff); else setDiffError(t.copyFailed); })}><IconCopyOutline16 size={12} /></button>}
							{copiedDiff && copiedDiff === diff && <span role="status">{t.updateCopied}</span>}
						</div>
						{diffLoading && !diff && <div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "4px 2px" }}>{t.panelLoading}</div>}
						{diff?.binary && <div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "4px 2px" }}>{t.gitBinary}</div>}
						{diff && !diff.binary && !parsed && <div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "4px 2px" }}>{t.gitDiffEmpty}</div>}
						{parsed && (
							<div className="overflow-x-auto rounded-xl px-2 py-1.5" style={{ background: "var(--dsw-hover)" }}>
								<DiffView lines={parsed} language={view?.kind === "file" ? languageForPath(view.path) : undefined} />
							</div>
						)}
					</div>
				)}

				{/* ---------- 状态清单与提交控台 ---------- */}
				{!view && loading && !info && <div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "4px 2px" }}>{t.panelLoading}</div>}
				{!view && !loading && info && !info.available && (
					<div style={{ fontSize: 12.5, color: "var(--dsw-danger)", padding: "8px 2px", lineHeight: 1.6 }}>{t.gitUnavailable}</div>
				)}
				{!view && !loading && info && info.available && !info.isRepo && (
					<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "8px 2px", lineHeight: 1.6 }}>{t.gitNotRepo}</div>
				)}
				{!view && info?.isRepo && (
					<div className="flex flex-col gap-3.5">
						{/* GitHub 身份：头像 + 账号 */}
						{identity && (
							<div className="flex items-center gap-2">
								{identity.avatar ? (
									// eslint-disable-next-line @next/next/no-img-element
									<img src={identity.avatar} alt="" width={22} height={22} className="flex-none rounded-full" />
								) : (
									<span
										className="grid flex-none place-items-center rounded-full"
										style={{ width: 22, height: 22, background: "var(--dsw-selector)", fontSize: 11, fontWeight: 600, color: "var(--dsw-label-secondary)" }}
										aria-hidden
									>
										{identity.login.slice(0, 1).toUpperCase()}
									</span>
								)}
								<a
									href={identity.url ?? `https://github.com/${identity.login}`}
									target="_blank"
									rel="noreferrer"
									className="min-w-0 truncate"
									style={{ fontSize: 12.5, color: "var(--dsw-label-secondary)", textDecoration: "none" }}
									title={identity.name ? `${identity.name} (@${identity.login})` : `@${identity.login}`}
								>
									@{identity.login}
								</a>
								{identity.repo && (
									<span className="min-w-0 truncate" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }} title={identity.repo}>
										· {identity.repo}
									</span>
								)}
							</div>
						)}

						{/* 分支行 + 拉取 / 推送 */}
						<div className="flex flex-col gap-1.5">
							<div className="flex flex-wrap items-center gap-2" style={{ fontSize: 12.5 }}>
								<span
									className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
									style={{ background: "var(--dsw-accent-soft)", color: "var(--dsw-accent)", fontWeight: 600, border: "1px solid var(--dsw-border-l2)" }}
								>
									<IconGitOutline16 size={12} />
									{info.detached ? t.gitDetached : info.branch ?? "—"}
								</span>
								{info.ahead > 0 && <span style={{ color: "var(--dsw-label-secondary)" }}>↑ {t.gitAhead.replace("{n}", String(info.ahead))}</span>}
								{info.behind > 0 && <span style={{ color: "var(--dsw-label-secondary)" }}>↓ {t.gitBehind.replace("{n}", String(info.behind))}</span>}
								<div className="flex-1" />
								<button
									type="button"
									className="pw-chip"
									disabled={busyAction !== null || info.detached}
									onClick={() => void runMutation("pull", { action: "pull" }, () => setActionNotice(t.gitPullSuccess))}
								>
									{busyAction === "pull" ? "…" : t.gitPull}
								</button>
								<button
									type="button"
									className="pw-chip"
									disabled={busyAction !== null || info.detached}
									onClick={() => void runMutation("push", { action: "push" }, () => setActionNotice(t.gitPushSuccess))}
								>
									{busyAction === "push" ? "…" : t.gitPush}
								</button>
							</div>
							<span className="truncate" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }} title={info.upstream ?? undefined}>
								{info.upstream ? t.gitUpstream.replace("{name}", info.upstream) : info.detached ? "" : t.gitNoUpstream}
							</span>
						</div>

						{/* 紧凑 Commit 提交区 */}
						<div className="pw-git-commit-box flex flex-col gap-2 rounded-xl p-2.5">
							<textarea
								rows={2}
								value={commitMessage}
								onChange={(e) => setCommitMessage(e.target.value)}
								onKeyDown={(e) => {
									if (e.nativeEvent.isComposing || e.keyCode === 229) return;
									if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canCommit) {
										e.preventDefault();
										submitCommit(false);
									}
								}}
								placeholder={t.gitCommitPlaceholder}
								aria-label={t.gitCommit}
								className="pw-git-commit-input w-full resize-none bg-transparent outline-none"
								style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--dsw-label-primary)" }}
							/>
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									className="pw-git-commit-btn flex-1 rounded-lg px-2.5 py-1 text-center font-medium transition-opacity"
									disabled={!canCommit}
									title={staged.length === 0 ? t.gitCommitEmptyHint : t.gitCommit}
									onClick={() => submitCommit(false)}
								>
									{busyAction === "commit" ? "…" : t.gitCommit}
								</button>
								<button
									type="button"
									className="pw-chip"
									disabled={!canCommit || info.detached}
									title={t.gitCommitAndPush}
									onClick={() => submitCommit(true)}
								>
									{busyAction === "commit-push" ? "…" : t.gitCommitAndPush}
								</button>
							</div>
						</div>

						{/* 变更文件（每组与每文件带 + / - 暂存开关） */}
						{statusError || info.statusError ? null : info.files.length === 0 ? (
							<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.gitNoChanges}</div>
						) : (
							areas.map((area) => {
								const areaPaths = area.entries.flatMap((e) => (e.file.from ? [e.file.from, e.file.path] : [e.file.path]));
								const isStagedArea = area.key === "staged";
								return (
									<div key={area.key}>
										<div className="mb-1 flex items-center gap-2" style={{ fontSize: 11.5, color: area.danger ? "var(--dsw-danger)" : "var(--dsw-label-caption)" }}>
											<span style={{ fontWeight: 600 }}>{area.label}</span>
											<span>{area.entries.length}</span>
											<div className="flex-1" />
											<button
												type="button"
												className="pw-git-row-op"
												disabled={busyAction !== null}
												title={isStagedArea ? t.gitUnstageAll : t.gitStageAll}
												aria-label={isStagedArea ? t.gitUnstageAll : t.gitStageAll}
												onClick={() => void runMutation(
													`area:${area.key}`,
													{ action: isStagedArea ? "unstage" : "stage", paths: areaPaths },
												)}
											>
												{isStagedArea ? "−" : "+"}
											</button>
										</div>
										<div className="flex flex-col gap-0.5">
											{area.entries.map(({ file: f, mode }) => {
												const isStaged = mode === "staged";
												const opTargets = f.from ? [f.from, f.path] : [f.path];
												return (
													<div
														key={`${area.key}:${f.path}`}
														className="pw-git-file-row group flex items-center gap-1 rounded-xl px-1.5 py-1"
													>
														<button
															type="button"
															className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5 text-left"
															title={f.path}
															onClick={() => openFile(f, mode, mode === "staged" ? t.gitStagedDiff : mode === "untracked" ? t.gitUntracked : t.gitWorktreeDiff)}
														>
															<span
																className="flex-none rounded-full px-1.5 text-center"
																style={{
																	minWidth: 18,
																	fontSize: 10,
																	fontFamily: "var(--font-mono)",
																	fontWeight: 700,
																	color: KIND_COLOR[f.kind],
																	background: "var(--dsw-hover)",
																	border: "1px solid currentColor",
																}}
															>
																{f.kind === "untracked" ? "?" : f.kind === "conflict" ? "!" : isStaged ? f.indexStatus : f.workStatus !== " " ? f.workStatus : f.indexStatus}
															</span>
															<span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--dsw-label-secondary)" }}>
																{f.from ? `${f.from} → ${f.path}` : f.path}
															</span>
														</button>
														<button
															type="button"
															className="pw-git-row-op flex-none"
															disabled={busyAction !== null}
															title={isStaged ? `${t.gitUnstage}: ${f.path}` : `${t.gitStage}: ${f.path}`}
															aria-label={isStaged ? `${t.gitUnstage} ${f.path}` : `${t.gitStage} ${f.path}`}
															onClick={(e) => {
																e.stopPropagation();
																void runMutation(
																	`file:${area.key}:${f.path}`,
																	{ action: isStaged ? "unstage" : "stage", paths: opTargets },
																);
															}}
														>
															{isStaged ? "−" : "+"}
														</button>
													</div>
												);
											})}
										</div>
									</div>
								);
							})
						)}

						{/* 最近提交（点开就地展开文件清单，点文件进 FileViewer 看提交并排差异） */}
						<div className="hairline-t pt-3">
							<div className="mb-1" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--dsw-label-caption)" }}>{t.gitRecentCommits}</div>
							{info.commits.length === 0 ? (
								<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "4px 2px" }}>{t.gitNoCommits}</div>
							) : (
								<div className="flex flex-col gap-0.5">
									{info.commits.map((c) => {
										const isExpanded = expandedCommit === c.hash;
										const files = commitFiles[c.hash];
										return (
											<div key={c.hash} className="flex flex-col">
												<button
													type="button"
													aria-expanded={onOpenDiff ? isExpanded : undefined}
													className="pw-git-commit-item flex w-full flex-col items-stretch rounded-xl px-2.5 py-1.5 text-left"
													onClick={() => void toggleCommitFiles(c.hash)}
												>
													<span className="flex items-baseline gap-2">
														<span className="flex-none rounded-md px-1.5 py-0.5" style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--dsw-accent)", background: "var(--dsw-accent-soft)" }}>{c.hash}</span>
														<span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, color: "var(--dsw-label-secondary)" }} title={c.subject}>{c.subject}</span>
													</span>
													<span className="truncate" style={{ fontSize: 11, color: "var(--dsw-label-caption)", marginTop: 2 }}>
														{c.author} · {c.relative}
													</span>
												</button>
												{onOpenDiff && isExpanded && (
													<div className="ml-3 mb-1.5 flex flex-col gap-0.5 border-l pl-2" style={{ borderColor: "var(--dsw-border-l2)" }}>
														{commitLoading === c.hash && !files && (
															<div style={{ fontSize: 11.5, color: "var(--dsw-label-caption)", padding: "3px 6px" }}>{t.gitCommitFilesLoading}</div>
														)}
														{files && files.length === 0 && (
															<div style={{ fontSize: 11.5, color: "var(--dsw-label-caption)", padding: "3px 6px" }}>{t.gitCommitFilesEmpty}</div>
														)}
														{files?.map((cf) => (
															<button
																key={`${c.hash}:${cf.path}`}
																type="button"
																className="pw-git-commit-file flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left"
																title={cf.path}
																onClick={() => onOpenDiff({
																	path: cf.path,
																	...(cf.from ? { from: cf.from } : {}),
																	mode: "commit",
																	hash: c.hash,
																	label: `${c.hash} · ${c.subject}`,
																})}
															>
																<span style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, color: COMMIT_STATUS_COLOR[cf.status], width: 12, textAlign: "center" }}>{cf.status}</span>
																<span className="min-w-0 flex-1 truncate" style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--dsw-label-secondary)" }}>{cf.path}</span>
																{!cf.binary && (
																	<span className="flex-none" style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--dsw-label-caption)" }}>
																		<span style={{ color: "var(--dsw-success)" }}>+{cf.add}</span>{" "}
																		<span style={{ color: "var(--dsw-danger)" }}>−{cf.del}</span>
																	</span>
																)}
															</button>
														))}
													</div>
												)}
											</div>
										);
									})}
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
