"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { DiffView, diffStats, parseUnifiedDiff } from "@/components/DiffView";
import {
	IconWorkflowAgent16,
	IconBranchOutline16,
	IconRefreshOutline14,
	IconTrashOutline16,
	IconPlusOutline16,
	IconCheckOutline14,
	IconWarningOutline16,
	IconClockOutline16,
	IconFileOutline16,
	IconShieldOutline16,
	IconStopFill16,
} from "@/components/icons";

export interface SwarmTaskInput {
	title: string;
	instruction: string;
}

export interface SwarmTask extends SwarmTaskInput {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	report?: string;
	patch?: string;
	error?: string;
	accepted?: boolean;
}

export interface SwarmJob {
	id: string;
	cwd: string;
	root: string;
	base: string;
	status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
	createdAt: number;
	finishedAt?: number;
	tasks: SwarmTask[];
}

export interface GitInfoData {
	available: boolean;
	isRepo: boolean;
	root: string | null;
	branch: string | null;
	files: Array<{ path: string; kind: string }>;
	statusError?: string;
}

export interface SwarmCoordinatorPodProps {
	cwd: string;
	onClose?: () => void;
	onSwitchToWorkbench?: () => void;
	projectTrust?: { required: boolean; trusted: boolean; source?: string } | null;
	onSetProjectTrust?: (trusted: boolean) => Promise<void>;
	onWorkspaceChanged?: () => void;
}

