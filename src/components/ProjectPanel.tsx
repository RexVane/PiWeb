"use client";

/**
 * 项目栏:右侧抽屉的「项目」入口(不再独占网格一列)。项目生长 = 每轮一个 git commit。
 * 头部：工作区名 + 立即记录 / 收起；所选轮：提问首行、时间、文件数与行数、在对话里看；
 * 工具行：范围（本轮 / 本会话累计）、只看改动、筛选；中间：项目树（GrowthTree）；
 * 底部：时间轴每轮一根柱（高度 = 改动行数，灰色细柱 = 你在两轮之间自己的修改），默认不再跟随,底部计数可点开轮数列表跳到任意一轮。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GrowthTree } from "@/components/GrowthTree";
import { IconChevronLeft14, IconChevronRight14, IconCloseOutline14, IconGitOutline16, IconRefreshOutline14, IconSearchOutline16 } from "@/components/icons";
import type { GrowthApi, GrowthEntry } from "@/hooks/useGrowth";
import { useI18n } from "@/i18n";
import type { GitInfo } from "@/lib/git-service";
import type { TreeNode } from "@/lib/growth-tree";
import type { GrowthChange, GrowthConsentRequest } from "@/lib/types";

/**
 * 「要不要在这个工作区建 git 仓库」：工作区还不是仓库根目录时，生长记录第一次提交前问一次。
 * 关掉（Esc / 点遮罩外）不算回答，下次打开会话还会再问；只有两个按钮会被记住。
 */
export function GrowthConsentDialog({ request, onAnswer }: { request: GrowthConsentRequest; onAnswer: (allow: boolean) => void }) {
	const { t } = useI18n();
	const [dismissed, setDismissed] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		setDismissed(false);
		ref.current?.focus();
	}, [request.cwd, request.reason]);
	if (dismissed) return null;
	const body = request.reason === "nested" ? t.growthConsentNested.replace("{parent}", request.parent ?? "") : t.growthConsentNotGit;
	return (
		<div
			ref={ref}
			tabIndex={-1}
			className="fixed inset-0 z-[120] flex items-center justify-center"
			style={{ background: "var(--dsw-mask)" }}
			role="dialog"
			aria-modal="true"
			aria-label={t.growthConsentTitle}
			data-testid="growth-consent-dialog"
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape") setDismissed(true);
			}}
		>
			<div className="popover flex w-[min(92vw,480px)] flex-col gap-3 p-5" style={{ background: "var(--dsw-glass-modal)" }}>
				<div className="flex items-start gap-2.5">
					<span className="flex flex-none items-center justify-center rounded-lg" style={{ width: 30, height: 30, background: "var(--dsw-hover)" }}>
						<IconGitOutline16 size={16} style={{ color: "var(--dsw-label-secondary)" }} />
					</span>
					<div className="min-w-0 flex-1">
						<div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.4 }}>{t.growthConsentTitle}</div>
						<div className="mt-0.5 truncate" style={{ fontSize: 11, color: "var(--dsw-label-caption)", fontFamily: "var(--font-mono)" }} title={request.cwd}>{request.cwd}</div>
					</div>
				</div>
				<div className="rounded-xl px-3 py-2.5" style={{ fontSize: 12.5, color: "var(--dsw-label-secondary)", lineHeight: 1.55, background: "var(--dsw-hover)" }}>
					{body}
					<div className="mt-1.5" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{t.growthConsentNote}</div>
				</div>
				<div className="flex justify-end gap-2">
					<button className="btn-outline" style={{ height: 32 }} onClick={() => onAnswer(false)}>{t.growthConsentDecline}</button>
					<button className="btn-primary-white" style={{ height: 32 }} onClick={() => onAnswer(true)}>{t.growthConsentAllow}</button>
				</div>
			</div>
		</div>
	);
}

/** 「第 7 轮 · 把保存按钮改成红色」/「你的修改」 */
export function roundTitle(round: GrowthEntry, t: Record<string, string>): string {
	if (round.kind !== "round") return t.growthKindUser;
	const label = t.growthRoundLabel.replace("{n}", String(round.n ?? ""));
	// 修好之前记下的轮次，标题是技能展开的首行 `<skill name="x" location="…">`：显示成 /skill:x
	const title = round.title?.replace(/^<skill\s[^>]*?\bname="([^"]+)"[^>]*>$/, "/skill:$1");
	return title ? `${label} · ${title}` : label;
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

