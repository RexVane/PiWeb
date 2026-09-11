"use client";

/**
 * Git 面板（详情栏）：分支 / 上游 / ahead-behind、按状态分组的变更文件、最近提交；
 * 点文件看差异（暂存 / 工作区 / 未跟踪整文件），点提交看该次提交的内容。
 * 只读——提交、推送走对话让 pi 做（「让 pi 提交」会把请求填进输入框）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { DiffView, diffStats, parseUnifiedDiff } from "@/components/DiffView";
import { IconChevronLeft14, IconCloseOutline14, IconFileOutline16, IconGitOutline16, IconRefreshOutline14 } from "@/components/icons";
import { useI18n } from "@/i18n";

interface GitFileEntry {
	path: string;
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
}

interface DiffResult {
	patch: string;
	truncated: boolean;
	binary: boolean;
	title?: string;
}

type View = { kind: "file"; path: string; mode: "staged" | "worktree" | "untracked"; label: string } | { kind: "commit"; hash: string };

const KIND_COLOR: Record<GitFileEntry["kind"], string> = {
	modified: "var(--dsw-warn)",
	added: "var(--dsw-success)",
	deleted: "var(--dsw-danger)",
	renamed: "var(--dsw-accent)",
	untracked: "var(--dsw-label-caption)",
	conflict: "var(--dsw-danger)",
};

export function GitPanel({
	cwd,
	onClose,
	refreshKey = 0,
	onAskCommit,
	onOpenFile,
}: {
	cwd: string;
	onClose: () => void;
	/** 外部触发刷新（回合结束 / pi 改了文件） */
	refreshKey?: number;
	/** 把「请提交当前变更」填进输入框 */
	onAskCommit?: () => void;
	/** 在本机编辑器打开（相对仓库根的路径） */
	onOpenFile?: (absPath: string) => void;
}) {
	const { t } = useI18n();
	const [info, setInfo] = useState<GitInfo | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [view, setView] = useState<View | null>(null);
	const [diff, setDiff] = useState<DiffResult | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);

	const load = useCallback(async () => {
		if (!cwd) return;
		setLoading(true);
		setError("");
		try {
			const r = await fetch(`/api/git?cwd=${encodeURIComponent(cwd)}`);
			const j = await r.json();
			if (!j.success) throw new Error(j.error || "failed to load git status");
			setInfo(j.data as GitInfo);
		} catch (e) {
			setError(e instanceof Error ? e.message : "failed to load git status");
		} finally {
			setLoading(false);
		}
	}, [cwd]);

	useEffect(() => {
		setInfo(null);
		setView(null);
		setDiff(null);
		void load();
	}, [load]);

	// 外部刷新：列表静默重拉；正在看的差异也重拉
	useEffect(() => {
		if (refreshKey > 0) void load();
	}, [refreshKey, load]);

	const loadDiff = useCallback(
		async (target: View) => {
			setDiffLoading(true);
			setDiff(null);
			setError("");
			try {
				const url = target.kind === "file"
					? `/api/git?cwd=${encodeURIComponent(cwd)}&diff=${encodeURIComponent(target.path)}&mode=${target.mode}`
					: `/api/git?cwd=${encodeURIComponent(cwd)}&show=${encodeURIComponent(target.hash)}`;
				const r = await fetch(url);
				const j = await r.json();
				if (!j.success) throw new Error(j.error || "failed to load diff");
				setDiff(j.data as DiffResult);
			} catch (e) {
				setError(e instanceof Error ? e.message : "failed to load diff");
			} finally {
				setDiffLoading(false);
			}
		},
		[cwd],
	);

	useEffect(() => {
		if (view) void loadDiff(view);
	}, [view, loadDiff, refreshKey]);

	const parsed = useMemo(() => (diff?.patch ? parseUnifiedDiff(diff.patch) : null), [diff]);
	const stats = parsed ? diffStats(parsed) : null;

	const conflicts = info?.files.filter((f) => f.kind === "conflict") ?? [];
	const staged = info?.files.filter((f) => f.kind !== "conflict" && f.kind !== "untracked" && f.indexStatus !== " ") ?? [];
	const unstaged = info?.files.filter((f) => f.kind !== "conflict" && f.kind !== "untracked" && f.workStatus !== " ") ?? [];
	const untracked = info?.files.filter((f) => f.kind === "untracked") ?? [];

	const openFile = (f: GitFileEntry, mode: "staged" | "worktree" | "untracked", label: string) => setView({ kind: "file", path: f.path, mode, label });

	const headerTitle = view
		? view.kind === "file"
			? view.path.split("/").pop() ?? view.path
			: diff?.title?.split("\n")[0] ?? view.hash
		: t.gitPanel;

	return (
		<div className="flex h-full min-h-0 flex-col p-4">
			<div className="mb-3 flex items-center gap-2">
				{view ? (
					<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.gitBack} onClick={() => { setView(null); setDiff(null); }}>
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
					<IconRefreshOutline14 size={13} />
				</button>
				<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.close} onClick={onClose}>
					<IconCloseOutline14 size={13} />
				</button>
			</div>

			{error && (
				<div className="mb-2 rounded-xl px-3 py-2" style={{ fontSize: 12.5, background: "var(--dsw-danger)", color: "white" }} role="alert">
					{error}
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto">
				{/* ---------- 差异视图 ---------- */}
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
						</div>
						{diffLoading && !diff && <div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "4px 2px" }}>{t.panelLoading}</div>}
						{diff?.binary && <div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "4px 2px" }}>{t.gitBinary}</div>}
						{diff && !diff.binary && !parsed && <div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "4px 2px" }}>{t.gitDiffEmpty}</div>}
						{parsed && (
							<div className="overflow-x-auto rounded-xl px-2 py-1.5" style={{ background: "var(--dsw-hover)" }}>
								<DiffView lines={parsed} />
							</div>
						)}
					</div>
				)}

				{/* ---------- 状态列表 ---------- */}
				{!view && loading && !info && <div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "4px 2px" }}>{t.panelLoading}</div>}
				{!view && !loading && info && !info.available && (
					<div style={{ fontSize: 12.5, color: "var(--dsw-danger)", padding: "8px 2px", lineHeight: 1.6 }}>{t.gitUnavailable}</div>
				)}
				{!view && !loading && info && info.available && !info.isRepo && (
					<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "8px 2px", lineHeight: 1.6 }}>{t.gitNotRepo}</div>
				)}
				{!view && info?.isRepo && (
					<div className="flex flex-col gap-4">
						{/* 分支行 */}
						<div className="flex flex-wrap items-center gap-2" style={{ fontSize: 12.5 }}>
							<span
								className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
								style={{ background: "var(--dsw-accent-soft)", color: "var(--dsw-accent)", fontWeight: 500 }}
							>
								<IconGitOutline16 size={12} />
								{info.detached ? t.gitDetached : info.branch ?? "—"}
							</span>
							{info.ahead > 0 && <span style={{ color: "var(--dsw-label-secondary)" }}>↑ {t.gitAhead.replace("{n}", String(info.ahead))}</span>}
							{info.behind > 0 && <span style={{ color: "var(--dsw-label-secondary)" }}>↓ {t.gitBehind.replace("{n}", String(info.behind))}</span>}
							<span className="min-w-0 truncate" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }} title={info.upstream ?? undefined}>
								{info.upstream ? t.gitUpstream.replace("{name}", info.upstream) : info.detached ? "" : t.gitNoUpstream}
							</span>
						</div>

						{/* 让 pi 提交 */}
						{info.files.length > 0 && onAskCommit && (
							<button
								type="button"
								className="btn-outline self-start"
								style={{ height: 28, padding: "0 12px", fontSize: 12 }}
								onClick={onAskCommit}
								title={t.gitAskCommitPrompt}
							>
								{t.gitAskCommit}
							</button>
						)}

						{/* 变更文件 */}
						{info.files.length === 0 ? (
							<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.gitNoChanges}</div>
						) : (
							[
								{ label: t.gitConflict, list: conflicts, mode: "worktree" as const },
								{ label: t.gitStaged, list: staged, mode: "staged" as const },
								{ label: t.gitUnstaged, list: unstaged, mode: "worktree" as const },
								{ label: t.gitUntracked, list: untracked, mode: "untracked" as const },
							].map(
								(group) =>
									group.list.length > 0 && (
										<div key={group.label}>
											<div className="mb-1 flex items-center gap-2" style={{ fontSize: 11.5, color: group.mode === "worktree" && group.label === t.gitConflict ? "var(--dsw-danger)" : "var(--dsw-label-caption)" }}>
												<span style={{ fontWeight: 600 }}>{group.label}</span>
												<span>{group.list.length}</span>
											</div>
											<div className="flex flex-col">
												{group.list.map((f) => (
													<button
														key={`${group.label}:${f.path}`}
														type="button"
														className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors"
														title={f.path}
														onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
														onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
														onClick={() => openFile(f, group.mode, group.mode === "staged" ? t.gitStagedDiff : group.mode === "untracked" ? t.gitUntracked : t.gitWorktreeDiff)}
													>
														<span
															className="flex-none rounded px-1 text-center"
															style={{ minWidth: 16, fontSize: 10.5, fontFamily: "var(--font-mono)", fontWeight: 600, color: KIND_COLOR[f.kind], background: "var(--dsw-hover)" }}
														>
															{f.kind === "untracked" ? "?" : f.kind === "conflict" ? "!" : group.mode === "staged" ? f.indexStatus : f.workStatus !== " " ? f.workStatus : f.indexStatus}
														</span>
														<span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--dsw-label-secondary)" }}>
															{f.path}
														</span>
													</button>
												))}
											</div>
										</div>
									),
							)
						)}

						{/* 最近提交 */}
						<div className="hairline-t pt-3">
							<div className="mb-1" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--dsw-label-caption)" }}>{t.gitRecentCommits}</div>
							{info.commits.length === 0 ? (
								<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", padding: "4px 2px" }}>{t.gitNoCommits}</div>
							) : (
								<div className="flex flex-col">
									{info.commits.map((c) => (
										<button
											key={c.hash}
											type="button"
											className="flex w-full flex-col items-stretch rounded-lg px-2 py-1 text-left transition-colors"
											onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
											onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
											onClick={() => setView({ kind: "commit", hash: c.hash })}
										>
											<span className="flex items-baseline gap-2">
												<span className="flex-none" style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--dsw-accent)" }}>{c.hash}</span>
												<span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, color: "var(--dsw-label-secondary)" }} title={c.subject}>{c.subject}</span>
											</span>
											<span className="truncate" style={{ fontSize: 11, color: "var(--dsw-label-caption)", paddingLeft: 0 }}>
												{c.author} · {c.relative}
											</span>
										</button>
									))}
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
