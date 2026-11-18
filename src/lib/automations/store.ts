import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { processIdentity, processIdentityAlive } from "../../../scripts/process-identity.mjs";
import { createRecoverableCopy } from "../recoverable-remove";
import { readFileBounded } from "../session-import/files";
import { getAgentDir } from "../pi";
import { replaceFileAtomically } from "../atomic-file";
import { resolveWorkspacePath } from "../path-security";
import { withExternalSettingsLock, withSettingsWriteLock } from "../settings-write-lock";
import { computeNextRunAt, validateSchedule } from "./schedule";
import type { AutomationModelRef, AutomationRun, AutomationRunStatus, AutomationSchedule, AutomationTask, AutomationTaskInput } from "./types";

const MAX_NAME_LEN = 120;
const MAX_PROMPT_LEN = 50_000;
const MAX_RUNS = 100;
const MAX_SUMMARY_LEN = 400;
export const MAX_AUTOMATION_TASKS = 100;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
export const MAX_CONCURRENT_AUTOMATIONS = 4;
const ownerGlobal = globalThis as typeof globalThis & { __piwebAutomationOwner?: string };
const OWNER_INSTANCE = ownerGlobal.__piwebAutomationOwner ??= randomUUID();
const OWNER_BIRTH = processIdentity(process.pid).birth ?? undefined;
interface AutomationsFile {
	version: 1;
	tasks: AutomationTask[];
	runs: AutomationRun[];
}
export class AutomationStoreError extends Error {
	constructor(message: string) { super(`${message}; existing data was not modified`); this.name = "AutomationStoreError"; }
}

export class AutomationValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutomationValidationError";
	}
}

export class AutomationNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutomationNotFoundError";
	}
}

export class AutomationConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutomationConflictError";
	}
}

/** Local PiWeb instances share this file; a live owner must not be reconciled by another instance. */
export function hasLiveRunOwner(run: AutomationRun): boolean {
	if (!Number.isSafeInteger(run.ownerPid) || !run.ownerPid || run.ownerPid < 1) return false;
	if (run.ownerInstance) {
		if (run.ownerPid === process.pid && run.ownerInstance !== OWNER_INSTANCE) return false;
	}
	// Heartbeats can stall during sleep or a storage outage. Only a dead process or
	// a proven reused PID relinquishes ownership; elapsed wall time is not evidence.
	return processIdentityAlive(run.ownerPid, run.ownerBirth) !== false;
}

function liveClaim(claim: NonNullable<AutomationTask["scheduledClaim"]>): boolean {
	if (claim.ownerPid === process.pid && claim.ownerInstance !== OWNER_INSTANCE) return false;
	return processIdentityAlive(claim.ownerPid, claim.ownerBirth) !== false;
}

function retainRunHistory(runs: AutomationRun[]): AutomationRun[] {
	// History limits must never discard a running task's exclusion/ownership record.
	return runs.filter((run, index) => index < MAX_RUNS || run.status === "running");
}

function normalizeEnabled(raw: unknown, fallback: boolean): boolean {
	if (raw === undefined) return fallback;
	if (typeof raw !== "boolean") throw new AutomationValidationError("Enabled must be a boolean");
	return raw;
}

export function defaultAutomationsStorePath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "web-automations.json");
}

export function defaultAutomationWorkspaceDir(agentDir = getAgentDir()): string {
	return path.join(agentDir, "automations");
}

export async function ensureAutomationWorkspaceDir(agentDir = getAgentDir()): Promise<string> {
	const dir = defaultAutomationWorkspaceDir(agentDir);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });
	return dir;
}

function normalizeModelRef(raw: unknown): AutomationModelRef | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) throw new AutomationValidationError("Invalid model selection");
	const obj = raw as Record<string, unknown>;
	const provider = typeof obj.provider === "string" ? obj.provider.trim() : "";
	const id = typeof obj.id === "string" ? obj.id.trim() : "";
	if (!provider && !id) return undefined;
	if (!provider || !id) throw new AutomationValidationError("Model must specify both provider and id");
	return { provider, id };
}