/** 这一轮有没有实际改动（轮次列表据此把没改动的轮降成次要色，改过的才显示 +/− 行数） */
function hasChanges(round: GrowthEntry): boolean {
	const st = round.stats;
	return Boolean(st.added || st.modified || st.deleted || st.renamed || st.add || st.del);
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
	/** 轮数列表(底部计数点开) */
	const [roundPickerOpen, setRoundPickerOpen] = useState(false);
	/** 列表顶部「输入轮号...」已就地把那一行变成输入框 */
	const [jumpEditing, setJumpEditing] = useState(false);
	const [jumpValue, setJumpValue] = useState("");
	const roundPickerRef = useRef<HTMLDivElement>(null);
	const roundListRef = useRef<HTMLDivElement>(null);
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

	const totals = useMemo(() => {
		if (selected && growth.scope === "round") {
			const st = selected.stats;
			return { files: st.added + st.modified + st.deleted + st.renamed, add: st.add, del: st.del };
		}
		return growth.changesReady === false ? null : sumChanges(growth.changes);
	}, [selected, growth.scope, growth.changes, growth.changesReady]);
	const piRounds = useMemo(() => rounds.filter((round) => round.kind === "round").length, [rounds]);
	const maxLines = useMemo(() => Math.max(1, ...rounds.map(changedLines)), [rounds]);
	const railRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!selected) return;
		railRef.current?.querySelector<HTMLElement>(`[data-commit="${selected.commit}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [selected]);
	const selectedIdx = selected ? rounds.findIndex((round) => round.commit === selected.commit) : -1;

	// 轮数列表:打开时自动滚到当前轮;Esc / 点外部关闭
	useEffect(() => {
		if (!roundPickerOpen) {
			setJumpEditing(false);
			setJumpValue("");
			return;
		}
		requestAnimationFrame(() => {
			roundListRef.current?.querySelector('[data-selected]')?.scrollIntoView({ block: "center" });
		});
		const onPointerDown = (e: MouseEvent) => {
			if (!roundPickerRef.current?.contains(e.target as Node)) setRoundPickerOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setRoundPickerOpen(false);
			}
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [roundPickerOpen]);
	/** 跳到第 n 轮(轮号从 1 起,只数 pi 的轮次);越界夹到有效范围,非法输入不跳 */
	const jumpToRound = (raw: string) => {
		const parsed = Number.parseInt(raw.trim(), 10);
		if (Number.isNaN(parsed) || piRounds === 0) return;
		const n = Math.max(1, Math.min(piRounds, parsed));
		const round = rounds.find((item) => item.n === n);
		if (!round) return;
		growth.select(round.commit);
		setRoundPickerOpen(false);
	};
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

	// 项目面板现在是抽屉的一个入口(不再独占网格一列):.pw-project 自带的右描边在抽屉里
	// 会变成贴在窗口最右边的一条多余发丝线,所以这里去掉;背景沿用侧栏填充色即可。
	return (
		<div className="pw-project flex h-full min-h-0 flex-1 flex-col" style={{ borderRight: "none" }} data-testid="project-panel">
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
						{growth.scope === "session" && <span>{t.growthScopeSession}</span>}
						{totals ? <>
							<span>{t.growthRoundFiles.replace("{n}", String(totals.files))}</span>
							<span style={{ color: "var(--dsw-success)" }}>+{totals.add}</span>
							<span style={{ color: "var(--dsw-danger)" }}>−{totals.del}</span>
						</> : <span>—</span>}
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
										title={`${roundTitle(round, tt)} · ${fmtTime(round.ts)} · ${t.growthRoundFiles.replace("{n}", String(round.stats.added + round.stats.modified + round.stats.deleted + round.stats.renamed))} +${round.stats.add} −${round.stats.del}`}
										aria-label={`${roundTitle(round, tt)} · ${t.growthRoundFiles.replace("{n}", String(round.stats.added + round.stats.modified + round.stats.deleted + round.stats.renamed))} +${round.stats.add} −${round.stats.del}`}
										onClick={() => growth.select(round.commit)}
									/>
								);
							})}
							{running && <span className="pw-tl-bar" data-running="" title={t.growthRunning} aria-label={t.growthRunning} />}
						</div>
					)}
					<div className="flex items-center gap-1 px-2 pb-2 pt-1" style={{ fontSize: 11.5 }}>
						<button className="icon-btn" style={{ width: 20, height: 20 }} title={t.growthPrev} aria-label={t.growthPrev} onClick={growth.prev} disabled={selectedIdx <= 0}>
							<IconChevronLeft14 size={12} />
						</button>
						<button className="icon-btn" style={{ width: 20, height: 20 }} title={t.growthNext} aria-label={t.growthNext} onClick={growth.next} disabled={selectedIdx < 0 || selectedIdx >= rounds.length - 1}>
							<IconChevronRight14 size={12} />
						</button>
						{/* 计数可点开轮数列表:单击直接弹列表(不做双击变输入框,避免 250ms 单双击
						    判定拖慢弹出);「输入轮号」是列表里一个固定入口,选中后当场变数字输入框 */}
						<div className="relative min-w-0 flex-1">
							<button
								type="button"
								className="w-full truncate rounded px-1 text-left"
								style={{ color: "var(--dsw-label-secondary)", background: roundPickerOpen ? "var(--dsw-active)" : undefined }}
								title={t.growthPickRound}
								aria-haspopup="listbox"
								aria-expanded={roundPickerOpen}
								data-testid="growth-round-picker"
								onClick={() => setRoundPickerOpen((v) => !v)}
							>
								{selected?.n
									? t.growthRoundPosition.replace("{current}", String(selected.n)).replace("{total}", String(piRounds))
									: selected
										? t.growthKindUser
										: t.growthRoundPosition.replace("{current}", "0").replace("{total}", String(piRounds))}
							</button>
							{roundPickerOpen && (
								<div
									ref={roundPickerRef}
									className="popover absolute bottom-7 left-0 z-50 flex w-[268px] max-w-[calc(100vw-24px)] flex-col"
									role="listbox"
									aria-label={t.growthPickRound}
									data-testid="growth-round-list"
								>
									{/* 「输入轮号」入口固定在最上面:选中后它自己变成数字输入框 */}
									{jumpEditing ? (
										<div className="px-1.5 pb-1">
											<input
												autoFocus
												value={jumpValue}
												inputMode="numeric"
												placeholder={t.growthRoundJump}
												title={t.growthRoundJumpHint}
												data-testid="growth-round-input"
												className="w-full rounded-md px-1.5 py-1"
												style={{ fontSize: 12.5, background: "var(--dsw-hover)" }}
												onChange={(e) => setJumpValue(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														e.preventDefault();
														jumpToRound(jumpValue);
													}
												}}
											/>
										</div>
									) : (
										<button
											type="button"
											className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors"
											style={{ fontSize: 12.5, color: "var(--dsw-label-secondary)" }}
											onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
											onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
											data-testid="growth-round-jump"
											onClick={() => {
												setJumpValue("");
												setJumpEditing(true);
											}}
										>
											{t.growthRoundJump}
										</button>
									)}
									{/* 轮次列表:当前轮高亮,打开时自动滚到它 */}
									<div ref={roundListRef} className="min-h-0 max-h-[260px] overflow-y-auto border-t pt-1" style={{ borderColor: "var(--dsw-border-l1)" }}>
										{rounds.map((round) => {
											const changed = hasChanges(round);
											// 没改动的轮整行降对比度，扫视时自然被跳过；选中的那行不灰（否则像被禁用）
											const dimmed = !changed && selected?.commit !== round.commit;
											return (
												<button
													key={round.commit}
													type="button"
													role="option"
													aria-selected={selected?.commit === round.commit}
													data-selected={selected?.commit === round.commit || undefined}
													className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors"
													style={{ background: selected?.commit === round.commit ? "var(--dsw-active)" : "transparent", ...(dimmed ? { opacity: 0.45 } : {}) }}
													onMouseEnter={(e) => {
														if (selected?.commit !== round.commit) e.currentTarget.style.background = "var(--dsw-hover)";
													}}
													onMouseLeave={(e) => {
														if (selected?.commit !== round.commit) e.currentTarget.style.background = "transparent";
													}}
													title={`${roundTitle(round, tt)} · ${fmtTime(round.ts)}`}
													onClick={() => {
														growth.select(round.commit);
														setRoundPickerOpen(false);
													}}
												>
													<span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5 }}>{roundTitle(round, tt)}</span>
													{changed && (round.stats.add > 0 || round.stats.del > 0) ? (
														<span className="flex-none" style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>
															<span style={{ color: "var(--dsw-success)" }}>+{round.stats.add}</span> <span style={{ color: "var(--dsw-danger)" }}>−{round.stats.del}</span>
														</span>
													) : null}
													<span className="flex-none" style={{ fontSize: 11, color: "var(--dsw-label-caption)" }}>{fmtTime(round.ts)}</span>
												</button>
											);
										})}
									</div>
								</div>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
