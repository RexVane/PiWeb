import { closeSync, fsyncSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * fsync 失败里可以安全降级的错误：Windows 目录句柄、部分网络盘/tmpfs 不支持
 * 对目录或只读句柄 FlushFileBuffers；这类「不支持」不能把正常的写操作弄挂。
 * 真正的 I/O 错误（EIO、ENOSPC…）仍然向上抛，避免静默丢数据。
 */
const UNSUPPORTED_SYNC_ERRORS = new Set([
	"EINVAL",
	"EPERM",
	"EACCES",
	"EBUSY",
	"ENOTSUP",
	"EOPNOTSUPP",
	"EISDIR",
	"EBADF",
	"ENOENT",
	"ENOSYS",
	"ERR_INVALID_ARG_VALUE",
	"ERR_INVALID_ARG_TYPE",
]);

function syncUnavailable(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && UNSUPPORTED_SYNC_ERRORS.has(code);
}

/**
 * 发布前把数据从页缓存刷到盘上。先以读写方式打开（Windows 的 FlushFileBuffers
 * 要求句柄带写权限），文件已被并发移走时按「没什么可刷」处理，让 rename 自己报错。
 */
export async function syncFile(file: string): Promise<void> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, "r+");
	} catch (error) {
		if (syncUnavailable(error)) return;
		throw error;
	}
	try {
		await handle.sync();
	} catch (error) {
		if (!syncUnavailable(error)) throw error;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * rename 之后让目录项也落盘（否则断电可能只留下「文件还在临时名」）。
 *
 * POSIX 用只读句柄；Windows 上只读目录句柄的 FlushFileBuffers 会被拒（EPERM），
 * 换 `r+` 重试，仍不可用就安全降级——目录 fsync 是持久性增强，不能阻止已完成的写入。
 */
export async function syncDirectory(directory: string): Promise<void> {
	for (const flags of ["r", "r+"] as const) {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(directory, flags);
		} catch (error) {
			if (syncUnavailable(error)) return;
			throw error;
		}
		try {
			await handle.sync();
			return;
		} catch (error) {
			if (!syncUnavailable(error)) throw error;
		} finally {
			await handle.close().catch(() => undefined);
		}
	}
}

/** 同步版：给已经用同步 FS API 的写路径（jsonc settings、npm 事务）用。 */
export function syncFileSync(file: string): void {
	let fd: number;
	try {
		fd = openSync(file, "r+");
	} catch (error) {
		if (syncUnavailable(error)) return;
		throw error;
	}
	try {
		fsyncSync(fd);
	} catch (error) {
		if (!syncUnavailable(error)) throw error;
	} finally {
		closeSync(fd);
	}
}

/** 同步版目录 fsync，语义同 {@link syncDirectory}。 */
export function syncDirectorySync(directory: string): void {
	for (const flags of ["r", "r+"] as const) {
		let fd: number;
		try {
			fd = openSync(directory, flags);
		} catch (error) {
			if (syncUnavailable(error)) return;
			throw error;
		}
		try {
			fsyncSync(fd);
			return;
		} catch (error) {
			if (!syncUnavailable(error)) throw error;
		} finally {
			closeSync(fd);
		}
	}
}

/**
 * 原子替换：`source`（通常是同目录的临时文件）rename 到 `destination`。
 *
 * 持久性（D3）：rename 之前先 fsync 源文件、rename 成功后再 fsync 目标目录，
 * 断电时要么是完整的旧文件、要么是完整的新文件。目录 fsync 在不可用时安全降级。
 * Readers or antivirus can briefly block replacement on Windows. Keep the old file intact while retrying.
 */
export async function replaceFileAtomically(source: string, destination: string, beforeReplace?: () => Promise<void>): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		// A sharing violation may outlive the original version check. Revalidate
		// after every delay so a concurrent edit is not overwritten by a retry.
		await beforeReplace?.();
		try {
			// 数据先落盘再发布；失败重试时重复一次是幂等的。
			await syncFile(source);
			await fs.rename(source, destination);
			await syncDirectory(path.dirname(destination));
			return;
		} catch (error) {
			if (attempt >= 9 || !SHARING_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
			await delay(Math.min(25 * (attempt + 1), 100));
		}
	}
}