function normalizeName(raw: unknown): string {
	if (typeof raw !== "string") throw new AutomationValidationError("Task name is required");
	const name = raw.trim();
	if (!name) throw new AutomationValidationError("Task name is required");
	if (name.length > MAX_NAME_LEN) throw new AutomationValidationError(`Task name cannot exceed ${MAX_NAME_LEN} characters`);
	return name;
}

function normalizePrompt(raw: unknown): string {
	if (typeof raw !== "string") throw new AutomationValidationError("Prompt is required");
	const prompt = raw.trim();
	if (!prompt) throw new AutomationValidationError("Prompt is required");
	if (prompt.length > MAX_PROMPT_LEN) throw new AutomationValidationError(`Prompt cannot exceed ${MAX_PROMPT_LEN} characters`);
	return prompt;
}

function sanitizeTaskRecord(raw: unknown): AutomationTask | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const item = raw as Record<string, unknown>;
	if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.prompt !== "string" || typeof item.cwd !== "string") {
		return null;
	}
	try {
		const schedule = validateSchedule(item.schedule);
		const enabled = item.enabled !== false;
		const model = normalizeModelRef(item.model);
		const claim = item.scheduledClaim as AutomationTask["scheduledClaim"];
		if (claim && (typeof claim.id !== "string" || !Number.isFinite(claim.dueAt) || !Number.isSafeInteger(claim.ownerPid) || claim.ownerPid < 1 || typeof claim.ownerInstance !== "string")) return null;
		return {
			id: item.id,
			name: item.name,
			prompt: item.prompt,
			cwd: item.cwd,
			schedule,
			enabled,
			...(model ? { model } : {}),
			createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
			updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
			nextRunAt: enabled ? (typeof item.nextRunAt === "number" ? item.nextRunAt : computeNextRunAt(schedule)) : null,
			...(typeof item.waitingSeenAt === "number" ? { waitingSeenAt: item.waitingSeenAt } : {}),
			...(claim ? { scheduledClaim: { id: claim.id, dueAt: claim.dueAt, ownerPid: claim.ownerPid, ownerInstance: claim.ownerInstance, ...(typeof claim.ownerBirth === "string" ? { ownerBirth: claim.ownerBirth } : {}) } } : {}),
			...(typeof item.lastRunAt === "number" ? { lastRunAt: item.lastRunAt } : {}),
			...(item.lastRunStatus === "running" || item.lastRunStatus === "success" || item.lastRunStatus === "error" || item.lastRunStatus === "skipped"
				? { lastRunStatus: item.lastRunStatus }
				: {}),
			...(typeof item.lastSessionPath === "string" ? { lastSessionPath: item.lastSessionPath } : {}),
		};
	} catch {
		return null;
	}
}

function sanitizeRunRecord(raw: unknown): AutomationRun | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const item = raw as Record<string, unknown>;
	if (typeof item.id !== "string" || typeof item.taskId !== "string" || typeof item.startedAt !== "number") return null;
	if (!["running", "success", "error", "skipped"].includes(String(item.status))) return null;
	const status = item.status as AutomationRunStatus;
	return {
		id: item.id,
		taskId: item.taskId,
		taskName: typeof item.taskName === "string" ? item.taskName : "",
		cwd: typeof item.cwd === "string" ? item.cwd : "",
		trigger: item.trigger === "manual" ? "manual" : "schedule",
		status,
		startedAt: item.startedAt,
		...(typeof item.ownerPid === "number" ? { ownerPid: item.ownerPid } : {}),
		...(typeof item.ownerInstance === "string" ? { ownerInstance: item.ownerInstance } : {}),
		...(typeof item.ownerBirth === "string" ? { ownerBirth: item.ownerBirth } : {}),
		...(typeof item.heartbeatAt === "number" ? { heartbeatAt: item.heartbeatAt } : {}),
		...(typeof item.cancelRequestedAt === "number" ? { cancelRequestedAt: item.cancelRequestedAt } : {}),
		...(typeof item.finishedAt === "number" ? { finishedAt: item.finishedAt } : {}),
		...(typeof item.sessionPath === "string" ? { sessionPath: item.sessionPath } : {}),
		...(typeof item.summary === "string" ? { summary: item.summary } : {}),
		...(typeof item.error === "string" ? { error: item.error } : {}),
	};
}

