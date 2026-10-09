"use client";

/**
 * 项目栏（侧栏与对话之间的第四列）：项目生长 = 每轮一个 git commit。
 * 头部：工作区名 + 立即记录 / 收起；所选轮：提问首行、时间、文件数与行数、在对话里看；
 * 工具行：范围（本轮 / 本会话累计）、只看改动、筛选；中间：项目树（GrowthTree）；
 * 底部：时间轴每轮一根柱（高度 = 改动行数，灰色细柱 = 你在两轮之间自己的修改），默认跟随最新一轮。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GrowthTree } from "@/components/project/GrowthTree";
import { IconChevronLeft14, IconChevronRight14, IconCloseOutline14, IconGitOutline16, IconRefreshOutline14, IconSearchOutline16 } from "@/components/common/icons";
import type { GrowthApi, GrowthEntry } from "@/hooks/useGrowth";
import { useI18n } from "@/i18n";
import type { GitInfo } from "@/lib/workspace/git-service";
import type { TreeNode } from "@/lib/growth/growth-tree";
import type { GrowthChange } from "@/lib/types";

/** 「第 7 轮 · 把保存按钮改成红色」/「你的修改」 */
export function roundTitle(round: GrowthEntry, t: Record<string, string>): string {
	if (round.kind !== "round") return t.growthKindUser;
	const label = t.growthRoundLabel.replace("{n}", String(round.n ?? ""));
	return round.title ? `${label} · ${round.title}` : label;
}

/** 柱的颜色：你的修改为灰；pi 的一轮按主要改动类型（删除为主红、新增为主绿、否则黄） */
function roundColor(round: GrowthEntry): string {
	if (round.kind !== "round") return "var(--dsw-label-caption)";
	const st = round.stats;
	if (!st.added && !st.modified && !st.deleted && !st.renamed) return "var(--dsw-border-l3)";
	if (st.deleted && st.deleted >= st.added && st.deleted >= st.modified) return "var(--dsw-danger)";
	if (st.added >= st.modified) return "var(--dsw-success)";
	return "var(--dsw-warn)";
}

function changedLines(round: GrowthEntry): number {
	return round.stats.add + round.stats.del;
}

