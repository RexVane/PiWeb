import path from "node:path";
import { createNewSession, disposeSession, execute, getManaged, observeManagedEvents, type Managed } from "../agent-manager";
import { resolveWorkspacePath } from "../path-security";
import { registerShutdownHook } from "../graceful-shutdown";
import type { AgentCommand, WebEvent, WebMessage } from "../types";
import {
	attachRunSession,
	AutomationConflictError,
	claimDueTasks,
	defaultAutomationsStorePath,
	getAutomationTask,
	inspectAutomationStore,
	hasLiveRunOwner,
	reconcileInterruptedRuns,
	recordRunFinished,
	recordRunStarted,
	heartbeatAutomationRun,
	releaseAutomationClaim,
} from "./store";
import type { AutomationRun, AutomationTask } from "./types";

const TICK_INTERVAL_MS = 15_000;
const SCHEDULE_MISSED_GRACE_MS = 2 * 60_000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const RUNTIME_KEY = Symbol.for("piweb.automations.runtime");

interface PendingRunFinish {
	runId: string;
	taskId: string;
	status: "success" | "error";
	details: Parameters<typeof recordRunFinished>[2];
	finishedAt: number;
	writing?: Promise<AutomationRun | null>;
}

interface SchedulerRuntime {
	started: boolean;
	reconciled: boolean;
	timer: ReturnType<typeof setInterval> | null;
	ticking: boolean;
	activeTaskIds: Set<string>;
	activeRunIds: Set<string>;
	pendingFinishes: Map<string, PendingRunFinish>;
	pendingClaimReleases: Map<string, AutomationTask>;
	generation: number;
	initializing?: Promise<void>;
}

export { AutomationConflictError } from "./store";

export interface RunnerDeps {
	createNewSession: typeof createNewSession;
	getManaged: typeof getManaged;
	execute: (m: Managed, cmd: AgentCommand) => ReturnType<typeof execute>;
	observeManagedEvents: typeof observeManagedEvents;
	disposeSession: (m: Managed) => void | Promise<void>;
	resolveWorkspacePath: typeof resolveWorkspacePath;
	timeoutMs: number;
}

const DEFAULT_DEPS: RunnerDeps = {
	createNewSession,
	getManaged,
	execute,
	observeManagedEvents,
	disposeSession,
	resolveWorkspacePath,
	timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
};

function runtimeState(storePath = defaultAutomationsStorePath()): SchedulerRuntime {
	const store = globalThis as Record<PropertyKey, unknown>;
	let states = store[RUNTIME_KEY] as Map<string, SchedulerRuntime> | undefined;
	if (!(states instanceof Map)) {
		// Clear the timer from the pre-store-scoped HMR version if it is still present.
		const previous = store[RUNTIME_KEY] as SchedulerRuntime | undefined;
		if (previous?.timer) clearInterval(previous.timer);
		states = new Map();
		store[RUNTIME_KEY] = states;
	}
	const resolved = path.resolve(storePath);
	const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	const existing = states.get(key);
	if (existing) {
		existing.pendingFinishes ??= new Map();
		existing.pendingClaimReleases ??= new Map();
		return existing;
	}
	const created: SchedulerRuntime = {
		started: false,
		reconciled: false,
		timer: null,
		ticking: false,
		activeTaskIds: new Set<string>(),
		activeRunIds: new Set<string>(),
		pendingFinishes: new Map<string, PendingRunFinish>(),
		pendingClaimReleases: new Map<string, AutomationTask>(),
		generation: 0,
	};
	states.set(key, created);
	return created;
}

function persistRunFinish(runtime: SchedulerRuntime, pending: PendingRunFinish, storePath: string): Promise<AutomationRun | null> {
	if (pending.writing) return pending.writing;
	pending.writing = (async () => {
		try {
			const saved = await recordRunFinished(pending.runId, pending.status, pending.details, pending.finishedAt, storePath);
			runtime.pendingFinishes.delete(pending.runId);
			runtime.activeTaskIds.delete(pending.taskId);
			runtime.activeRunIds.delete(pending.runId);
			return saved;
		} finally {
			pending.writing = undefined;
		}
	})();
	return pending.writing;
}

