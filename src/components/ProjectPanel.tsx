"use client";

/**
 * 项目栏（侧栏与对话之间的第四列）：项目生长可视化。
 * 头部：工作区名 + 本会话总计 + 立即快照 / 收起；工具行：范围（本步 / 本会话）、只看变更、筛选；
 * 中间：项目树（GrowthTree）；底部：按轮浏览历史，默认跟随最新一轮。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GrowthTree } from "@/components/GrowthTree";
import { IconChevronLeft14, IconChevronRight14, IconCloseOutline14, IconGitOutline16, IconRefreshOutline14, IconSearchOutline16 } from "@/components/icons";
import type { GrowthApi } from "@/hooks/useGrowth";
import { useI18n } from "@/i18n";
import type { GitInfo } from "@/lib/git-service";
import type { TreeNode } from "@/lib/growth-tree";
import type { GrowthStep } from "@/lib/types";


export function stepTitle(step: GrowthStep, t: Record<string, string>): string {
	if (step.kind === "baseline") return t.growthKindBaseline;
	if (step.kind === "turn") return t.growthKindTurn;
	if (step.kind === "external") return t.growthKindExternal;
	if (step.kind === "manual") return step.label || t.growthKindManual;
	return step.label || step.toolName || "";
}

function stepColor(step: GrowthStep): string {
	if (step.kind === "baseline") return "var(--dsw-label-caption)";
	if (step.kind === "external") return "var(--dsw-accent)";
	const st = step.stats;
	if (st.deleted && st.deleted >= st.added && st.deleted >= st.modified) return "var(--dsw-danger)";
	if (st.added >= st.modified) return "var(--dsw-success)";
	return "var(--dsw-warn)";
}

function fmtTime(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function ProjectPanel({
	growth,
	workspaceName,
	cwd,
	hasSession,
	onOpenFile,
	onReference,
	onOpenEditor,
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
	onOpenFile: (node: TreeNode) => void;
	onReference?: (path: string) => void;
	onOpenEditor?: (path: string) => void;
	gitRefreshKey?: number;
	onAskCommit?: () => void;
	onOpenGit?: () => void;
	onClose: () => void;
	onError: (message: string) => void;
}) {
	const { t } = useI18n();
	const tt = t as unknown as Record<string, string>;
	const [filter, setFilter] = useState("");
	const [onlyChanges, setOnlyChanges] = useState(false);
	const [snapshotting, setSnapshotting] = useState(false);
	const [notice, setNotice] = useState("");
	const [gitState, setGitState] = useState<{ cwd: string; info: GitInfo | null; error?: string } | null>(null);
	const git = gitState?.cwd === cwd ? gitState.info : null;
	const gitError = gitState?.cwd === cwd ? gitState.error ?? git?.statusError : undefined;
	useEffect(() => setOnlyChanges(false), [cwd]);
	const latestSeq = growth.steps[growth.steps.length - 1]?.seq ?? 0;
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
	}, [cwd, gitRefreshKey, latestSeq]);

	const totals = useMemo(() => {
		const out = { added: 0, modified: 0, deleted: 0, renamed: 0 };
		for (const c of growth.scope === "step" ? growth.changes : growth.sessionChanges) {
			if (c.status === "A") out.added += 1;
			else if (c.status === "M") out.modified += 1;
			else if (c.status === "D") out.deleted += 1;
			else out.renamed += 1;
		}
		return out;
	}, [growth.scope, growth.changes, growth.sessionChanges]);

	const { steps, selectedRound, rounds } = growth;
	const railRef = useRef<HTMLDivElement>(null);
	const maxSteps = useMemo(() => Math.max(1, ...rounds.map((r) => r.steps.filter((step) => step.kind !== "turn").length)), [rounds]);
	useEffect(() => {
		if (!selectedRound) return;
		railRef.current?.querySelector<HTMLElement>(`[data-round="${selectedRound.id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [selectedRound]);
	const selectedIdx = selectedRound ? rounds.findIndex((round) => round.id === selectedRound.id) : -1;
	const roundLabel = selectedRound ? !selectedRound.recorded ? t.growthUnrecorded : selectedRound.steps.every((step) => step.kind === "turn") ? t.growthNoChangesRound : stepTitle(selectedRound.steps.find((step) => step.kind !== "turn") ?? selectedRound.last!, tt) : "";
	const conflicts = git?.files.filter((file) => file.kind === "conflict").length ?? 0;
	const staged = git?.files.filter((file) => file.kind !== "conflict" && file.indexStatus !== " ").length ?? 0;
	const unstaged = git?.files.filter((file) => file.kind !== "conflict" && file.workStatus !== " " && file.kind !== "untracked").length ?? 0;
	const untracked = git?.files.filter((file) => file.kind === "untracked").length ?? 0;

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(""), 2500);
		return () => clearTimeout(timer);
	}, [notice]);

	const toggleOnly = () => {
		setOnlyChanges((value) => !value);
	};

	const snapshotNow = async () => {
		if (snapshotting) return;
		setSnapshotting(true);
		try {
			const step = await growth.snapshotNow();
			if (!step) setNotice(t.growthSnapshotNone);
		} catch (e) {
			onError(e instanceof Error ? e.message : "failed");
		} finally {
			setSnapshotting(false);
		}
	};

	const emptyText = !cwd || !hasSession ? t.growthNoSession : growth.loading && !steps.length ? t.growthLoading : !growth.available ? t.growthUnavailable : steps.length ? undefined : t.growthNoSteps;

	return (
		<div className="pw-project flex h-full min-h-0 flex-col" data-testid="project-panel">
			{/* 头部 */}
			<div className="flex items-center gap-1.5 px-3 pt-3 pb-1.5">
				<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, fontWeight: 600 }} title={cwd}>
					{workspaceName || t.projectPanel}
				</span>
				{hasSession && (
					<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.growthSnapshotNow} onClick={() => void snapshotNow()} disabled={snapshotting}>
						<IconRefreshOutline14 size={13} className={snapshotting ? "piweb-spin" : undefined} />
					</button>
				)}
				<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.close} onClick={onClose}>
					<IconCloseOutline14 size={13} />
				</button>
			</div>
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
			{/* 总计 + 范围 */}
			<div className="flex items-center gap-2 px-3 pb-2" style={{ fontSize: 11.5 }}>
				<span className="pw-seg" role="radiogroup">
					{(["step", "session"] as const).map((s) => (
						<button key={s} type="button" role="radio" aria-checked={growth.scope === s} data-active={growth.scope === s} onClick={() => growth.setScope(s)}>
							{s === "step" ? t.growthScopeStep : t.growthScopeSession}
						</button>
					))}
				</span>
				<span className="min-w-0 flex-1 truncate" style={{ color: "var(--dsw-label-caption)" }} title={`${t.growthStatA} ${totals.added} · ${t.growthStatM} ${totals.modified} · ${t.growthStatD} ${totals.deleted} · ${t.growthStatR} ${totals.renamed}`}>
					{notice ? (
						<span style={{ color: "var(--dsw-label-secondary)" }}>{notice}</span>
					) : (
						<>
							<span style={{ color: "var(--dsw-success)" }}>+{totals.added}</span>
							{" "}
							<span style={{ color: "var(--dsw-warn)" }}>~{totals.modified}</span>
							{" "}
							<span style={{ color: "var(--dsw-danger)" }}>−{totals.deleted}</span>
							{totals.renamed ? <span style={{ color: "var(--dsw-accent)" }}> ⇄{totals.renamed}</span> : null}
						</>
					)}
				</span>
				<button type="button" className="pw-chip" data-active={onlyChanges} aria-pressed={onlyChanges} onClick={toggleOnly}>
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
			{growth.selected?.truncated && growth.scope === "step" && (
				<div className="mx-3 mb-1 rounded-lg px-2 py-1" style={{ fontSize: 11, color: "var(--dsw-warn)", background: "var(--dsw-hover)" }}>
					{t.growthTruncated}
				</div>
			)}
			{selectedRound && !selectedRound.recorded && (
				<div className="mx-3 mb-1 rounded-lg px-2 py-1" style={{ fontSize: 11, color: "var(--dsw-label-caption)", background: "var(--dsw-hover)" }} role="status">
					{t.growthUnrecorded}
				</div>
			)}
			{/* 树 */}
			<GrowthTree
				tree={growth.tree}
				expanded={growth.expanded}
				fresh={growth.fresh}
				filter={filter}
				onlyChanges={onlyChanges && steps.length > 1}
				onToggleDir={growth.toggleDir}
				onExpandLazy={growth.expandLazy}
				onOpenFile={onOpenFile}
				onReference={onReference}
				onOpenEditor={onOpenEditor}
				emptyText={emptyText}
			/>
			{/* 轮次导航 */}
			{hasSession && (
				<div className="pw-timeline hairline-t" data-testid="growth-timeline">
					{/* 时间轴：每轮一根柱，高度 = 本轮快照步数，颜色 = 首步的主要动作；点柱选轮 */}
					{rounds.length > 0 && (
						<div ref={railRef} className="pw-tl-rail">
							{rounds.map((round) => {
								const activity = round.steps.filter((step) => step.kind !== "turn").length;
								const h = Math.max(4, Math.round((activity / maxSteps) * 24));
								const head = round.steps.find((step) => step.kind !== "turn") ?? round.last;
								return (
									<button
										key={round.id}
										type="button"
										className="pw-tl-bar"
										data-round={round.id}
										data-active={selectedRound?.id === round.id || undefined}
										style={{ height: h, background: head && round.recorded ? stepColor(head) : "var(--dsw-label-caption)" }}
										title={`${t.growthRoundLabel.replace("{n}", String(round.id))} · ${round.recorded ? activity ? stepTitle(head!, tt) : t.growthNoChangesRound : t.growthUnrecorded} · ${fmtTime(round.last?.ts ?? round.startedAt)} · ${t.growthStepsCount.replace("{n}", String(activity))}`}
										onClick={() => growth.selectRound(round.id)}
									/>
								);
							})}
						</div>
					)}
					<div className="flex items-center gap-1 px-2 pb-2 pt-1" style={{ fontSize: 11.5 }}>
						<button className="icon-btn" style={{ width: 20, height: 20 }} title={t.growthPrev} onClick={growth.prev} disabled={selectedIdx <= 0}>
							<IconChevronLeft14 size={12} />
						</button>
						<button className="icon-btn" style={{ width: 20, height: 20 }} title={t.growthNext} onClick={growth.next} disabled={selectedIdx < 0 || selectedIdx >= rounds.length - 1}>
							<IconChevronRight14 size={12} />
						</button>
						<span className="min-w-0 flex-1 truncate" style={{ color: "var(--dsw-label-secondary)" }} title={selectedRound ? `${roundLabel} · ${fmtTime(selectedRound.last?.ts ?? selectedRound.startedAt)}` : undefined}>
							{selectedRound ? (
								<>
									<span style={{ color: "var(--dsw-label-caption)" }}>{t.growthRoundPosition.replace("{current}", String(selectedIdx + 1)).replace("{total}", String(rounds.length))}</span> {roundLabel}
								</>
							) : t.growthRoundPosition.replace("{current}", "0").replace("{total}", "0")}
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
