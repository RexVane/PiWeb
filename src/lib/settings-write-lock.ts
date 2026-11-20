import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

const pending = new Map<string, Promise<void>>();

/** 文件系统层面的“另一个写入者正在占用”：Windows 上常以 EACCES/EPERM/EBUSY 出现。 */
const RETRYABLE_WRITE_CODES = new Set(["EACCES", "EPERM", "ELOCKED", "EBUSY"]);
/** 并发写退避：等锁冲突过去，而不是把 500 直接甩给用户。 */
const RETRY_ATTEMPTS = 15;
const RETRY_MAX_TIMEOUT_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** 设置文件写入繁忙：调用方（HTTP 路由）应回 409/503 + Retry-After，而不是 500。 */
export class SettingsWriteBusyError extends Error {
	readonly code = "SETTINGS_BUSY";
	readonly retryAfterSeconds: number;
	constructor(retryAfterSeconds = 1, options?: { cause?: unknown }) {
		super("设置文件正在被其他操作写入，请稍后重试。", options);
		this.name = "SettingsWriteBusyError";
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export function isRetryableSettingsWriteError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_WRITE_CODES.has(code);
}

export interface SettingsWriteLockOptions {
	/**
	 * 写操作遇到 EACCES/EPERM/ELOCKED/EBUSY 时在锁内退避重试（默认关闭，保持原有调用方行为）。
	 * 只对幂等/合并式写（如 settings patch）开启：重试会重新执行 operation。
	 */
	retryBusy?: boolean;
	/** retryBusy 时的最大尝试次数（默认 15）。 */
	attempts?: number;
}

async function retryWrite<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (!isRetryableSettingsWriteError(error)) throw error;
			if (attempt >= attempts - 1) throw new SettingsWriteBusyError(1, { cause: error });
			// 线性退避 + 上限：并发写通常几百毫秒内结束，别把请求拖到超时
			await sleep(Math.min(RETRY_MAX_TIMEOUT_MS, 25 * (attempt + 1)));
		}
	}
}

/** Serialize in-process read/modify/write operations on the same Pi settings file. */
export function withSettingsWriteLock<T>(
	file: string,
	operation: () => Promise<T>,
	options: SettingsWriteLockOptions = {},
): Promise<T> {
	const resolved = path.resolve(file);
	const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	const previous = pending.get(key) ?? Promise.resolve();
	const run = options.retryBusy
		? () => retryWrite(operation, options.attempts ?? RETRY_ATTEMPTS)
		: operation;
	const result = previous.then(run, run);
	const settled = result.then(() => undefined, () => undefined);
	pending.set(key, settled);
	void settled.then(() => {
		if (pending.get(key) === settled) pending.delete(key);
	});
	return result;
}

/**
 * 获取跨进程锁；Windows 下 proper-lockfile 的 EACCES/EPERM/EBUSY 视为“暂时冲突”重试，
 * 重试耗尽后统一抛 SettingsWriteBusyError（路由层映射为 409/503 + Retry-After）。
 */
async function acquireExternalLock(file: string): Promise<() => Promise<void>> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await lockfile.lock(file, {
				realpath: false,
				retries: { retries: 20, minTimeout: 20, maxTimeout: 100 },
			});
		} catch (error) {
			if (!isRetryableSettingsWriteError(error)) throw error;
			if (attempt >= RETRY_ATTEMPTS - 1) throw new SettingsWriteBusyError(1, { cause: error });
			await sleep(Math.min(RETRY_MAX_TIMEOUT_MS, 25 * (attempt + 1)));
		}
	}
}

/** Match the SDK's settings.json.lock protocol for PiWeb's manual JSON writes. */
export async function withExternalSettingsLock<T>(
	file: string, operation: () => Promise<T>, options: { createParent?: boolean } = {},
): Promise<T> {
	if (options.createParent !== false) await fs.mkdir(path.dirname(file), { recursive: true });
	const release = await acquireExternalLock(file);
	try {
		return await operation();
	} finally {
		await release();
	}
}

/** SDK setters enqueue writes and record failures instead of rejecting flush(). */
export async function flushSettingsOrThrow(manager: Pick<SettingsManager, "flush" | "drainErrors">): Promise<void> {
	await manager.flush();
	const errors = manager.drainErrors();
	if (errors.length) {
		throw new Error(`Pi settings failed: ${errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; ")}`, {
			cause: errors[0].error,
		});
	}
}
