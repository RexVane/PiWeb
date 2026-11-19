"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
	IconChatBubbleOutline16,
	IconChevronDown14,
	IconClockOutline16,
	IconEditOutline16,
	IconPlusOutline16,
	IconRefreshOutline14,
	IconSearchOutline16,
} from "@/components/icons";
import { useI18n } from "@/i18n";
import { htmlLangOf, type Lang } from "@/lib/lang";
import { describeSchedule } from "@/lib/automations/schedule";
import type { AutomationRun, AutomationTask, AutomationsStateSnapshot } from "@/lib/automations/types";
import { AutomationModal, type ModelChoiceItem } from "./AutomationModal";
import { WorkspaceViewShell } from "./WorkspaceViewShell";

type AutomationFilterTab = "active" | "paused" | "ended" | "all" | "runs";

function sameWorkspacePath(left: string, right: string): boolean {
	const norm = (value: string) => {
		const clean = value.replace(/\\/g, "/").replace(/\/+$/, "");
		return /^[A-Za-z]:\//.test(clean) || clean.startsWith("//") ? clean.toLowerCase() : clean;
	};
	return Boolean(left && right) && norm(left) === norm(right);
}

function taskLifecycle(task: AutomationTask): "active" | "paused" | "ended" {
	if (!task.enabled) return "paused";
	if (task.nextRunAt === null) return "ended";
	return "active";
}

function formatTimestamp(ms: number | undefined | null, lang: Lang, fallback: string): string {
	if (!ms) return fallback;
	return new Intl.DateTimeFormat(htmlLangOf(lang), {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(ms));
}

function StatusBadge({ status, enabled }: { status?: AutomationRun["status"]; enabled?: boolean }) {
	const { t } = useI18n();
	if (enabled === false) {
		return (
			<span
				className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
				style={{ fontSize: "var(--dsh-ui-font-2xs)", background: "var(--dsw-hover)", color: "var(--dsw-label-caption)" }}
			>
				<span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--dsw-label-tertiary)" }} />
				{t.autoStatusPaused}
			</span>
		);
	}
	if (status === "running") {
		return (
			<span
				className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
				style={{
					fontSize: "var(--dsh-ui-font-2xs)",
					background: "color-mix(in srgb, var(--dsw-label-primary) 12%, transparent)",
					color: "var(--dsw-label-primary)",
				}}
			>
				<span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "var(--dsw-label-primary)" }} />
				{t.autoStatusRunning}
			</span>
		);
	}
	if (status === "success") {
		return (
			<span
				className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
				style={{
					fontSize: "var(--dsh-ui-font-2xs)",
					background: "color-mix(in srgb, var(--dsw-success) 14%, transparent)",
					color: "var(--dsw-success)",
				}}
			>
				<span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--dsw-success)" }} />
				{t.autoStatusSuccess}
			</span>
		);
	}
	if (status === "error") {
		return (
			<span
				className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
				style={{
					fontSize: "var(--dsh-ui-font-2xs)",
					background: "color-mix(in srgb, var(--dsw-danger) 14%, transparent)",
					color: "var(--dsw-danger)",
				}}
			>
				<span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--dsw-danger)" }} />
				{t.autoStatusError}
			</span>
		);
	}
	return null;
}