async function retryPendingFinishes(runtime: SchedulerRuntime, storePath: string): Promise<void> {
	for (const pending of runtime.pendingFinishes.values()) {
		// Retain the original outcome and exclusion until storage becomes writable again.
		await persistRunFinish(runtime, pending, storePath).catch(() => undefined);
	}
}

async function retryClaimReleases(runtime: SchedulerRuntime, storePath: string): Promise<void> {
	for (const [id, task] of runtime.pendingClaimReleases) {
		try { await releaseAutomationClaim(task, storePath); runtime.pendingClaimReleases.delete(id); }
		catch { /* A storage outage must not permanently consume this occurrence. Retry next tick. */ }
	}
}

async function runStep<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
	signal.throwIfAborted();
	let onAbort!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation(), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function formatRunSessionTitle(taskName: string, startedAt: number): string {
	const d = new Date(startedAt);
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return `${taskName} · ${stamp}`;
}

function extractMessageText(message: Pick<WebMessage, "content"> | { content?: unknown }): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type?: string; text?: string } => Boolean(part && typeof part === "object"))
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("\n")
		.trim();
}

function readLatestAssistantFromManager(m: Managed): { text: string; stopReason?: string; errorMessage?: string } | null {
	try {
		const entries = (m.sm?.getBranch?.() ?? []) as Array<{
			type?: string;
			message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
		}>;
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry?.type === "message" && entry.message?.role === "assistant") {
				return {
					text: extractMessageText(entry.message),
					stopReason: entry.message.stopReason,
					errorMessage: entry.message.errorMessage,
				};
			}
		}
	} catch {
		/* ignore fallback read failure */
	}
	return null;
}

async function runPromptAndAwaitSettlement(
	m: Managed,
	task: AutomationTask,
	deps: RunnerDeps,
	signal: AbortSignal,
): Promise<{ status: "success" | "error"; summary?: string; error?: string }> {
	let sawActive = false;
	let aborted = false;
	let lastAssistantText = "";
	let lastAssistantStopReason: string | undefined;
	let lastAssistantError: string | undefined;
	const streamErrors: string[] = [];
	let unavailable = false;

	let settledResolve!: () => void;
	const settledPromise = new Promise<void>((resolve) => {
		settledResolve = resolve;
	});

	const unsubscribe = deps.observeManagedEvents(m, (evt: WebEvent) => {
		if (evt.type === "interaction_unavailable" && evt.reason === "headless") {
			unavailable = true;
			settledResolve();
			return;
		}
		if (evt.type === "status") {
			if (evt.isStreaming) {
				sawActive = true;
			} else if (evt.state === "idle" || evt.state === "aborted") {
				if (evt.state === "aborted") aborted = true;
				if (sawActive || streamErrors.length > 0 || lastAssistantText || lastAssistantError) {
					settledResolve();
				}
			}
			return;
		}
		if (evt.type === "message" && evt.phase === "end" && evt.message?.role === "assistant") {
			sawActive = true;
			const msg = evt.message;
			const text = extractMessageText(msg);
			if (text) lastAssistantText = text;
			lastAssistantStopReason = msg.stopReason;
			lastAssistantError = msg.errorMessage;
			if (msg.stopReason === "aborted") aborted = true;
			return;
		}
		if (evt.type === "error" && typeof evt.message === "string" && evt.message.trim()) {
			streamErrors.push(evt.message.trim());
		}
	});

	try {
		const promptRes = await runStep(signal, () => deps.execute(m, { cmd: "prompt", text: task.prompt }));
		if (!promptRes.ok) {
			return { status: "error", error: promptRes.error || "Failed to submit automation prompt" };
		}

		const waitForAgentIdle = async () => {
			try {
				await m.session?.agent?.waitForIdle?.();
			} catch {
				/* agent idle failure still inspects captured state */
			}
			// Allow deferPublish microtasks (message_end / agent_settled) to flush before inspecting.
			await new Promise<void>((resolve) => setTimeout(resolve, 30));
		};

		await runStep(signal, () => Promise.race([
			settledPromise,
			waitForAgentIdle(),
		]));
		// Extension commands can be accepted before any model round begins, and a
		// model idle event may precede the command's final cleanup. Wait for both.
		while (!unavailable && (m.runActive || m.commandRunning || m.bashActive || m.promptSubmitting || m.resourceReloading || m.stopping)) {
			await runStep(signal, () => new Promise<void>((resolve) => setTimeout(resolve, 30)));
		}
	} finally {
		unsubscribe();
	}
	if (unavailable) {
		return { status: "error", error: "自动化需要人工输入，已停止；未批准任何操作。" };
	}

	if (!lastAssistantText && !lastAssistantError) {
		const fallback = readLatestAssistantFromManager(m);
		if (fallback) {
			lastAssistantText = fallback.text;
			lastAssistantStopReason = fallback.stopReason;
			lastAssistantError = fallback.errorMessage;
		}
	}

	if (aborted || lastAssistantStopReason === "aborted") {
		return {
			status: "error",
			error: lastAssistantError || streamErrors[0] || "Run aborted",
			...(lastAssistantText ? { summary: lastAssistantText } : {}),
		};
	}

	if (lastAssistantStopReason === "error" || lastAssistantError || (!lastAssistantText && streamErrors.length > 0)) {
		return {
			status: "error",
			error: lastAssistantError || streamErrors[0] || "Assistant returned an error",
			...(lastAssistantText ? { summary: lastAssistantText } : {}),
		};
	}

	return {
		status: "success",
		summary: lastAssistantText || "(Completed)",
	};
}