async function readStore(filePath: string): Promise<AutomationsFile> {
	try {
		if ((await fs.stat(filePath)).size > MAX_STORE_BYTES) throw new AutomationStoreError("Automation store exceeds the 16MB safety limit");
		const raw = (await readFileBounded(filePath, MAX_STORE_BYTES)).toString("utf8");
		const parsed = JSON.parse(raw) as Partial<AutomationsFile> | null;
		if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.runs)) {
			throw new AutomationStoreError("Invalid automation store format");
		}
		const tasks = parsed.tasks.map(sanitizeTaskRecord);
		const runs = parsed.runs.map(sanitizeRunRecord);
		if (tasks.some((task) => task === null) || runs.some((run) => run === null)) {
			throw new AutomationStoreError("Invalid automation record");
		}
		return { version: 1, tasks: tasks as AutomationTask[], runs: retainRunHistory(runs as AutomationRun[]) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { version: 1, tasks: [], runs: [] };
		}
		throw error instanceof SyntaxError ? new AutomationStoreError("Automation store JSON is damaged") : error;
	}
}

async function writeStore(data: AutomationsFile, filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(tmp, JSON.stringify({ ...data, runs: retainRunHistory(data.runs) }, null, 2), {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		// D3：replaceFileAtomically 负责「数据 fsync → rename → 目录 fsync」，断电后不出现半份存储。
		await replaceFileAtomically(tmp, filePath);
		const recovery = `${filePath}.last-good`; const recoveryTemporary = `${recovery}.${randomUUID()}.tmp`;
		try { await fs.copyFile(filePath, recoveryTemporary); await replaceFileAtomically(recoveryTemporary, recovery); }
		catch (error) { console.error("[automations] Current store saved, recovery snapshot could not be refreshed:", error); }
		finally { await fs.unlink(recoveryTemporary).catch(() => undefined); }
	} finally {
		await fs.unlink(tmp).catch(() => undefined);
	}
}

function mutateStore<T>(filePath: string, fn: (data: AutomationsFile) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean }): Promise<T> {
	return withSettingsWriteLock(filePath, () => withExternalSettingsLock(filePath, async () => {
		const data = await readStore(filePath);
		const { result, changed } = await fn(data);
		if (changed) await writeStore(data, filePath);
		return result;
	}));
}

export async function listAutomations(filePath = defaultAutomationsStorePath()): Promise<{ tasks: AutomationTask[]; runs: AutomationRun[] }> {
	const data = await readStore(filePath);
	return { tasks: data.tasks, runs: data.runs };
}

export async function getAutomationTask(id: string, filePath = defaultAutomationsStorePath()): Promise<AutomationTask | null> {
	const data = await readStore(filePath);
	return data.tasks.find((t) => t.id === id) ?? null;
}

export async function inspectAutomationStore(filePath = defaultAutomationsStorePath()) {
	let error: unknown;
	try { const data = await readStore(filePath); return { ...data, storeError: undefined }; } catch (failure) { error = failure; }
	const metadata = await fs.stat(filePath);
	if (metadata.size > MAX_STORE_BYTES) {
		return { version: 1, tasks: [] as AutomationTask[], runs: [] as AutomationRun[], storeError: {
			message: "自动化文件超过 16MB 安全上限，原始文件已保留。", expectedHash: `oversize:${metadata.size}:${metadata.mtimeMs}:${metadata.ino}`,
			canSalvage: false, canRestore: await readStore(`${filePath}.last-good`).then(() => true, () => false),
		} };
	}
	const raw = await readFileBounded(filePath, MAX_STORE_BYTES);
	const expectedHash = createHash("sha256").update(raw).digest("hex");
	let tasks: AutomationTask[] = []; let runs: AutomationRun[] = []; let canSalvage = false;
	try {
		const parsed = JSON.parse(raw.toString("utf8"));
		if (parsed?.version === 1 && Array.isArray(parsed.tasks) && Array.isArray(parsed.runs)) {
			canSalvage = true; tasks = parsed.tasks.map(sanitizeTaskRecord).filter((task: AutomationTask | null): task is AutomationTask => task !== null);
			runs = parsed.runs.map(sanitizeRunRecord).filter((run: AutomationRun | null): run is AutomationRun => run !== null);
		}
	} catch { /* The original remains available for backup or manual repair. */ }
	const canRestore = await readStore(`${filePath}.last-good`).then((data) => data.tasks.length > 0 || data.runs.length > 0, () => false);
	return { version: 1, tasks, runs, storeError: { message: error instanceof Error ? error.message : String(error), expectedHash, canSalvage, canRestore } };
}