export function AutomationsWorkspaceView({
	knownCwds,
	defaultCwd,
	getWorkspaceName: rawGetWorkspaceName,
	models,
	onOpenSession,
	onCreateInSession,
	onDefaultCwdChange,
}: {
	knownCwds: string[];
	defaultCwd: string;
	getWorkspaceName: (cwd: string) => string;
	models: ModelChoiceItem[];
	onOpenSession: (sessionPath: string) => void;
	onCreateInSession?: (cwd: string, prefillText: string) => void;
	onDefaultCwdChange?: (cwd: string) => void;
}) {
	const [automationDefaultCwd, setAutomationDefaultCwd] = useState("");
	const { t: uiT } = useI18n();
	const getWorkspaceName = useCallback(
		(dir: string) => {
			if (automationDefaultCwd && sameWorkspacePath(dir, automationDefaultCwd)) {
				return uiT.autoWorkspaceName;
			}
			return rawGetWorkspaceName(dir);
		},
		[automationDefaultCwd, rawGetWorkspaceName, uiT.autoWorkspaceName],
	);
	const { t, lang } = useI18n();
	const { confirm, confirmDialog } = useConfirmDialog();

	const [tasks, setTasks] = useState<AutomationTask[]>([]);
	const [runs, setRuns] = useState<AutomationRun[]>([]);
	const [activeTaskIds, setActiveTaskIds] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [storeError, setStoreError] = useState<AutomationsStateSnapshot["storeError"]>(undefined);
	const [tab, setTab] = useState<AutomationFilterTab>("active");
	const [query, setQuery] = useState("");
	const [newMenuOpen, setNewMenuOpen] = useState(false);
	const newMenuRef = useRef<HTMLDivElement>(null);
	const [modalOpen, setModalOpen] = useState(false);
	const [editingTask, setEditingTask] = useState<AutomationTask | null>(null);
	const [busyTaskIds, setBusyTaskIds] = useState<Set<string>>(new Set());
	const busyTaskIdsRef = useRef(new Set<string>());
	const mutationCountRef = useRef(0);
	const refreshNeededRef = useRef(false);
	const loadSeqRef = useRef(0);
	const mountedRef = useRef(false);

	const load = useCallback(async (preserveError = false) => {
		if (mutationCountRef.current > 0) return;
		const loadSeq = ++loadSeqRef.current;
		try {
			const res = await fetch("/api/automations", { cache: "no-store" });
			const json = await res.json();
			if (!mountedRef.current || loadSeq !== loadSeqRef.current) return;
			if (!json.success) {
				setError(json.error || t.toastError);
				return;
			}
			if (!preserveError) setError(null);
			const nextDefaultCwd = json.data.defaultCwd ?? "";
			setAutomationDefaultCwd(nextDefaultCwd);
			if (nextDefaultCwd) onDefaultCwdChange?.(nextDefaultCwd);
			setStoreError(json.data.storeError);
			setTasks(json.data.tasks ?? []);
			setRuns(json.data.runs ?? []);
			setActiveTaskIds(new Set(json.data.activeTaskIds ?? []));
		} catch (err: any) {
			if (mountedRef.current && loadSeq === loadSeqRef.current) setError(String(err?.message ?? t.toastError));
		} finally {
			if (mountedRef.current && loadSeq === loadSeqRef.current) setLoading(false);
		}
	}, [t.toastError, onDefaultCwdChange]);

	const hasActiveRuns = activeTaskIds.size > 0 || runs.some((r) => r.status === "running");

	useEffect(() => {
		mountedRef.current = true;
		void load();
		return () => {
			mountedRef.current = false;
			loadSeqRef.current += 1;
		};
	}, [load]);

	useEffect(() => {
		const interval = setInterval(() => void load(), hasActiveRuns ? 2500 : 15000);
		return () => clearInterval(interval);
	}, [load, hasActiveRuns]);

	useEffect(() => {
		if (!newMenuOpen) return;
		const onDown = (e: MouseEvent) => {
			if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
				setNewMenuOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setNewMenuOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [newMenuOpen]);

	const openCreateModal = useCallback(() => {
		setEditingTask(null);
		setModalOpen(true);
	}, []);

	const handleCreateInChat = useCallback(() => {
		const target = automationDefaultCwd || defaultCwd || knownCwds[0] || "";
		if (onCreateInSession) {
			onCreateInSession(target, t.autoInChatPrefill);
		} else {
			openCreateModal();
		}
	}, [automationDefaultCwd, defaultCwd, knownCwds, onCreateInSession, t.autoInChatPrefill, openCreateModal]);

	const taskCounts = useMemo(() => {
		let active = 0;
		let paused = 0;
		let ended = 0;
		for (const task of tasks) {
			const life = taskLifecycle(task);
			if (life === "active") active += 1;
			else if (life === "paused") paused += 1;
			else ended += 1;
		}
		return { active, paused, ended, all: tasks.length };
	}, [tasks]);

	const deferredQuery = useDeferredValue(query);
	const q = deferredQuery.trim().toLowerCase();
	const filteredTasks = useMemo(
		() =>
			tasks.filter((task) => {
				if (tab !== "all" && tab !== "runs" && taskLifecycle(task) !== tab) return false;
				if (!q) return true;
				const wsName = (getWorkspaceName(task.cwd) || "").toLowerCase();
				return (
					task.name.toLowerCase().includes(q)
					|| task.prompt.toLowerCase().includes(q)
					|| task.cwd.toLowerCase().includes(q)
					|| wsName.includes(q)
				);
			}),
		[tasks, tab, q, getWorkspaceName],
	);
	const filteredRuns = useMemo(
		() =>
			runs.filter((run) => {
				if (!q) return true;
				const wsName = (getWorkspaceName(run.cwd) || "").toLowerCase();
				return (
					run.taskName.toLowerCase().includes(q)
					|| run.cwd.toLowerCase().includes(q)
					|| wsName.includes(q)
					|| (run.summary?.toLowerCase().includes(q) ?? false)
					|| (run.error?.toLowerCase().includes(q) ?? false)
				);
			}),
		[runs, q, getWorkspaceName],
	);

	const postAction = async (body: Record<string, unknown>) => {
		setError(null);
		loadSeqRef.current += 1;
		mutationCountRef.current += 1;
		let succeeded = false;
		try {
			const res = await fetch("/api/automations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const json = await res.json();
			if (!json.success) {
				if (mountedRef.current) setError(json.error || t.toastError);
				return false;
			}
			succeeded = true;
			refreshNeededRef.current = true;
			return true;
		} catch (err: unknown) {
			if (mountedRef.current) setError(err instanceof Error ? err.message : t.toastError);
			return false;
		} finally {
			mutationCountRef.current -= 1;
			if (mountedRef.current && mutationCountRef.current === 0 && refreshNeededRef.current) {
				refreshNeededRef.current = false;
				await load(!succeeded);
			}
		}
	};

	const performTaskAction = async (task: AutomationTask, action: "toggle" | "runNow" | "delete" | "stop") => {
		if (busyTaskIdsRef.current.has(task.id)) return;
		busyTaskIdsRef.current.add(task.id);
		setBusyTaskIds(new Set(busyTaskIdsRef.current));
		try {
			if (action === "delete") {
				const confirmed = await confirm({ title: t.delete, message: t.autoConfirmDelete.replace("{name}", task.name), confirmLabel: t.delete });
				if (!confirmed || !mountedRef.current) return;
			}
			await postAction({ action, id: task.id, ...(action === "toggle" ? { enabled: !task.enabled } : {}) });
		} finally {
			busyTaskIdsRef.current.delete(task.id);
			if (mountedRef.current) setBusyTaskIds(new Set(busyTaskIdsRef.current));
		}
	};

	const emptyMessage = useMemo(() => {
		if (q) return t.autoEmptyFiltered;
		if (tasks.length === 0 && knownCwds.length === 0 && !onCreateInSession) return t.autoNeedWorkspace;
		if (tab === "paused") return t.autoEmptyPaused;
		if (tab === "ended") return t.autoEmptyEnded;
		if (tab === "all") return t.autoEmptyTitle;
		return t.autoEmptyActive;
	}, [q, tasks.length, knownCwds.length, onCreateInSession, tab, t]);

	return (
		<WorkspaceViewShell
			title={t.navAutomations}
			description={t.autoPageDesc}
			icon={<IconClockOutline16 size={16} />}
			actions={
				<div className="flex items-center gap-2">
					<button
						type="button"
						className="icon-btn"
						title={t.panelRefresh}
						aria-label={t.panelRefresh}
						onClick={() => void load()}
						style={{ width: 32, height: 32 }}
					>
						<IconRefreshOutline14 size={14} />
					</button>
					<div ref={newMenuRef} className="relative inline-flex items-stretch">
						<div
							className="inline-flex h-9 items-stretch overflow-hidden rounded-full"
							style={{
								background: "var(--dsw-label-primary)",
								color: "var(--dsw-bg-base)",
								boxShadow: "0 2px 8px rgba(0, 0, 0, 0.14)",
							}}
						>
							<button
								type="button"
								disabled={knownCwds.length === 0 && !onCreateInSession}
								title={knownCwds.length === 0 && !onCreateInSession ? t.autoNeedWorkspace : t.autoCreateInChat}
								onClick={() => handleCreateInChat()}
								className="inline-flex items-center gap-1.5 font-medium transition-opacity hover:opacity-90 disabled:opacity-45"
								style={{
									padding: "0 12px 0 14px",
									height: "100%",
									fontSize: "var(--dsh-ui-font-135)",
									color: "var(--dsw-bg-base)",
									background: "transparent",
								}}
							>
								<IconPlusOutline16 size={14} />
								<span>{t.autoNewShort}</span>
							</button>
							<span aria-hidden="true" style={{ width: 1, background: "color-mix(in srgb, var(--dsw-bg-base) 22%, transparent)" }} />
							<button
								type="button"
								aria-label={t.autoNew}
								aria-expanded={newMenuOpen}
								aria-haspopup="menu"
								onClick={() => setNewMenuOpen((open) => !open)}
								className="inline-flex items-center justify-center transition-opacity hover:opacity-90"
								style={{
									width: 32,
									height: "100%",
									color: "var(--dsw-bg-base)",
									background: "transparent",
								}}
							>
								<IconChevronDown14 size={12} />
							</button>
						</div>
						{newMenuOpen && (
							<div
								role="menu"
								className="popover absolute right-0 top-11 z-40 w-max min-w-[168px] p-1.5 shadow-xl"
							>
								<button
									type="button"
									role="menuitem"
									disabled={knownCwds.length === 0 && !onCreateInSession}
									className="isx-menu-item flex w-full items-center gap-2.5 rounded-lg text-left disabled:opacity-45"
									style={{ fontSize: "var(--dsh-ui-font-sm)", padding: "8px 12px", color: "var(--dsw-label-primary)" }}
									onClick={() => {
										setNewMenuOpen(false);
										handleCreateInChat();
									}}
								>
									<span className="isx-menu-icon shrink-0" style={{ display: "inline-flex" }}>
										<IconChatBubbleOutline16 size={15} />
									</span>
									<span className="isx-menu-shift whitespace-nowrap">{t.autoCreateInChat}</span>
								</button>
								<button
									type="button"
									role="menuitem"
									disabled={knownCwds.length === 0}
									title={knownCwds.length === 0 ? t.autoNeedWorkspace : undefined}
									className="isx-menu-item flex w-full items-center gap-2.5 rounded-lg text-left disabled:opacity-45"
									style={{ fontSize: "var(--dsh-ui-font-sm)", padding: "8px 12px", color: "var(--dsw-label-primary)" }}
									onClick={() => {
										setNewMenuOpen(false);
										openCreateModal();
									}}
								>
									<span className="isx-menu-icon shrink-0" style={{ display: "inline-flex" }}>
										<IconEditOutline16 size={15} />
									</span>
									<span className="isx-menu-shift whitespace-nowrap">{t.autoCreateManual}</span>
								</button>
							</div>
						)}
					</div>
				</div>
			}
		>
			<div className="flex flex-col gap-4">
				{storeError && <div role="alert" className="rounded-lg px-3.5 py-2.5" style={{ color: "var(--dsw-danger)" }}>
					<p>{storeError.message}</p>
					<button type="button" className="btn-outline" onClick={() => void (async () => {
						if (await confirm({ title: t.automationRepair, message: t.automationRepairHint, confirmLabel: t.automationRepair })) await postAction({ action: "repairStore", expectedHash: storeError.expectedHash, mode: storeError.canSalvage ? "salvage" : storeError.canRestore ? "restore" : "reset" });
					})()}>{t.automationRepair}</button>
				</div>}
				{error && (
					<div
						role="alert"
						className="rounded-lg px-3.5 py-2.5"
						style={{
							fontSize: "var(--dsh-ui-font-125)",
							background: "color-mix(in srgb, var(--dsw-danger) 12%, transparent)",
							border: "0.5px solid color-mix(in srgb, var(--dsw-danger) 35%, transparent)",
							color: "var(--dsw-danger)",
						}}
					>
						{error}
					</div>
				)}

				<div className="flex flex-wrap items-center gap-1.5" role="tablist">
					{(
						[
							{ id: "active", label: t.autoFilterActive, count: taskCounts.active },
							{ id: "paused", label: t.autoFilterPaused, count: taskCounts.paused },
							{ id: "ended", label: t.autoFilterEnded, count: taskCounts.ended },
							{ id: "all", label: t.autoFilterAll, count: taskCounts.all },
						] as const
					).map((item) => {
						const active = tab === item.id;
						return (
							<button
								key={item.id}
								type="button"
								role="tab"
								aria-selected={active}
								data-active={active}
								onClick={() => setTab(item.id)}
								className="rounded-lg transition-colors"
								style={{
									padding: "6px 12px",
									fontSize: "var(--dsh-ui-font-sm)",
									fontWeight: active ? 500 : 400,
									background: active ? "var(--dsw-active)" : "transparent",
									color: active ? "var(--dsw-label-primary)" : "var(--dsw-label-tertiary)",
								}}
							>
								<span>{item.label}</span>
								{item.count > 0 && (
									<span className="ml-1.5 tabular-nums opacity-70" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))" }}>
										{item.count}
									</span>
								)}
							</button>
						);
					})}
					<button
						type="button"
						role="tab"
						aria-selected={tab === "runs"}
						data-active={tab === "runs"}
						onClick={() => setTab("runs")}
						className="ml-auto rounded-lg transition-colors"
						style={{
							padding: "6px 12px",
							fontSize: "var(--dsh-ui-font-sm)",
							fontWeight: tab === "runs" ? 500 : 400,
							background: tab === "runs" ? "var(--dsw-active)" : "transparent",
							color: tab === "runs" ? "var(--dsw-label-primary)" : "var(--dsw-label-tertiary)",
						}}
					>
						{t.autoRunsTab} ({filteredRuns.length})
					</button>
				</div>

				<div className="isx-search relative">
					<IconSearchOutline16
						size={15}
						className="isx-search-icon pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2"
						style={{ color: "var(--dsw-label-caption)" }}
					/>
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t.autoSearchPlaceholder}
						aria-label={t.autoSearchPlaceholder}
						className="w-full rounded-lg outline-none"
						style={{
							minHeight: 38,
							height: "max(38px, calc(38px + var(--dsh-content-font-delta)))",
							paddingLeft: 36,
							paddingRight: 12,
							fontSize: "var(--dsh-ui-font-sm)",
							background: "var(--dsw-bg-elevated, transparent)",
							border: "0.5px solid var(--dsw-border-l2)",
							color: "var(--dsw-label-primary)",
						}}
					/>
				</div>

				{tab !== "runs" && (
					<div className="flex flex-col gap-3">
						{!loading && filteredTasks.length === 0 && (
							<div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
								<span
									className="flex items-center justify-center rounded-xl"
									style={{
										width: 44,
										height: 44,
										background: "var(--dsw-hover)",
										color: "var(--dsw-label-caption)",
									}}
								>
									<IconClockOutline16 size={22} />
								</span>
								<div style={{ fontSize: "var(--dsh-ui-font-135)", color: "var(--dsw-label-tertiary)" }}>
									{emptyMessage}
								</div>
								{!q && (knownCwds.length > 0 || onCreateInSession) && (
									<button
										type="button"
										onClick={() => handleCreateInChat()}
										className="mt-1 rounded-lg transition-colors hover:opacity-85"
										style={{
											padding: "7px 14px",
											fontSize: "var(--dsh-ui-font-sm)",
											fontWeight: 500,
											border: "0.5px solid var(--dsw-border-l2)",
											background: "var(--dsw-hover)",
											color: "var(--dsw-label-primary)",
										}}
									>
										{t.autoNewCta}
									</button>
								)}
							</div>
						)}

						{filteredTasks.map((task) => {
							const isRunning = activeTaskIds.has(task.id) || task.lastRunStatus === "running";
							const busy = busyTaskIds.has(task.id);
							return (
								<div
									key={task.id}
									className="rounded-lg px-4 py-3.5"
									style={{
										border: "0.5px solid var(--dsw-border-l2)",
										opacity: task.enabled ? 1 : 0.78,
									}}
								>
									<div className="flex items-start gap-3">
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<span style={{ fontSize: "calc(14.5px + var(--dsh-content-font-delta))", fontWeight: 600, color: "var(--dsw-label-primary)" }}>
													{task.name}
												</span>
												<StatusBadge
													status={isRunning ? "running" : task.lastRunStatus}
													enabled={task.enabled}
												/>
												<span
													className="rounded-full px-2 py-0.5"
													style={{
														fontSize: "var(--dsh-ui-font-2xs)",
														background: "var(--dsw-hover)",
														color: "var(--dsw-label-tertiary)",
													}}
													title={task.cwd}
												>
													{getWorkspaceName(task.cwd) || task.cwd}
												</span>
												{task.model && (
													<span
														className="rounded-full px-2 py-0.5"
														style={{
															fontSize: "var(--dsh-ui-font-2xs)",
															fontFamily: "var(--font-mono)",
															background: "var(--dsw-hover)",
															color: "var(--dsw-label-tertiary)",
														}}
													>
														{task.model.provider}/{task.model.id}
													</span>
												)}
											</div>

											<p
												className="mt-1.5 line-clamp-2 whitespace-pre-wrap"
												style={{ fontSize: "var(--dsh-ui-font-125)", color: "var(--dsw-label-secondary)", lineHeight: 1.5 }}
											>
												{task.prompt}
											</p>

											<div
												className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1"
												style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))", color: "var(--dsw-label-caption)" }}
											>
												<span>{describeSchedule(task.schedule, lang)}</span>
												<span>
													{t.autoNextRun}:{" "}
													{!task.enabled
														? t.autoStatusPaused
														: task.nextRunAt === null
															? t.autoScheduleUnavailable
															: formatTimestamp(task.nextRunAt, lang, "—")}
												</span>
												<span>
													{t.autoLastRun}: {formatTimestamp(task.lastRunAt, lang, t.autoNever)}
												</span>
											</div>
										</div>

										<button
											type="button"
											className="liq-sw mt-0.5 flex-none"
											data-on={task.enabled ? "true" : undefined}
											role="switch"
											aria-checked={task.enabled}
											aria-label={task.name}
											disabled={busy}
											onClick={() => void performTaskAction(task, "toggle")}
										>
											<span className="liq-thumb" />
										</button>
									</div>

									<div className="hairline-t mt-3 flex flex-wrap items-center gap-2 pt-2.5">
										<button
											type="button"
											className="btn-outline"
											style={{ height: "max(28px, calc(28px + var(--dsh-content-font-delta)))", fontSize: "var(--dsh-ui-font-xs)", padding: "0 10px" }}
											disabled={busy || isRunning}
											onClick={() => void performTaskAction(task, "runNow")}
										>
											{isRunning ? t.autoStatusRunning : t.autoRunNow}
										</button>
										{isRunning && <button type="button" className="btn-outline" disabled={busy} onClick={() => void performTaskAction(task, "stop")}>{t.stop}</button>}
										{task.lastSessionPath && (
											<button
												type="button"
												className="btn-outline"
												style={{ height: "max(28px, calc(28px + var(--dsh-content-font-delta)))", fontSize: "var(--dsh-ui-font-xs)", padding: "0 10px" }}
												onClick={() => onOpenSession(task.lastSessionPath!)}
											>
												{t.autoOpenSession}
											</button>
										)}
										<div className="flex-1" />
										<button
											type="button"
											className="rounded-lg transition-colors hover:opacity-80"
											style={{ fontSize: "var(--dsh-ui-font-xs)", padding: "4px 10px", color: "var(--dsw-label-secondary)" }}
											disabled={busy}
											onClick={() => {
												setEditingTask(task);
												setModalOpen(true);
											}}
										>
											{t.autoEdit}
										</button>
										<button
											type="button"
											className="rounded-lg transition-colors hover:opacity-80"
											style={{ fontSize: "var(--dsh-ui-font-xs)", padding: "4px 10px", color: "var(--dsw-danger)" }}
											disabled={busy || isRunning}
											onClick={() => void performTaskAction(task, "delete")}
										>
											{t.delete}
										</button>
									</div>
								</div>
							);
						})}
					</div>
				)}

				{tab === "runs" && (
					<div className="flex flex-col gap-2.5">
						{!loading && filteredRuns.length === 0 && (
							<div
								className="rounded-lg px-6 py-12 text-center"
								style={{ fontSize: "var(--dsh-ui-font-sm)", color: "var(--dsw-label-caption)", border: "0.5px solid var(--dsw-border-l2)" }}
							>
								{q ? t.autoEmptyFiltered : t.autoRunsEmpty}
							</div>
						)}

						{filteredRuns.map((run) => (
							<div
								key={run.id}
								className="flex flex-col gap-2 rounded-lg px-4 py-3"
								style={{ border: "0.5px solid var(--dsw-border-l2)" }}
							>
								<div className="flex flex-wrap items-center gap-2">
									<span style={{ fontSize: "var(--dsh-ui-font-135)", fontWeight: 500, color: "var(--dsw-label-primary)" }}>
										{run.taskName}
									</span>
									<StatusBadge status={run.status} />
									<span
										className="rounded-full px-2 py-0.5"
										style={{ fontSize: "var(--dsh-ui-font-2xs)", background: "var(--dsw-hover)", color: "var(--dsw-label-tertiary)" }}
									>
										{run.trigger === "manual" ? t.autoTriggerManual : t.autoTriggerSchedule}
									</span>
									<span style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))", color: "var(--dsw-label-caption)" }}>
										{getWorkspaceName(run.cwd) || run.cwd} · {formatTimestamp(run.startedAt, lang, "")}
									</span>
									<div className="flex-1" />
									{run.sessionPath && (
										<button
											type="button"
											className="btn-outline"
											style={{ height: "max(26px, calc(26px + var(--dsh-content-font-delta)))", fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))", padding: "0 10px" }}
											onClick={() => onOpenSession(run.sessionPath!)}
										>
											{t.autoOpenSession}
										</button>
									)}
								</div>
								{(run.error || run.summary) && (
									<div
										className="line-clamp-2"
										style={{
											fontSize: "var(--dsh-ui-font-xs)",
											color: run.error ? "var(--dsw-danger)" : "var(--dsw-label-secondary)",
										}}
									>
										{run.error || run.summary}
									</div>
								)}
							</div>
						))}
					</div>
				)}
			</div>

			<AutomationModal
				open={modalOpen}
				initialTask={editingTask}
				knownCwds={knownCwds}
				defaultCwd={automationDefaultCwd || defaultCwd}
				getWorkspaceName={getWorkspaceName}
				models={models}
				onClose={() => setModalOpen(false)}
				onSaved={() => void load()}
			/>
			{confirmDialog}
		</WorkspaceViewShell>
	);
}