const sameWorkspace = (a: string, b: string) =>
	a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function SwarmCoordinatorPod({
	cwd,
	onClose,
	onSwitchToWorkbench,
	projectTrust,
	onSetProjectTrust,
	onWorkspaceChanged,
}: SwarmCoordinatorPodProps) {
	// 1. Task form inputs (1 - 3 tasks)
	const [taskInputs, setTaskInputs] = useState<SwarmTaskInput[]>([{ title: "", instruction: "" }]);

	// 2. Git & Readiness State
	const [gitSnapshot, setGitSnapshot] = useState<{ cwd: string; data: GitInfoData } | null>(null);
	const [gitLoading, setGitLoading] = useState(false);
	const [gitError, setGitError] = useState<string | null>(null);

	// 3. Swarm Jobs & History
	const [historyJobs, setHistoryJobs] = useState<SwarmJob[]>([]);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<"active" | "history">("active");

	// 4. Execution & Operation States
	const [isLaunching, setIsLaunching] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const [acceptingIndex, setAcceptingIndex] = useState<number | null>(null);
	const [operationError, setOperationError] = useState<string | null>(null);
	const [expandedDiffs, setExpandedDiffs] = useState<Record<number, boolean>>({});
	const [fetchedTrust, setFetchedTrust] = useState<{ cwd: string; required: boolean; trusted: boolean; source?: string } | null>(null);
	const [trustError, setTrustError] = useState<string | null>(null);
	const [trustBusy, setTrustBusy] = useState(false);
	const activeCwdRef = useRef(cwd);
	activeCwdRef.current = cwd;
	const gitRequestRef = useRef(0);
	const historyRequestRef = useRef(0);

	const gitInfo = gitSnapshot?.cwd === cwd ? gitSnapshot.data : null;
	const trustCwd = gitInfo?.isRepo && gitInfo.root ? gitInfo.root : cwd;
	const trustState = fetchedTrust && sameWorkspace(fetchedTrust.cwd, trustCwd)
		? fetchedTrust
		: sameWorkspace(trustCwd, cwd) ? projectTrust : null;
	const activeTrustCwdRef = useRef(trustCwd);
	activeTrustCwdRef.current = trustCwd;
	const visibleJobs = historyJobs.filter((job) => sameWorkspace(job.cwd, cwd));

	const fetchTrustStatus = useCallback(async () => {
		if (!trustCwd) return;
		const requestedCwd = cwd;
		const requestedTrustCwd = trustCwd;
		try {
			const res = await fetch(`/api/security?cwd=${encodeURIComponent(requestedTrustCwd)}`);
			const json = await res.json();
			if (!res.ok || !json.success) throw new Error(json.error || "读取项目信任状态失败");
			if (activeCwdRef.current === requestedCwd && sameWorkspace(activeTrustCwdRef.current, requestedTrustCwd)) {
				setFetchedTrust({ cwd: requestedTrustCwd, ...json.data });
				setTrustError(null);
			}
		} catch (error) {
			if (activeCwdRef.current === requestedCwd && sameWorkspace(activeTrustCwdRef.current, requestedTrustCwd)) setTrustError(error instanceof Error ? error.message : "读取项目信任状态失败");
		}
	}, [cwd, trustCwd]);

	useEffect(() => {
		setTrustError(null);
		if (!projectTrust || !sameWorkspace(trustCwd, cwd)) void fetchTrustStatus();
	}, [cwd, trustCwd, projectTrust, fetchTrustStatus]);

	const handleTrustProject = async () => {
		if (!cwd || trustBusy) return;
		setTrustBusy(true);
		setTrustError(null);
		try {
			if (onSetProjectTrust && sameWorkspace(trustCwd, cwd)) await onSetProjectTrust(true);
			else {
				const res = await fetch("/api/security", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectTrust: { cwd: trustCwd, decision: true } }) });
				const json = await res.json();
				if (!res.ok || !json.success) throw new Error(json.error || "信任项目失败");
			}
			await fetchTrustStatus();
		} catch (error) {
			setTrustError(error instanceof Error ? error.message : "信任项目失败");
		} finally {
			setTrustBusy(false);
		}
	};

	useEffect(() => {
		gitRequestRef.current += 1;
		historyRequestRef.current += 1;
		setGitSnapshot(null);
		setGitError(null);
		setHistoryJobs([]);
		setActiveJobId(null);
		setOperationError(null);
		setFetchedTrust(null);
		setTrustError(null);
		setTaskInputs([{ title: "", instruction: "" }]);
	}, [cwd]);

	// Fetch Git status for current workspace
	const fetchGitStatus = useCallback(async () => {
		if (!cwd) return;
		const requestedCwd = cwd;
		const request = ++gitRequestRef.current;
		setGitLoading(true);
		setGitError(null);
		try {
			const res = await fetch(`/api/git?cwd=${encodeURIComponent(cwd)}`);
			const json = await res.json();
			if (activeCwdRef.current !== requestedCwd || gitRequestRef.current !== request) return;
			if (res.ok && json.success && json.data) {
				setGitSnapshot({ cwd: requestedCwd, data: json.data });
			} else {
				setGitError(json.error || "读取 Git 状态失败");
			}
		} catch (err: any) {
			if (activeCwdRef.current === requestedCwd && gitRequestRef.current === request) setGitError(err?.message || "网络请求失败");
		} finally {
			if (activeCwdRef.current === requestedCwd && gitRequestRef.current === request) setGitLoading(false);
		}
	}, [cwd]);

	// Fetch Swarm list for current workspace
	const fetchSwarmHistory = useCallback(async () => {
		if (!cwd) return;
		const requestedCwd = cwd;
		const request = ++historyRequestRef.current;
		setHistoryLoading(true);
		try {
			const res = await fetch(`/api/swarm?cwd=${encodeURIComponent(cwd)}`);
			const json = await res.json();
			if (activeCwdRef.current !== requestedCwd || historyRequestRef.current !== request) return;
			if (res.ok && json.success && Array.isArray(json.data)) {
				setHistoryJobs(json.data);
				// If no active job selected yet, pick running job or the most recent job
				setActiveJobId((prev) => {
					if (prev && json.data.some((j: SwarmJob) => j.id === prev)) return prev;
					const running = json.data.find((j: SwarmJob) => j.status === "running");
					if (running) return running.id;
					return json.data.length > 0 ? json.data[0].id : null;
				});
			} else {
				setOperationError(json.error || "加载协同任务历史失败");
			}
		} catch (err: any) {
			if (activeCwdRef.current === requestedCwd && historyRequestRef.current === request) setOperationError(err?.message || "加载协同任务历史失败");
		} finally {
			if (activeCwdRef.current === requestedCwd && historyRequestRef.current === request) setHistoryLoading(false);
		}
	}, [cwd]);

	// Fetch single swarm job details
	const fetchJobDetails = useCallback(async (id: string): Promise<SwarmJob | null> => {
		const requestedCwd = cwd;
		try {
			const res = await fetch(`/api/swarm/${id}`);
			const json = await res.json();
			if (res.ok && json.success && json.data && activeCwdRef.current === requestedCwd && sameWorkspace(json.data.cwd, requestedCwd)) {
				const updated: SwarmJob = json.data;
				setHistoryJobs((prev) => {
					const exists = prev.some((j) => j.id === updated.id);
					if (exists) {
						return prev.map((j) => (j.id === updated.id ? updated : j));
					}
					return [updated, ...prev];
				});
				return updated;
			}
		} catch (err) {
			if (activeCwdRef.current === requestedCwd) setOperationError(err instanceof Error ? err.message : "获取任务详情失败");
		}
		return null;
	}, [cwd]);

	// Initial load
	useEffect(() => {
		fetchGitStatus();
		fetchSwarmHistory();
	}, [fetchGitStatus, fetchSwarmHistory]);

	// Current active job object
	const currentJob = visibleJobs.find((j) => j.id === activeJobId) || null;
	useEffect(() => {
		if (currentJob?.status !== "running") setCancelling(false);
	}, [currentJob?.status]);

	const runningJobIds = visibleJobs.filter((job) => job.status === "running").map((job) => job.id).join(",");
	// Keep every running job current even when the user inspects an older result.
	useEffect(() => {
		if (!runningJobIds) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			const updates = await Promise.all(runningJobIds.split(",").map((id) => fetchJobDetails(id)));
			if (stopped) return;
			if (updates.some((job) => job && job.status !== "running")) void fetchGitStatus();
			timer = setTimeout(() => void poll(), 1500);
		};
		timer = setTimeout(() => void poll(), 1500);
		return () => { stopped = true; clearTimeout(timer); };
	}, [runningJobIds, fetchJobDetails, fetchGitStatus]);

	// Form operations
	const handleAddTask = () => {
		if (taskInputs.length >= 3) return;
		setTaskInputs((prev) => [...prev, { title: "", instruction: "" }]);
	};

	const handleRemoveTask = (index: number) => {
		if (taskInputs.length <= 1) return;
		setTaskInputs((prev) => prev.filter((_, i) => i !== index));
	};

	const handleUpdateTask = (index: number, field: keyof SwarmTaskInput, value: string) => {
		setTaskInputs((prev) => {
			const next = [...prev];
			next[index] = { ...next[index], [field]: value };
			return next;
		});
	};

	// Prerequisites calculation
	const isTrusted = Boolean(trustState && (!trustState.required || trustState.trusted));
	const isRepo = Boolean(gitInfo?.isRepo);
	const dirtyCount = gitInfo?.files?.length ?? 0;
	const isClean = isRepo && dirtyCount === 0 && !gitInfo?.statusError;
	const hasRunningSwarm = visibleJobs.some((j) => j.status === "running");

	const tasksValid = taskInputs.every(
		(t) => t.title.trim().length > 0 && t.title.trim().length <= 80 && t.instruction.trim().length > 0 && t.instruction.trim().length <= 4000,
	);

	let launchDisabledReason = "";
	if (!cwd) {
		launchDisabledReason = "未选择有效工作区";
	} else if (trustError) {
		launchDisabledReason = `禁止启动 (项目信任状态未知: ${trustError})`;
	} else if (!trustState) {
		launchDisabledReason = "正在读取项目信任状态";
	} else if (!isTrusted) {
		launchDisabledReason = "禁止启动 (项目未信任，请先允许)";
	} else if (gitError) {
		launchDisabledReason = `禁止启动 (Git 状态未知: ${gitError})`;
	} else if (gitInfo?.statusError) {
		launchDisabledReason = `禁止启动 (Git 状态未知: ${gitInfo.statusError})`;
	} else if (gitLoading || historyLoading) {
		launchDisabledReason = "正在检查工作区状态";
	} else if (!isRepo) {
		launchDisabledReason = "禁止启动 (非 Git 仓库，无法创建工作树)";
	} else if (!isClean) {
		launchDisabledReason = `禁止启动 (工作区存在未提交改动: ${dirtyCount} 项)`;
	} else if (hasRunningSwarm) {
		launchDisabledReason = "禁止启动 (已有协同任务正在运行)";
	} else if (!tasksValid) {
		launchDisabledReason = "请填写所有任务的目标与指令";
	} else if (isLaunching) {
		launchDisabledReason = "正在启动智能体群组...";
	}

	const canLaunch = !launchDisabledReason;

	// Launch Swarm API
	const handleLaunchSwarm = async () => {
		if (!canLaunch) return;
		const requestedCwd = cwd;
		setIsLaunching(true);
		setOperationError(null);
		try {
			const payload = {
				cwd,
				tasks: taskInputs.map((t) => ({
					title: t.title.trim(),
					instruction: t.instruction.trim(),
				})),
			};
			const res = await fetch("/api/swarm", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const json = await res.json();
			if (!res.ok || !json.success) {
				throw new Error(json.error || "启动 Swarm 任务失败");
			}
			const newJob: SwarmJob = json.data;
			if (activeCwdRef.current !== requestedCwd) return;
			setHistoryJobs((prev) => [newJob, ...prev]);
			setActiveJobId(newJob.id);
			setActiveTab("active");
		} catch (err: any) {
			setOperationError(err?.message || "启动失败");
		} finally {
			setIsLaunching(false);
		}
	};

	// Cancel Swarm API
	const handleCancelSwarm = async () => {
		if (!currentJob || currentJob.status !== "running") return;
		setCancelling(true);
		setOperationError(null);
		let requested = false;
		try {
			const res = await fetch(`/api/swarm/${currentJob.id}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd, action: "cancel" }),
			});
			const json = await res.json();
			if (!res.ok || !json.success) {
				throw new Error(json.error || "取消任务失败");
			}
			const updated: SwarmJob = json.data;
			requested = true;
			if (activeCwdRef.current === cwd) setHistoryJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
		} catch (err: any) {
			setOperationError(err?.message || "取消操作失败");
		} finally {
			if (!requested) setCancelling(false);
		}
	};

	// Accept Patch API
	const handleAcceptPatch = async (index: number) => {
		if (!currentJob || currentJob.status === "running" || currentJob.tasks[index]?.status !== "completed" || !currentJob.tasks[index]?.patch) return;
		const requestedCwd = cwd;
		setAcceptingIndex(index);
		setOperationError(null);
		try {
			const res = await fetch(`/api/swarm/${currentJob.id}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd, action: "accept", index }),
			});
			const json = await res.json();
			if (!res.ok || !json.success) {
				throw new Error(json.error || "采纳改动失败");
			}
			const updated: SwarmJob = json.data;
			if (activeCwdRef.current !== requestedCwd) return;
			setHistoryJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
			// Refresh git status because working tree files changed!
			fetchGitStatus();
			onWorkspaceChanged?.();
		} catch (err: any) {
			setOperationError(err?.message || "采纳补丁失败");
		} finally {
			setAcceptingIndex(null);
		}
	};

	const toggleDiff = (index: number) => {
		setExpandedDiffs((prev) => ({
			...prev,
			[index]: prev[index] === undefined ? false : !prev[index],
		}));
	};

	return (
		<div className="flex flex-col w-full h-full overflow-hidden text-slate-800 dark:text-slate-100 select-none">
			{/* Top Inspection & Git Readiness Strip (Clay Inset Pod) */}
			<div className="shrink-0 mb-3 px-4 py-3 clay-card flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900">
				{/* Left: Workspace Selection & Git Branch */}
				<div className="flex items-center gap-3">
					<div className="w-10 h-10 clay-inset rounded-2xl flex items-center justify-center text-emerald-500">
						<IconWorkflowAgent16 size={20} />
					</div>
					<div>
						<div className="flex items-center gap-2">
							<span className="font-bold text-base text-slate-800 dark:text-slate-100 tracking-tight">PiWeb Core Swarm</span>
							<span className="px-2 py-0.5 clay-code-pill text-xs text-slate-500 dark:text-slate-400 font-mono truncate max-w-xs" title={cwd}>
								{cwd || "未选择工作区"}
							</span>
							{gitInfo?.branch && (
								<span className="px-2.5 py-0.5 rounded-full bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-300 text-xs font-semibold flex items-center gap-1 shadow-sm">
									<IconBranchOutline16 size={12} />
									{gitInfo.branch}
								</span>
							)}
						</div>
						<div className="flex items-center gap-2 mt-0.5 text-xs text-slate-500 dark:text-slate-400">
							<span>独立 Git 工作树 · 仅受限文件工具 · 无 Shell</span>
							<span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-700" />
							<span className="text-emerald-600 dark:text-emerald-400 font-semibold">最大并行度: 3 节点</span>
						</div>
					</div>
				</div>

				{/* Center/Right: Git & Trust Readiness Banner */}
				<div className="flex items-center gap-3">
					{trustError ? (
						<div role="alert" className="clay-inset rounded-2xl px-3.5 py-2 text-xs text-rose-700">项目信任状态未知：{trustError}</div>
					) : !trustState ? (
						<div className="clay-inset rounded-2xl px-3.5 py-2 text-xs text-slate-500">正在检查项目信任状态...</div>
					) : !isTrusted ? (
						<div className="flex items-center gap-2.5 px-3.5 py-2 clay-inset bg-rose-50/80 dark:bg-rose-950/30 text-rose-900 dark:text-rose-200 rounded-2xl">
							<IconShieldOutline16 size={18} className="text-rose-500 flex-none" />
							<div className="text-left leading-tight">
								<p className="text-xs font-bold text-rose-950 dark:text-rose-100">工作区未信任 (Untrusted)</p>
								<p className="text-[11px] text-rose-800/80 dark:text-rose-300">需信任当前工作区后方可签发智能体协同任务。</p>
							</div>
							{cwd && (
								<button
									type="button"
									className="clay-btn px-2.5 py-1 bg-rose-500 hover:bg-rose-600 text-white text-xs font-semibold rounded-full ml-1"
									disabled={trustBusy}
									onClick={() => void handleTrustProject()}
								>
									信任项目
								</button>
							)}
						</div>
					) : gitError || gitInfo?.statusError ? (
						<div role="alert" className="clay-inset rounded-2xl px-3.5 py-2 text-xs text-rose-700">Git 状态读取失败：{gitError || gitInfo?.statusError}</div>
					) : !gitInfo || historyLoading ? (
						<div className="clay-inset rounded-2xl px-3.5 py-2 text-xs text-slate-500">正在检查 Git 与协同任务状态...</div>
					) : !isRepo ? (
						<div className="flex items-center gap-2.5 px-3.5 py-2 clay-inset bg-amber-50/80 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 rounded-2xl">
							<IconWarningOutline16 size={18} className="text-amber-500 flex-none" />
							<div className="text-left leading-tight">
								<p className="text-xs font-bold text-amber-950 dark:text-amber-100">非 Git 仓库 (Not Git Repository)</p>
								<p className="text-[11px] text-amber-800/80 dark:text-amber-300">当前目录未初始化 Git 仓库，无法派生隔离工作树。</p>
							</div>
						</div>
					) : !isClean ? (
						<div className="flex items-center gap-2.5 px-3.5 py-2 clay-inset bg-amber-50/70 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 rounded-2xl">
							<IconWarningOutline16 size={18} className="text-amber-500 animate-bounce flex-none" />
							<div className="text-left leading-tight">
								<p className="text-xs font-bold text-amber-950 dark:text-amber-100">工作区就绪检测：未提交改动 (Git Dirty)</p>
								<p className="text-[11px] text-amber-800/80 dark:text-amber-300">
									检测到 {dirtyCount} 项未提交变更。请提交或移走改动后再启动。
								</p>
							</div>
						</div>
					) : (
						<div className="flex items-center gap-2.5 px-3.5 py-2 clay-inset bg-emerald-50/80 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200 rounded-2xl">
							<IconCheckOutline14 size={18} className="text-emerald-500 flex-none" />
							<div className="text-left leading-tight">
								<p className="text-xs font-bold text-emerald-950 dark:text-emerald-100">工作区就绪：干净的 Git 状态 (Ready)</p>
								<p className="text-[11px] text-emerald-800/80 dark:text-emerald-300">无未提交改动，可创建独立工作树并行执行。</p>
							</div>
						</div>
					)}

					{/* Recheck Trigger Button */}
					<button
						type="button"
						className="clay-btn px-3 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:text-slate-900 text-xs font-semibold flex items-center gap-1.5"
						onClick={() => {
							fetchGitStatus();
							fetchSwarmHistory();
						}}
						title="重新检查 Git 与工作区状态"
					>
						<IconRefreshOutline14 size={14} className={`text-emerald-500 ${gitLoading ? "animate-spin" : ""}`} />
						重新检查
					</button>
				</div>
			</div>

			{/* Main Split Canvas: Left Task Creator & Right Execution Stream */}
			<div className="flex-1 flex flex-col gap-3 overflow-y-auto min-h-0 lg:flex-row lg:overflow-hidden">
				{/* LEFT PANEL: Task Group Creator (Fixed 410px, scrollable) */}
				<section className="w-full min-h-[420px] shrink-0 clay-card bg-white dark:bg-slate-900 flex flex-col p-4 overflow-hidden lg:w-[410px] lg:min-h-0">
					{/* Section Header */}
					<div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
						<div>
							<div className="flex items-center gap-2">
								<span className="w-2.5 h-2.5 rounded-full bg-orange-400" />
								<h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">发起智能体协同任务组</h2>
							</div>
							<span className="text-[11px] font-mono text-slate-400">POST /api/swarm (cwd, tasks:[])</span>
						</div>
						<span className="clay-badge px-2.5 py-1 text-xs bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-semibold">
							{taskInputs.length} / 3 任务
						</span>
					</div>

					{/* Scrollable Tasks Builder Area */}
					<div className="flex-1 overflow-y-auto py-3 space-y-3 pr-1">
						{taskInputs.map((task, idx) => (
							<div key={idx} className="clay-surface p-3.5 relative group rounded-2xl">
								<div className="flex items-center justify-between mb-2">
									<span
										className={`clay-badge px-2 py-0.5 text-xs font-bold ${
											idx === 0
												? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400"
												: idx === 1
													? "bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400"
													: "bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400"
										}`}
									>
										Task #{idx + 1}
									</span>
									<div className="flex items-center gap-2">
										<span className="text-[11px] text-slate-400">并行隔离节点 P{idx + 1}</span>
										{taskInputs.length > 1 && (
											<button
												type="button"
												className="text-slate-400 hover:text-rose-500 text-xs flex items-center gap-0.5 transition-colors"
												onClick={() => handleRemoveTask(idx)}
												title="移除此子任务"
											>
												<IconTrashOutline16 size={13} />
												移除
											</button>
										)}
									</div>
								</div>
								<div className="space-y-2">
									<div>
										<label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
											子任务目标 / Title (最多 80 字)
										</label>
										<input
											type="text"
											className="w-full clay-inset px-3 py-1.5 text-xs text-slate-800 dark:text-slate-100 bg-transparent border-0 focus:ring-1 focus:ring-emerald-400 outline-none rounded-xl"
											value={task.title}
											maxLength={80}
											placeholder={`输入第 ${idx + 1} 个子任务简述...`}
											onChange={(e) => handleUpdateTask(idx, "title", e.target.value)}
										/>
									</div>
									<div>
										<label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
											详细指示 / Instruction (最多 4000 字)
										</label>
										<textarea
											rows={3}
											className="w-full clay-inset p-2.5 text-xs text-slate-700 dark:text-slate-200 bg-transparent border-0 focus:ring-1 focus:ring-emerald-400 outline-none resize-none rounded-xl"
											value={task.instruction}
											maxLength={4000}
											placeholder="指定目标文件与函数改写逻辑规范..."
											onChange={(e) => handleUpdateTask(idx, "instruction", e.target.value)}
										/>
									</div>
								</div>
							</div>
						))}
					</div>

					{/* Add Task Slot Button */}
					{taskInputs.length < 3 && (
						<div className="pt-2 shrink-0">
							<button
								type="button"
								className="w-full py-2.5 clay-inset hover:bg-slate-200/50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300 text-xs font-semibold rounded-xl flex items-center justify-center gap-2 transition-all"
								onClick={handleAddTask}
							>
								<IconPlusOutline16 size={14} className="text-emerald-500" />
								+ 添加子任务 (最多 3 个)
							</button>
						</div>
					)}

					{/* Sandbox Security Policy Card */}
					<div className="mt-3 p-3 clay-inset bg-emerald-50/50 dark:bg-emerald-950/20 rounded-2xl shrink-0">
						<div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 text-xs font-bold mb-1">
							<IconShieldOutline16 size={14} />
							沙箱安全约定 (Sandbox Guarantee)
						</div>
						<p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
							智能体在独立 Git 工作树中使用受限文件读写工具，无 Shell 权限；模型请求仍会发往已配置的供应商。文件改动需人工审查 Diff 后采纳。
						</p>
					</div>

					{/* Creator Bottom Action Bar */}
					<div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-col gap-2 shrink-0">
						{operationError && (
							<div className="p-2 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs leading-tight">
								{operationError}
							</div>
						)}
						<button
							type="button"
							className={`w-full py-3 text-xs font-bold rounded-full flex items-center justify-center gap-2 transition-all ${
								canLaunch
									? "clay-btn clay-btn-mint text-white cursor-pointer shadow-md hover:scale-[1.01]"
									: "clay-btn bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed shadow-none"
							}`}
							disabled={!canLaunch}
							onClick={handleLaunchSwarm}
						>
							<IconWorkflowAgent16 size={16} />
							<span>{canLaunch ? `启动群组任务 (${taskInputs.length} 个任务)` : launchDisabledReason}</span>
						</button>
						<div className="flex items-center justify-between px-1 text-[11px] text-slate-400">
							<span>按规约需保持 Git 无暂存/变更</span>
							{onSwitchToWorkbench && (
								<button
									type="button"
									className="text-sky-500 hover:underline"
									onClick={onSwitchToWorkbench}
								>
									返回工作台
								</button>
							)}
						</div>
					</div>
				</section>

				{/* RIGHT PANEL: Active & Historical Swarm Executions + Diff Inspector */}
				<section className="flex-1 min-h-[480px] flex flex-col clay-card bg-white dark:bg-slate-900 p-4 overflow-hidden min-w-0 lg:min-h-0">
					{/* Execution Top Header & Realtime Poll Pill */}
					<div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
						<div className="flex items-center gap-3">
							<div className="w-8 h-8 clay-inset rounded-full flex items-center justify-center text-sky-500">
								<IconWorkflowAgent16 size={18} />
							</div>
							<div>
								<div className="flex items-center gap-2">
									<h2 className="text-sm font-bold text-slate-800 dark:text-slate-100">活跃协同任务监视器</h2>
									{currentJob?.status === "running" && (
										<span className="clay-badge px-2.5 py-0.5 text-xs bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-1.5">
											<span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
											Polling (GET /api/swarm/{currentJob.id.slice(0, 8)})
										</span>
									)}
								</div>
								<p className="text-[11px] text-slate-400">
									会话实例实时事件驱动 | 状态轮询间隔: 1.5s
								</p>
							</div>
						</div>

						{/* History Selector Tabs */}
						<div className="flex items-center gap-1 clay-inset p-1 rounded-full text-xs">
							<button
								type="button"
								className={`px-3 py-1 rounded-full font-bold transition-all ${
									activeTab === "active"
										? "bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 clay-badge"
										: "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
								}`}
								onClick={() => setActiveTab("active")}
							>
								当前协同 {currentJob ? `(1)` : `(0)`}
							</button>
							<button
								type="button"
								className={`px-3 py-1 rounded-full font-bold transition-all ${
									activeTab === "history"
										? "bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 clay-badge"
										: "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
								}`}
								onClick={() => setActiveTab("history")}
							>
								历史归档 ({visibleJobs.length})
							</button>
						</div>
					</div>

					{/* Execution Scroll Stream Body */}
					<div className="flex-1 overflow-y-auto pt-3 space-y-4 pr-1">
						{activeTab === "history" ? (
							/* History list view */
							<div className="space-y-3">
								{visibleJobs.length === 0 ? (
									<div className="text-center py-16 text-xs text-slate-400">
										暂无历史协同任务，请在左侧发起新任务组。
									</div>
								) : (
									visibleJobs.map((job) => {
										const isSelected = job.id === activeJobId;
										return (
											<div
												key={job.id}
												className={`clay-surface p-3.5 rounded-2xl transition-all cursor-pointer hover:scale-[1.005] ${
													isSelected ? "ring-2 ring-emerald-400" : ""
												}`}
												onClick={() => {
													setActiveJobId(job.id);
													setActiveTab("active");
												}}
											>
												<div className="flex items-center justify-between">
													<div className="flex items-center gap-2.5">
														<span
															className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
																job.status === "completed"
																	? "bg-emerald-50 text-emerald-600"
																	: job.status === "running"
																		? "bg-sky-50 text-sky-600 animate-spin"
																		: "bg-slate-200 text-slate-600"
															}`}
														>
															{job.status === "completed" ? (
																<IconCheckOutline14 size={14} />
															) : job.status === "running" ? (
																<IconRefreshOutline14 size={14} />
															) : (
																<IconClockOutline16 size={14} />
															)}
														</span>
														<div>
															<div className="flex items-center gap-2">
																<span className="font-mono text-xs font-bold text-slate-700 dark:text-slate-200">
																	{job.id}
																</span>
																<span
																	className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
																		job.status === "completed"
																			? "bg-emerald-100 text-emerald-700"
																			: job.status === "running"
																				? "bg-sky-100 text-sky-700"
																				: "bg-slate-200 text-slate-600"
																	}`}
																>
																	{job.status.toUpperCase()}
																</span>
															</div>
															<p className="text-[11px] text-slate-400 mt-0.5">
																{new Date(job.createdAt).toLocaleString()} · {job.tasks.length} 个子任务 (
																{job.tasks.filter((t) => t.status === "completed").length} 完成,{" "}
																{job.tasks.filter((t) => t.accepted).length} 采纳)
															</p>
														</div>
													</div>
													<button
														type="button"
														className="clay-btn px-3 py-1 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-200 text-xs font-semibold"
													>
														查看详情
													</button>
												</div>
											</div>
										);
									})
								)}
							</div>
						) : !currentJob ? (
							/* Empty state when no active job */
							<div className="flex flex-col items-center justify-center h-full text-center py-16 px-4">
								<div className="w-16 h-16 rounded-3xl clay-inset flex items-center justify-center text-slate-400 mb-4">
									<IconWorkflowAgent16 size={32} />
								</div>
								<h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-1">
									尚未启动智能体协同任务
								</h3>
								<p className="text-xs text-slate-400 max-w-sm mb-4">
									在左侧配置 1 至 3 个并发隔离子任务，启动后系统将自动派生独立的 Git 工作树执行改动。
								</p>
							</div>
						) : (
							/* Active Instance View */
							<div className="clay-surface p-4 rounded-3xl relative">
								{/* Swarm Header Meta */}
								<div className="flex items-center justify-between pb-3 border-b border-slate-200/60 dark:border-slate-800 mb-3">
									<div className="flex items-center gap-3">
										<span
											className={`px-2.5 py-1 clay-badge text-xs font-bold flex items-center gap-1.5 ${
												currentJob.status === "running"
													? "bg-emerald-50 text-emerald-600"
													: currentJob.status === "completed"
														? "bg-emerald-100 text-emerald-700"
														: currentJob.status === "failed"
															? "bg-rose-100 text-rose-700"
															: "bg-slate-200 text-slate-600"
											}`}
										>
											{currentJob.status === "running" && (
												<span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
											)}
											{currentJob.status.toUpperCase()}
										</span>
										<span className="font-mono text-xs font-bold text-slate-700 dark:text-slate-200" title={currentJob.id}>
											ID: {currentJob.id}
										</span>
										<span className="text-xs text-slate-400 flex items-center gap-1">
											<IconClockOutline16 size={13} />
											{new Date(currentJob.createdAt).toLocaleTimeString()}
										</span>
									</div>

									{/* Cancel Execution Trigger */}
									{currentJob.status === "running" && (
										<button
											type="button"
											className="clay-btn px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 text-xs font-semibold flex items-center gap-1"
											disabled={cancelling}
											onClick={handleCancelSwarm}
										>
											<IconStopFill16 size={13} />
											{cancelling ? "正在中断..." : "中断全部智能体 (action: cancel)"}
										</button>
									)}
								</div>

								{/* Subtasks Pipeline Grid */}
								<div className="space-y-3">
									{currentJob.tasks.map((task, idx) => {
										const parsedDiff = task.patch ? parseUnifiedDiff(task.patch) : null;
										const stats = parsedDiff ? diffStats(parsedDiff) : { add: 0, del: 0 };
										const isDiffExpanded = expandedDiffs[idx] !== false; // default expanded if patch exists

										return (
											<div key={idx} className="clay-card p-3.5 bg-white dark:bg-slate-900 rounded-2xl">
												<div className="flex items-center justify-between">
													<div className="flex items-center gap-2.5">
														<span
															className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
																task.status === "completed"
																	? "bg-emerald-50 text-emerald-600"
																	: task.status === "running"
																		? "bg-sky-50 text-sky-600"
																		: task.status === "failed"
																			? "bg-rose-50 text-rose-600"
																			: "bg-slate-100 text-slate-400"
															}`}
														>
															{task.status === "completed" ? (
																<IconCheckOutline14 size={14} />
															) : task.status === "running" ? (
																<IconRefreshOutline14 size={14} className="animate-spin" />
															) : task.status === "failed" ? (
																<IconWarningOutline16 size={14} />
															) : (
																<IconClockOutline16 size={14} />
															)}
														</span>
														<div>
															<h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">
																Task {idx + 1}: {task.title}
															</h3>
															<p className="text-[11px] text-slate-400">
																状态: {task.status.toUpperCase()}
																{task.patch ? ` · 包含补丁文件` : ` · 无文件改动`}
															</p>
														</div>
													</div>

													<div className="flex items-center gap-2">
													{task.patch && (
															<span className="px-2 py-0.5 clay-code-pill text-[11px] text-slate-600 dark:text-slate-300 font-mono">
																+{stats.add} -{stats.del} lines
															</span>
														)}

														{/* Accept Patch Action Button */}
												{task.patch && task.status === "completed" && (
															task.accepted ? (
																<span className="clay-badge px-3 py-1.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 text-xs font-bold flex items-center gap-1">
																	<IconCheckOutline14 size={13} />
																	已采纳
																</span>
															) : (
																<button
																					type="button"
																					className="clay-btn px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm"
																					disabled={currentJob.status === "running" || acceptingIndex === idx}
																					onClick={() => handleAcceptPatch(idx)}
																				>
																					<IconCheckOutline14 size={13} />
																					{acceptingIndex === idx ? "正在写入工作区..." : currentJob.status === "running" ? "等待全部任务结束" : "采纳改动 (Accept Patch)"}
																</button>
															)
														)}

														{task.patch && (
															<button
																type="button"
																className="clay-btn px-2.5 py-1.5 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-200 hover:text-slate-900 text-xs font-semibold flex items-center gap-1"
																onClick={() => toggleDiff(idx)}
															>
																<IconFileOutline16 size={13} />
																{isDiffExpanded ? "折叠 Diff" : "查看 Diff"}
															</button>
														)}
													</div>
												</div>

												{/* Task Instruction Snapshot */}
												<div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/30 px-2.5 py-1.5 rounded-xl">
													<span className="font-semibold text-slate-600 dark:text-slate-300">目标指令: </span>
													{task.instruction}
												</div>

												{/* Task Error Message */}
												{task.error && (
													<div className="mt-2 p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 text-xs font-mono border border-rose-200 dark:border-rose-900">
														<span className="font-bold">执行异常: </span>
														{task.error}
													</div>
												)}

												{/* Task Execution Report */}
												{task.report && (
													<div className="mt-2 p-2.5 rounded-xl clay-inset bg-slate-50 dark:bg-slate-950/20 text-slate-700 dark:text-slate-300 text-xs leading-relaxed">
														<div className="font-bold text-[11px] text-slate-500 dark:text-slate-400 mb-1">
															执行报告摘要:
														</div>
														<div className="whitespace-pre-wrap">{task.report}</div>
													</div>
												)}

												{/* Inline Unified Diff Viewer */}
												{task.patch && parsedDiff && isDiffExpanded && (
													<div className="mt-3 clay-inset p-3 bg-slate-900 rounded-xl overflow-hidden text-xs text-slate-200">
														<div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-700/60 text-slate-400">
															<div className="flex items-center gap-2">
																<IconFileOutline16 size={14} className="text-sky-400" />
																<span className="font-mono text-xs">Unified Diff</span>
															</div>
															<span className="text-[11px] text-slate-400">
																{parsedDiff.filter((l) => l.kind === "file").length} 个文件变动
															</span>
														</div>
														<div className="overflow-x-auto max-h-80 select-text">
															<DiffView lines={parsedDiff} />
														</div>
														<div className="mt-2 pt-2 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
															<span>采纳说明：改动将直接应用至工作区，不暂存、不提交 Git。</span>
																	<span className="font-mono">基于 {currentJob.base.slice(0, 8)} 生成</span>
														</div>
													</div>
												)}

												{/* Accepted Status Banner */}
												{task.accepted && (
													<div className="mt-2 p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 text-xs flex items-center justify-between">
														<div className="flex items-center gap-1.5">
															<IconCheckOutline14 size={14} className="text-emerald-500" />
															<span>文件修改已成功写入工作区 (工作区已更新，暂未 commit)</span>
														</div>
														<span className="clay-badge px-2 py-0.5 bg-white dark:bg-slate-800 text-emerald-600 font-bold text-[10px]">
															已采纳
														</span>
													</div>
												)}
											</div>
										);
									})}
								</div>
							</div>
						)}
					</div>

					{/* Execution Studio Footer Summary Status */}
					<div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0 text-[11px] text-slate-400">
						<div className="flex items-center gap-3">
							<span className="flex items-center gap-1">
								<IconShieldOutline16 size={13} className="text-emerald-500" />
								受限文件读写工具
							</span>
							<span className="flex items-center gap-1">
								<IconBranchOutline16 size={13} className="text-sky-500" />
								{currentJob ? `任务状态: ${currentJob.status}` : "尚无运行任务"}
							</span>
						</div>
						<div>
							<span>PiWeb Agent Swarm Engine (No-shell Isolated Worktree)</span>
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}