async function stopAutomationSession(m: Managed, deps: RunnerDeps): Promise<void> {
	let reported = false;
	for (;;) {
		try {
			if (m.disposed) { await deps.disposeSession(m); return; }
			const result = await deps.execute(m, { cmd: "abort" });
			if (!result.ok) throw new Error(result.error || "Session has not stopped yet");
			await deps.disposeSession(m);
			return;
		} catch (error) {
			// Keep headless mode, heartbeat and the running slot until shutdown is
			// confirmed. A transient stop failure must not permit another run.
			if (!reported) console.error("[automations] Waiting for the session to stop:", error);
			reported = true;
			await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
		}
	}
}

/**
 * Create a new isolated session for `task` and run its prompt in the background.
 * Returns the started `AutomationRun` immediately alongside a `done` promise for callers/tests.
 */
export async function launchAutomationTask(
	task: AutomationTask,
	trigger: "schedule" | "manual",
	opts?: { storePath?: string; deps?: Partial<RunnerDeps> },
): Promise<{ run: AutomationRun; done: Promise<AutomationRun | null> }> {
	const storePath = opts?.storePath ?? defaultAutomationsStorePath();
	const runtime = runtimeState(storePath);
	await retryPendingFinishes(runtime, storePath);
	if (runtime.activeTaskIds.has(task.id)) {
		throw new AutomationConflictError("Task is already running");
	}

	const deps: RunnerDeps = { ...DEFAULT_DEPS, ...opts?.deps };
	runtime.activeTaskIds.add(task.id);

	let run: AutomationRun;
	let sessionPath: string | undefined;
	try {
		const startedAt = Date.now();
		run = await recordRunStarted(task, trigger, startedAt, storePath);
		runtime.activeRunIds.add(run.id);
	} catch (err) {
		runtime.activeTaskIds.delete(task.id);
		throw err;
	}

	const executeInBackground = async (): Promise<AutomationRun | null> => {
		const controller = new AbortController();
		const timeout = setTimeout(() => {
			controller.abort(new Error(`Automation run timed out after ${Math.round(deps.timeoutMs / 60_000)}m`));
		}, deps.timeoutMs);
		timeout.unref?.();
		let heartbeatWriting = false;
		const heartbeat = setInterval(() => {
			if (heartbeatWriting) return;
			heartbeatWriting = true;
			void heartbeatAutomationRun(run.id, storePath).then((stop) => {
				if (stop) controller.abort(new Error("自动化已按请求停止"));
			}).catch((error) => console.error("[automations] Run heartbeat failed:", error))
				.finally(() => { heartbeatWriting = false; });
		}, 5_000);
		heartbeat.unref?.();
		let managed: Managed | undefined;
		let outcome: { status: "success" | "error"; summary?: string; error?: string };
		try {
			const cwd = await runStep(controller.signal, () => deps.resolveWorkspacePath(task.cwd));
			const created = await runStep(controller.signal, () => deps.createNewSession(cwd).then(async (created) => {
				if (controller.signal.aborted) await deps.disposeSession(deps.getManaged(created.sessionPath));
				return created;
			}));
			sessionPath = created.sessionPath;
			managed = deps.getManaged(sessionPath);
			managed.headless = true;
			const target = managed;
			await runStep(controller.signal, () => attachRunSession(run.id, task.id, sessionPath!, storePath));
			await runStep(controller.signal, () => deps.execute(target, {
				cmd: "rename",
				text: formatRunSessionTitle(task.name, run.startedAt),
			}));

			if (task.model) {
				const model = task.model;
				const modelRes = await runStep(controller.signal, () => deps.execute(target, {
					cmd: "setModel",
					provider: model.provider,
					modelId: model.id,
					fresh: true,
				}));
				if (!modelRes.ok) {
					throw new Error(modelRes.error || `Model unavailable: ${task.model.provider}/${task.model.id}`);
				}
			}

			outcome = await runPromptAndAwaitSettlement(target, task, deps, controller.signal);
		} catch (err: unknown) {
			outcome = { status: "error", error: err instanceof Error ? err.message : String(err) };
		}
		try {
			if (managed && outcome.status === "error") await stopAutomationSession(managed, deps);
		} finally {
			clearTimeout(timeout);
			clearInterval(heartbeat);
			if (managed) managed.headless = false;
		}
		const pending: PendingRunFinish = {
			runId: run.id,
			taskId: task.id,
			status: outcome.status,
			details: {
				...(sessionPath ? { sessionPath } : {}),
				...(outcome.summary ? { summary: outcome.summary } : {}),
				...(outcome.error ? { error: outcome.error } : {}),
			},
			finishedAt: Date.now(),
		};
		runtime.pendingFinishes.set(run.id, pending);
		return persistRunFinish(runtime, pending, storePath);
	};

	const done = executeInBackground();
	// Avoid unhandled rejection if nobody awaits `done`.
	void done.catch((error) => console.error("[automations] Run finished but its result could not be saved; will retry:", error));
	return { run, done };
}