export async function repairAutomationStore(mode: "salvage" | "restore" | "reset", expectedHash: string, filePath = defaultAutomationsStorePath()) {
	return withSettingsWriteLock(filePath, () => withExternalSettingsLock(filePath, async () => {
		const preview = await inspectAutomationStore(filePath);
		if (!preview.storeError) throw new AutomationValidationError("Automation store is already healthy; repair was not applied");
		if (preview.storeError.expectedHash !== expectedHash) throw new AutomationConflictError("Automation store changed; review its current state again");
		let data: AutomationsFile;
		if (mode === "restore" && preview.storeError.canRestore) data = await readStore(`${filePath}.last-good`);
		else if (mode === "salvage" && preview.storeError.canSalvage) data = { version: 1, tasks: preview.tasks, runs: preview.runs };
		else if (mode === "reset") data = { version: 1, tasks: [], runs: [] };
		else throw new AutomationValidationError("The requested recovery mode is not available");
		const backup = await createRecoverableCopy(filePath, { reason: `自动化存储修复：${mode}` });
		await writeStore(data, filePath);
		return { repaired: true, ...backup, tasks: data.tasks.length, runs: data.runs.length };
	}));
}

export async function createAutomationTask(input: AutomationTaskInput, filePath = defaultAutomationsStorePath(), now = Date.now()): Promise<AutomationTask> {
	const name = normalizeName(input.name);
	const prompt = normalizePrompt(input.prompt);
	let cwd: string;
	try {
		cwd = await resolveWorkspacePath(input.cwd);
	} catch (err: any) {
		throw new AutomationValidationError(String(err?.message ?? "invalid workspace path"));
	}
	let schedule: AutomationSchedule;
	try {
		schedule = validateSchedule(input.schedule);
	} catch (err: any) {
		throw new AutomationValidationError(String(err?.message ?? "invalid schedule"));
	}
	const model = normalizeModelRef(input.model);
	const enabled = normalizeEnabled(input.enabled, true);
	const nextRunAt = computeNextRunAt(schedule, now);
	if (nextRunAt === null) throw new AutomationValidationError("Schedule has no upcoming occurrence; check its date fields");

	const task: AutomationTask = {
		id: randomUUID(),
		name,
		prompt,
		cwd,
		schedule,
		enabled,
		...(model ? { model } : {}),
		createdAt: now,
		updatedAt: now,
		nextRunAt: enabled ? nextRunAt : null,
	};

	return mutateStore(filePath, (data) => {
		if (data.tasks.length >= MAX_AUTOMATION_TASKS) throw new AutomationValidationError(`At most ${MAX_AUTOMATION_TASKS} automation tasks can be stored`);
		data.tasks.unshift(task);
		return { result: task, changed: true };
	});
}

export interface AutomationTaskPatch {
	name?: string;
	prompt?: string;
	cwd?: string;
	schedule?: AutomationSchedule;
	enabled?: boolean;
	model?: AutomationModelRef | null;
}