function fmtTime(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function sumChanges(changes: GrowthChange[]): { files: number; add: number; del: number } {
	let add = 0;
	let del = 0;
	for (const c of changes) {
		add += c.add ?? 0;
		del += c.del ?? 0;
	}
	return { files: changes.length, add, del };
}

export function ProjectPanel({
	growth,
	workspaceName,
	cwd,
	hasSession,
	running = false,
	onOpenFile,
	onReference,
	onOpenEditor,
	onJumpToChat,
	gitRefreshKey = 0,
	onAskCommit,
	onOpenGit,
	onClose,
	onError,
}: {
	growth: GrowthApi;
	workspaceName: string;
	cwd: string;
	hasSession: boolean;
	/** 本会话正在运行：时间轴末尾显示「本轮进行中」 */
	running?: boolean;
	onOpenFile: (node: TreeNode) => void;
	onReference?: (path: string) => void;
	onOpenEditor?: (path: string) => void;
	/** 跳到对话里这一轮的提问（用户消息 entryId） */
	onJumpToChat?: (messageId: string) => void;
	gitRefreshKey?: number;
	onAskCommit?: () => void;
	onOpenGit?: () => void;
	onClose: () => void;
	onError: (message: string) => void;
}) {
	const { t } = useI18n();
	const tt = t as unknown as Record<string, string>;
	const [filter, setFilter] = useState("");
	const [onlyChanges, setOnlyChanges] = useState(true);
	const [recording, setRecording] = useState(false);
	const [notice, setNotice] = useState("");
	const [gitState, setGitState] = useState<{ cwd: string; info: GitInfo | null; error?: string } | null>(null);
	const git = gitState?.cwd === cwd ? gitState.info : null;
	const gitError = gitState?.cwd === cwd ? gitState.error ?? git?.statusError : undefined;
	useEffect(() => setOnlyChanges(true), [cwd]);
	const { rounds, selected } = growth;
	const latestCommit = rounds[rounds.length - 1]?.commit ?? "";
	useEffect(() => {
		if (!cwd) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			void fetch(`/api/git?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal, cache: "no-store" })
				.then(async (response) => {
					const result = await response.json();
					if (!response.ok || !result.success) throw new Error(result.error || `request failed (${response.status})`);
					if (!controller.signal.aborted) setGitState({ cwd, info: result.data as GitInfo });
				})
				.catch((error) => {
					if (!controller.signal.aborted) setGitState({ cwd, info: null, error: error instanceof Error ? error.message : "failed to load git status" });
				});
		}, 250);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [cwd, gitRefreshKey, latestCommit]);

	const totals = useMemo(() => sumChanges(growth.changes), [growth.changes]);
	const piRounds = useMemo(() => rounds.filter((round) => round.kind === "round").length, [rounds]);
	const maxLines = useMemo(() => Math.max(1, ...rounds.map(changedLines)), [rounds]);
	const railRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!selected) return;
		railRef.current?.querySelector<HTMLElement>(`[data-commit="${selected.commit}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [selected]);
	const selectedIdx = selected ? rounds.findIndex((round) => round.commit === selected.commit) : -1;
	const conflicts = git?.files.filter((file) => file.kind === "conflict").length ?? 0;
	const staged = git?.files.filter((file) => file.kind !== "conflict" && file.indexStatus !== " ").length ?? 0;
	const unstaged = git?.files.filter((file) => file.kind !== "conflict" && file.workStatus !== " " && file.kind !== "untracked").length ?? 0;
	const untracked = git?.files.filter((file) => file.kind === "untracked").length ?? 0;

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(""), 2500);
		return () => clearTimeout(timer);
	}, [notice]);

	const recordNow = async () => {
		if (recording) return;
		setRecording(true);
		try {
			const round = await growth.recordNow();
			if (!round) setNotice(t.growthRecordNone);
		} catch (e) {
			onError(e instanceof Error ? e.message : "failed");
		} finally {
			setRecording(false);
		}
	};

	const emptyText = !cwd || !hasSession ? t.growthNoSession : growth.loading && !rounds.length ? t.growthLoading : !growth.available ? t.growthUnavailable : rounds.length ? undefined : t.growthNoRounds;
	const statusText = selected?.status === "aborted" ? t.growthStatusAborted : selected?.status === "error" ? t.growthStatusError : "";

	return (
		<div className="pw-project flex h-full min-h-0 flex-col" data-testid="project-panel">
			{/* 头部 */}
			<div className="flex items-center gap-1.5 px-3 pt-3 pb-1.5">
				<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, fontWeight: 600 }} title={cwd}>
					{workspaceName || t.projectPanel}
				</span>
				{hasSession && (
					<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.growthRecordNow} onClick={() => void recordNow()} disabled={recording}>
						<IconRefreshOutline14 size={13} className={recording ? "piweb-spin" : undefined} />
					</button>
				)}
				<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.close} onClick={onClose}>
					<IconCloseOutline14 size={13} />
				</button>
			</div>
			{/* 生长记录不可用（找不到 git 等）：明确提示 + 已退化为当前目录结构 */}
			{cwd && hasSession && !growth.available && !growth.loading && (
				<div className="mx-3 mb-2 rounded-lg px-2 py-1" style={{ fontSize: 11.5, color: "var(--dsw-warn)", background: "var(--dsw-hover)" }} role="status">
					{t.growthUnavailableFallback}
				</div>
			)}
			{gitError && (
				<div className="mx-3 mb-2 rounded-lg px-2 py-1" style={{ fontSize: 11.5, color: "var(--dsw-danger)" }} title={gitError} role="alert" data-testid="growth-git-error">
					{t.gitStatusUnknown}
				</div>
			)}
			{git?.isRepo && !gitError && (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2" style={{ fontSize: 11.5, color: "var(--dsw-label-secondary)" }} data-testid="growth-git-summary">
					<IconGitOutline16 size={13} style={{ flex: "none", color: "var(--dsw-label-caption)" }} />
					<span className="max-w-[45%] truncate" style={{ fontWeight: 600, color: "var(--dsw-label-primary)" }} title={git.branch ?? undefined}>{git.detached ? t.gitDetached : git.branch ?? "Git"}</span>
					{git.ahead > 0 && <span title={t.gitAhead.replace("{n}", String(git.ahead))}>↑{git.ahead}</span>}
					{git.behind > 0 && <span title={t.gitBehind.replace("{n}", String(git.behind))}>↓{git.behind}</span>}
					{git.files.length ? (
						<span className="min-w-0 flex-1 truncate" title={`${conflicts ? `${t.gitConflict} ${conflicts} · ` : ""}${t.gitStaged} ${staged} · ${t.gitUnstaged} ${unstaged} · ${t.gitUntracked} ${untracked}`}>
							{conflicts > 0 && <span style={{ color: "var(--dsw-danger)" }}>{t.gitConflict} {conflicts} </span>}
							{staged > 0 && <span style={{ color: "var(--dsw-success)" }}>{t.gitStaged} {staged} </span>}
							{unstaged > 0 && <span style={{ color: "var(--dsw-warn)" }}>{t.gitUnstaged} {unstaged} </span>}
							{untracked > 0 && <span>{t.gitUntracked} {untracked}</span>}
						</span>
					) : <span className="min-w-0 flex-1 truncate">{t.gitNoChanges}</span>}
					{git.files.length > 0 && onAskCommit && <button type="button" className="pw-chip" onClick={onAskCommit}>{t.gitAskCommit}</button>}
					{onOpenGit && <button type="button" className="pw-chip" onClick={onOpenGit}>{t.gitDetails}</button>}
				</div>
			)}
			{/* 所选这一轮：提问首行 / 时间 · 文件数 · 行数 / 在对话里看 */}
			{selected && (
				<div className="px-3 pb-2" data-testid="growth-round-summary">
					<div className="truncate" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--dsw-label-primary)" }} title={roundTitle(selected, tt)}>
						{roundTitle(selected, tt)}
					</div>
					<div className="mt-0.5 flex items-center gap-2" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
						<span>{fmtTime(selected.ts)}</span>
						<span>·</span>
						<span>{t.growthRoundFiles.replace("{n}", String(totals.files))}</span>
						<span style={{ color: "var(--dsw-success)" }}>+{totals.add}</span>
						<span style={{ color: "var(--dsw-danger)" }}>−{totals.del}</span>
						{statusText && <span style={{ color: "var(--dsw-warn)" }}>{statusText}</span>}
						<span className="flex-1" />
						{onJumpToChat && selected.promptIds[0] && (
							<button type="button" className="pw-chip" onClick={() => onJumpToChat(selected.promptIds[0])}>
								{t.growthJumpToChat}
							</button>
						)}
					</div>
				</div>
			)}
			{/* 范围 + 只看改动 */}
			<div className="flex items-center gap-2 px-3 pb-2" style={{ fontSize: 11.5 }}>
				<span className="pw-seg" role="radiogroup">
					{(["round", "session"] as const).map((s) => (
						<button key={s} type="button" role="radio" aria-checked={growth.scope === s} data-active={growth.scope === s} onClick={() => growth.setScope(s)}>
							{s === "round" ? t.growthScopeRound : t.growthScopeSession}
						</button>
					))}
				</span>
				<span className="min-w-0 flex-1 truncate" style={{ color: "var(--dsw-label-secondary)" }}>{notice}</span>
				<button type="button" className="pw-chip" data-active={onlyChanges} aria-pressed={onlyChanges} onClick={() => setOnlyChanges((value) => !value)}>
					{t.growthOnlyChanges}
				</button>
			</div>
			{/* 筛选 */}
			<div className="mx-3 mb-1.5 flex items-center gap-1.5 rounded-lg px-2" style={{ background: "var(--dsw-hover)", height: 26 }}>
				<IconSearchOutline16 size={12} style={{ flex: "none", color: "var(--dsw-label-caption)" }} />
				<input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder={t.growthFilter}
					className="min-w-0 flex-1 bg-transparent"
					style={{ fontSize: 12 }}
					onKeyDown={(e) => {
						if (e.key === "Escape") setFilter("");
					}}
				/>
				{filter && (
					<button type="button" className="icon-btn" style={{ width: 16, height: 16 }} onClick={() => setFilter("")} aria-label={t.close}>
						<IconCloseOutline14 size={10} />
					</button>
				)}
			</div>
			{growth.error && (
				<div className="mx-3 mb-1 rounded-lg px-2 py-1 break-words" style={{ fontSize: 11, color: "var(--dsw-danger)", background: "var(--dsw-hover)" }} role="alert">
					{growth.error}
				</div>
			)}
			{selected?.truncated && growth.scope === "round" && (
				<div className="mx-3 mb-1 rounded-lg px-2 py-1" style={{ fontSize: 11, color: "var(--dsw-warn)", background: "var(--dsw-hover)" }}>
					{t.growthTruncated}
				</div>
			)}
			{selected && growth.scope === "round" && !growth.changes.length && !emptyText && (
				<div className="mx-3 mb-1 rounded-lg px-2 py-1" style={{ fontSize: 11, color: "var(--dsw-label-caption)", background: "var(--dsw-hover)" }} role="status">
					{t.growthNoChangesRound}
				</div>
			)}
			{/* 树 */}
			<GrowthTree
				tree={growth.tree}
				expanded={growth.expanded}
				fresh={growth.fresh}
				filter={filter}
				onlyChanges={onlyChanges && growth.changes.length > 0}
				onToggleDir={growth.toggleDir}
				onExpandLazy={growth.expandLazy}
				onOpenFile={onOpenFile}
				onReference={onReference}
				onOpenEditor={onOpenEditor}
				emptyText={emptyText}
			/>
			{/* 时间轴 */}
			{hasSession && (
				<div className="pw-timeline hairline-t" data-testid="growth-timeline">
					{(rounds.length > 0 || running) && (
						<div ref={railRef} className="pw-tl-rail">
							{rounds.map((round) => {
								// 对数缩放：几十行和几千行的轮都看得出来，又不会一根柱子压扁其余
								const lines = changedLines(round);
								const h = round.changes.length || lines ? Math.max(5, Math.round(4 + (Math.log1p(lines) / Math.log1p(maxLines)) * 20)) : 3;
								return (
									<button
										key={round.commit}
										type="button"
										className="pw-tl-bar"
										data-commit={round.commit}
										data-kind={round.kind}
										data-active={selected?.commit === round.commit || undefined}
										style={{ height: h, background: roundColor(round) }}
										title={`${roundTitle(round, tt)} · ${fmtTime(round.ts)} · ${t.growthRoundFiles.replace("{n}", String(round.changes.length))} +${round.stats.add} −${round.stats.del}`}
										onClick={() => growth.select(round.commit)}
									/>
								);
							})}
							{running && <span className="pw-tl-bar" data-running="" title={t.growthRunning} aria-label={t.growthRunning} />}
						</div>
					)}
					<div className="flex items-center gap-1 px-2 pb-2 pt-1" style={{ fontSize: 11.5 }}>
						<button className="icon-btn" style={{ width: 20, height: 20 }} title={t.growthPrev} onClick={growth.prev} disabled={selectedIdx <= 0}>
							<IconChevronLeft14 size={12} />
						</button>
						<button className="icon-btn" style={{ width: 20, height: 20 }} title={t.growthNext} onClick={growth.next} disabled={selectedIdx < 0 || selectedIdx >= rounds.length - 1}>
							<IconChevronRight14 size={12} />
						</button>
						<span className="min-w-0 flex-1 truncate" style={{ color: "var(--dsw-label-secondary)" }}>
							{selected?.n
								? t.growthRoundPosition.replace("{current}", String(selected.n)).replace("{total}", String(piRounds))
								: selected
									? t.growthKindUser
									: t.growthRoundPosition.replace("{current}", "0").replace("{total}", String(piRounds))}
						</span>
						<button type="button" className="pw-chip" data-active={growth.following} onClick={growth.follow} title={t.growthFollow}>
							{growth.following ? t.growthFollowing : t.growthFollow}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