/** Trigger an automation manually by ID, launching it in a fresh session immediately. */
export async function runAutomationNow(
	taskId: string,
	opts?: { storePath?: string; deps?: Partial<RunnerDeps> },
): Promise<{ run: AutomationRun; done: Promise<AutomationRun | null> }> {
	const storePath = opts?.storePath ?? defaultAutomationsStorePath();
	const task = await getAutomationTask(taskId, storePath);
	if (!task) {
		const { AutomationNotFoundError } = await import("./store");
		throw new AutomationNotFoundError("Automation task not found");
	}
	return launchAutomationTask(task, "manual", opts);
}

/** Check due scheduled tasks once and launch any within the active schedule window. */
export async function runDueAutomations(opts?: {
	now?: number;
	storePath?: string;
	deps?: Partial<RunnerDeps>;
	maxLatenessMs?: number;
	/** A stopped/replaced timer must not launch more tasks after awaiting I/O. */
	isCurrent?: () => boolean;
}): Promise<AutomationRun[]> {
	const storePath = opts?.storePath ?? defaultAutomationsStorePath();
	const runtime = runtimeState(storePath);
	if (runtime.ticking) return [];
	runtime.ticking = true;
	try {
		await retryPendingFinishes(runtime, storePath);
		await retryClaimReleases(runtime, storePath);
		const now = opts?.now ?? Date.now();
		if (opts?.isCurrent && !opts.isCurrent()) return [];
		const due = await claimDueTasks(now, runtime.activeTaskIds, storePath, {
			maxLatenessMs: opts?.maxLatenessMs ?? SCHEDULE_MISSED_GRACE_MS,
		});
		const startedRuns: AutomationRun[] = [];
		for (const task of due) if (task.scheduledClaim) runtime.pendingClaimReleases.set(task.scheduledClaim.id, task);
		for (const task of due) {
			if (opts?.isCurrent && !opts.isCurrent()) continue;
			try {
				const { run } = await launchAutomationTask(task, "schedule", { storePath, deps: opts?.deps });
				if (task.scheduledClaim) runtime.pendingClaimReleases.delete(task.scheduledClaim.id);
				startedRuns.push(run);
			} catch (err) {
				console.error(`[automations] Failed to start task "${task.name}":`, err);
			}
		}
		return startedRuns;
	} finally {
		await retryClaimReleases(runtime, storePath);
		runtime.ticking = false;
	}
}