export async function updateAutomationTask(
	id: string,
	patch: AutomationTaskPatch,
	filePath = defaultAutomationsStorePath(),
	now = Date.now(),
): Promise<AutomationTask> {
	const nextCwd = patch.cwd !== undefined
		? await resolveWorkspacePath(patch.cwd).catch((err: any) => {
			throw new AutomationValidationError(String(err?.message ?? "invalid workspace path"));
		})
		: undefined;
	const nextName = patch.name !== undefined ? normalizeName(patch.name) : undefined;
	const nextPrompt = patch.prompt !== undefined ? normalizePrompt(patch.prompt) : undefined;
	let nextSchedule: AutomationSchedule | undefined;
	if (patch.schedule !== undefined) {
		try {
			nextSchedule = validateSchedule(patch.schedule);
		} catch (err: any) {
			throw new AutomationValidationError(String(err?.message ?? "invalid schedule"));
		}
	}
	const hasModelPatch = Object.prototype.hasOwnProperty.call(patch, "model");
	const nextModel = hasModelPatch ? normalizeModelRef(patch.model) : undefined;
	const enabledPatch = patch.enabled === undefined ? undefined : normalizeEnabled(patch.enabled, true);

	return mutateStore(filePath, (data) => {
		const index = data.tasks.findIndex((t) => t.id === id);
		if (index < 0) throw new AutomationNotFoundError("Automation task not found");
		const existing = data.tasks[index];
		const schedule = nextSchedule ?? existing.schedule;
		const enabled = enabledPatch ?? existing.enabled;
		const scheduleChanged = nextSchedule !== undefined;
		const reenabled = !existing.enabled && enabled;
		const nextRunAt = !enabled
			? null
			: scheduleChanged || reenabled || existing.nextRunAt === null
			? computeNextRunAt(schedule, now)
			: existing.nextRunAt;
		if ((enabled || scheduleChanged) && computeNextRunAt(schedule, now) === null) throw new AutomationValidationError("Schedule has no upcoming occurrence; check its date fields");

		const updated: AutomationTask = {
			...existing,
			name: nextName ?? existing.name,
			prompt: nextPrompt ?? existing.prompt,
			cwd: nextCwd ?? existing.cwd,
			schedule,
			enabled,
			updatedAt: now,
			nextRunAt,
		};
		if (scheduleChanged || enabledPatch !== undefined) {
			delete updated.scheduledClaim;
			delete updated.waitingSeenAt;
		}
		if (hasModelPatch) {
			if (nextModel) updated.model = nextModel;
			else delete updated.model;
		}
		data.tasks[index] = updated;
		return { result: updated, changed: true };
	});
}

export async function deleteAutomationTask(id: string, filePath = defaultAutomationsStorePath()): Promise<{ deleted: boolean }> {
	return mutateStore(filePath, async (data) => {
		if (data.runs.some((run) => run.taskId === id && run.status === "running" && hasLiveRunOwner(run))) {
			throw new AutomationConflictError("Task is running; wait for completion before deleting it");
		}
		const before = data.tasks.length;
		if (!data.tasks.some((task) => task.id === id)) throw new AutomationNotFoundError("Automation task not found");
		await createRecoverableCopy(filePath, { reason: `移除自动化任务 ${id}，保留任务与运行记录` });
		data.tasks = data.tasks.filter((t) => t.id !== id);
		if (data.tasks.length === before) throw new AutomationNotFoundError("Automation task not found");
		data.runs = data.runs.filter((r) => r.taskId !== id);
		return { result: { deleted: true }, changed: true };
	});
}

/**
 * Atomically find due tasks, advance their nextRunAt past `now`, and return snapshots to run.
 * When `maxLatenessMs` is exceeded (e.g. server was offline or host slept), missed runs are skipped cleanly.
 */
export async function claimDueTasks(
	now: number,
	busyTaskIds: ReadonlySet<string>,
	filePath = defaultAutomationsStorePath(),
	opts?: { maxLatenessMs?: number },
): Promise<AutomationTask[]> {
	return mutateStore(filePath, (data) => {
		const claimed: AutomationTask[] = [];
		let changed = false;
		const maxLatenessMs = opts?.maxLatenessMs;
		const running = new Set(data.runs.filter((run) => run.status === "running" && hasLiveRunOwner(run)).map((run) => run.taskId));
		for (const task of data.tasks) {
			if (task.scheduledClaim && !liveClaim(task.scheduledClaim)) {
				if (task.enabled) task.nextRunAt = task.scheduledClaim.dueAt;
				delete task.scheduledClaim;
				changed = true;
			}
		}
		let reserved = data.tasks.filter((task) => task.scheduledClaim && !running.has(task.id)).length;
		for (let i = 0; i < data.tasks.length; i += 1) {
			const task = data.tasks[i];
			if (!task.enabled || task.scheduledClaim || task.nextRunAt === null || task.nextRunAt > now) continue;
			const recentlyWaiting = task.waitingSeenAt !== undefined && now >= task.waitingSeenAt && (maxLatenessMs === undefined || now - task.waitingSeenAt <= maxLatenessMs);
			const missed = maxLatenessMs !== undefined && now - task.nextRunAt > maxLatenessMs && !recentlyWaiting;
			if (busyTaskIds.has(task.id) || running.has(task.id) || (!missed && running.size + reserved >= MAX_CONCURRENT_AUTOMATIONS)) {
				if (!missed || recentlyWaiting) { task.waitingSeenAt = now; changed = true; }
				continue;
			}
			const period = task.schedule.kind === "interval" ? task.schedule.every * (task.schedule.unit === "hours" ? 3_600_000 : 60_000) : null;
			const nextRunAt = period ? task.nextRunAt + (Math.floor((now - task.nextRunAt) / period) + 1) * period : computeNextRunAt(task.schedule, now);
			const updated: AutomationTask = { ...task, nextRunAt };
			delete updated.waitingSeenAt;
			data.tasks[i] = updated;
			if (!missed) {
				updated.scheduledClaim = { id: randomUUID(), dueAt: task.nextRunAt, ownerPid: process.pid, ownerInstance: OWNER_INSTANCE, ...(OWNER_BIRTH ? { ownerBirth: OWNER_BIRTH } : {}) };
				claimed.push({ ...updated, nextRunAt: task.nextRunAt });
				reserved += 1;
			}
			else {
				data.runs.unshift({ id: randomUUID(), taskId: task.id, taskName: task.name, cwd: task.cwd, trigger: "schedule", status: "skipped",
					startedAt: task.nextRunAt, finishedAt: now, summary: "服务离线或休眠期间错过执行时间，本次未运行；下次时间已安排。" });
				updated.lastRunAt = task.nextRunAt; updated.lastRunStatus = "skipped";
			}
			changed = true;
		}
		return { result: claimed, changed };
	});
}

export async function recordRunStarted(
	task: AutomationTask,
	trigger: "schedule" | "manual",
	startedAt = Date.now(),
	filePath = defaultAutomationsStorePath(),
): Promise<AutomationRun> {
	const run: AutomationRun = {
		id: randomUUID(),
		taskId: task.id,
		taskName: task.name,
		cwd: task.cwd,
		trigger,
		status: "running",
		startedAt,
		ownerPid: process.pid,
		ownerInstance: OWNER_INSTANCE,
		...(OWNER_BIRTH ? { ownerBirth: OWNER_BIRTH } : {}),
		heartbeatAt: Date.now(),
	};
	return mutateStore(filePath, (data) => {
		const t = data.tasks.find((item) => item.id === task.id);
		if (!t) throw new AutomationNotFoundError("Automation task not found");
		if (trigger === "schedule" && !t.enabled) throw new AutomationConflictError("Task was paused before its scheduled run started");
		if (trigger === "schedule" && (task.scheduledClaim || t.scheduledClaim) && (t.scheduledClaim?.id !== task.scheduledClaim?.id || t.updatedAt !== task.updatedAt)) {
			throw new AutomationConflictError("Task changed before its scheduled run started");
		}
		if (trigger === "manual" && t.scheduledClaim && liveClaim(t.scheduledClaim)) throw new AutomationConflictError("Task already has a scheduled run waiting to start");
		if (data.runs.some((item) => item.taskId === task.id && item.status === "running" && hasLiveRunOwner(item))) {
			throw new AutomationConflictError("Task is already running");
		}
		const reservations = data.tasks.filter((item) => item.id !== task.id && item.scheduledClaim && liveClaim(item.scheduledClaim)).length;
		if (data.runs.filter((item) => item.status === "running" && hasLiveRunOwner(item)).length + reservations >= MAX_CONCURRENT_AUTOMATIONS) {
			throw new AutomationConflictError(`At most ${MAX_CONCURRENT_AUTOMATIONS} automations can run at once`);
		}
		data.runs.unshift(run);
		delete t.scheduledClaim;
		data.runs = retainRunHistory(data.runs);
		if (t) {
			t.lastRunAt = startedAt;
			t.lastRunStatus = "running";
		}
		return { result: run, changed: true };
	});
}