/**
 * Start the process-wide automation scheduler on `globalThis` (HMR-safe: clears previous timer on re-evaluation).
 * On first startup of a process, interrupted `"running"` runs and missed past-due schedules are reconciled cleanly.
 */
export function startAutomationScheduler(opts?: { storePath?: string; intervalMs?: number }): () => void {
	const storePath = opts?.storePath ?? defaultAutomationsStorePath();
	const runtime = runtimeState(storePath);
	if (runtime.timer) {
		clearInterval(runtime.timer);
		runtime.timer = null;
	}

	const generation = ++runtime.generation;
	const isCurrent = () => runtime.started && runtime.generation === generation;
	const initialize = async () => {
		if (runtime.reconciled) return;
		if (!runtime.initializing) {
			runtime.initializing = reconcileInterruptedRuns(runtime.activeRunIds, storePath).then(() => {
				runtime.reconciled = true;
			}).finally(() => { runtime.initializing = undefined; });
		}
		await runtime.initializing;
	};
	const intervalMs = opts?.intervalMs ?? TICK_INTERVAL_MS;
	runtime.started = true;
	void initialize().catch((error) => console.error("[automations] Startup reconciliation failed:", error));
	runtime.timer = setInterval(() => {
		void (async () => {
			await initialize();
			if (isCurrent()) await runDueAutomations({ storePath, isCurrent });
		})().catch((error) => console.error("[automations] Scheduler tick failed:", error));
	}, intervalMs);
	runtime.timer.unref?.();

	const stop = () => {
		if (runtime.generation !== generation) return;
		runtime.generation += 1;
		if (runtime.timer) {
			clearInterval(runtime.timer);
			runtime.timer = null;
		}
		runtime.started = false;
	};
	// L5：服务收到退出信号时先停调度器，别再启动新任务；同名钩子替换旧的（HMR 安全）。
	registerShutdownHook(stop, { name: "automations" });
	return stop;
}

/** 调度器运行状态（只读快照）：readiness 用它区分「没起来」和「正在跑」。 */
export function getAutomationSchedulerStatus(): { running: boolean; ticking: boolean; reconciled: boolean } {
	const runtime = runtimeState();
	return { running: Boolean(runtime.started && runtime.timer), ticking: runtime.ticking, reconciled: runtime.reconciled };
}

/** Lazily ensure the scheduler loop is running if an API route loads outside instrumentation context. */
export function ensureAutomationSchedulerStarted(): void {
	const runtime = runtimeState();
	if (process.env.NEXT_PHASE === "phase-production-build") return;
	if (!runtime.started || !runtime.timer) {
		startAutomationScheduler();
	}
}

export async function getAutomationsSnapshot(storePath = defaultAutomationsStorePath()) {
	const pathMod = await import("node:path");
	const { ensureAutomationWorkspaceDir } = await import("./store");
	const defaultCwd = await ensureAutomationWorkspaceDir(pathMod.dirname(storePath));
	const runtime = runtimeState(storePath);
	await retryPendingFinishes(runtime, storePath);
	const data = await inspectAutomationStore(storePath);
	return {
		defaultCwd,
		...data,
		activeTaskIds: Array.from(new Set([...runtime.activeTaskIds, ...data.runs.filter((run) => run.status === "running" && hasLiveRunOwner(run)).map((run) => run.taskId)])),
		schedulerStarted: runtime.started && !data.storeError,
	};
}