export async function heartbeatAutomationRun(runId: string, filePath = defaultAutomationsStorePath()): Promise<boolean> {
	return mutateStore(filePath, (data) => {
		const run = data.runs.find((item) => item.id === runId && item.status === "running" && item.ownerInstance === OWNER_INSTANCE);
		if (!run) return { result: true, changed: false };
		run.heartbeatAt = Date.now();
		return { result: Boolean(run.cancelRequestedAt), changed: true };
	});
}

export async function requestAutomationStop(taskId: string, filePath = defaultAutomationsStorePath()): Promise<{ stopping: boolean }> {
	return mutateStore(filePath, (data) => {
		const run = data.runs.find((item) => item.taskId === taskId && item.status === "running" && hasLiveRunOwner(item));
		if (!run) throw new AutomationNotFoundError("No active run for this task");
		run.cancelRequestedAt = Date.now();
		return { result: { stopping: true }, changed: true };
	});
}

/** A scheduler generation cancelled after claiming must not consume the due occurrence. */
export async function releaseAutomationClaim(task: AutomationTask, filePath = defaultAutomationsStorePath()): Promise<void> {
	await mutateStore(filePath, (data) => {
		const current = data.tasks.find((item) => item.id === task.id);
		if (!current || !task.scheduledClaim || current.scheduledClaim?.id !== task.scheduledClaim.id) {
			return { result: undefined, changed: false };
		}
		if (current.enabled) current.nextRunAt = current.scheduledClaim.dueAt;
		delete current.scheduledClaim;
		return { result: undefined, changed: true };
	});
}

export async function attachRunSession(
	runId: string,
	taskId: string,
	sessionPath: string,
	filePath = defaultAutomationsStorePath(),
): Promise<void> {
	await mutateStore(filePath, (data) => {
		let changed = false;
		const run = data.runs.find((r) => r.id === runId);
		if (run) {
			run.sessionPath = sessionPath;
			changed = true;
		}
		const task = data.tasks.find((t) => t.id === taskId);
		if (task) {
			task.lastSessionPath = sessionPath;
			changed = true;
		}
		return { result: undefined, changed };
	});
}

export function truncateSummary(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= MAX_SUMMARY_LEN) return compact;
	return `${compact.slice(0, MAX_SUMMARY_LEN)}…`;
}

export async function recordRunFinished(
	runId: string,
	status: "success" | "error",
	details: { summary?: string; error?: string; sessionPath?: string },
	finishedAt = Date.now(),
	filePath = defaultAutomationsStorePath(),
): Promise<AutomationRun | null> {
	return mutateStore(filePath, (data) => {
		const run = data.runs.find((r) => r.id === runId);
		if (!run) return { result: null, changed: false };
		run.status = status;
		run.finishedAt = finishedAt;
		if (details.sessionPath) run.sessionPath = details.sessionPath;
		if (details.summary) run.summary = truncateSummary(details.summary);
		if (details.error) run.error = details.error;

		const task = data.tasks.find((t) => t.id === run.taskId);
		if (task) {
			task.lastRunStatus = status;
			if (run.sessionPath) task.lastSessionPath = run.sessionPath;
		}
		return { result: run, changed: true };
	});
}

export async function reconcileInterruptedRuns(
	activeRunIds: ReadonlySet<string>,
	filePath = defaultAutomationsStorePath(),
	now = Date.now(),
): Promise<number> {
	return mutateStore(filePath, (data) => {
		let updatedCount = 0;
		const taskHasActiveRun = new Set<string>();
		for (const run of data.runs) {
			if (run.status === "running") {
				if (activeRunIds.has(run.id) || hasLiveRunOwner(run)) {
					taskHasActiveRun.add(run.taskId);
				} else {
					run.status = "error";
					run.finishedAt = now;
					run.error = "Interrupted by server restart";
					updatedCount += 1;
				}
			}
		}
		for (const task of data.tasks) {
			if (task.lastRunStatus === "running" && !taskHasActiveRun.has(task.id)) {
				task.lastRunStatus = "error";
				updatedCount += 1;
			}
		}
		return { result: updatedCount, changed: updatedCount > 0 };
	});
}
