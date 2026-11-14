/**
 * 归档会话保留期：从归档那一刻起算满 N 天就自动删除；归档后又用过的，从最后一次活动（文件 mtime）起算。
 * 以前只看 mtime，于是把一个很久没动的旧会话归档，几小时内就会被直接删掉。
 *
 * 只会碰「在归档列表里」的会话：没归档的会话即使很久没动也不会被动。
 * 正在被本进程管理的会话（打开中/运行中）一律跳过——交给它自己空闲回收。
 * 每一次删除都会打印日志，便于事后核对。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getArchivedEntries, removeArchivedSessionIfUnchanged } from "./workspace-store";
import { apiError } from "./api-error";

/** 归档会话保留多久（天）；侧栏「已归档」的提示文案（i18n archiveRetentionHint）写的是同一个数 */
export const ARCHIVED_RETENTION_DAYS = 30;
/** 两次清理之间的间隔 */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface RetentionReport {
	scanned: number;
	/** idleDays：距归档或最后一次活动（取较晚者）的天数 */
	deleted: { path: string; idleDays: number }[];
	/** 文件已不在磁盘上：只清掉归档列表里的记录 */
	missing: string[];
	/** 正在使用（打开中/运行中）而跳过 */
	skippedActive: string[];
	kept: number;
	/** 单条失败不终止整轮；removed 表示文件已移除但归档记录尚未清理。 */
	failures: { path: string; stage: "check" | "read" | "delete" | "forget"; error: string; errorCode: string; removed?: boolean }[];
}

/**
 * 扫一遍归档列表并删除超期会话。
 * @param options.isActive 判断某会话是否正在使用（由调用方注入，避免与 agent-manager 相互依赖）
 */
export async function sweepArchivedSessions({
	now = Date.now(),
	retentionDays = ARCHIVED_RETENTION_DAYS,
	isActive = () => false,
	log = console.log,
	dryRun = false,
}: {
	now?: number;
	retentionDays?: number;
	isActive?: (sessionPath: string) => boolean;
	log?: (message: string) => void;
	dryRun?: boolean;
} = {}): Promise<RetentionReport> {
	const report: RetentionReport = { scanned: 0, deleted: [], missing: [], skippedActive: [], kept: 0, failures: [] };
	// Disabling retention prevents removals; dry runs still report candidates.
	if (process.env.PI_WEB_ARCHIVE_RETENTION === "0" && !dryRun) return report;
	if (!Number.isFinite(retentionDays) || retentionDays <= 0) return report;
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const entries = await getArchivedEntries({ now, persist: !dryRun });

	for (const { path: sessionPath, archivedAt } of entries) {
		report.scanned += 1;
		const target = path.resolve(sessionPath);
		let stage: RetentionReport["failures"][number]["stage"] = "check";
		let removed = false;
		try {
			if (isActive(target)) {
				report.skippedActive.push(target); report.kept += 1;
				continue;
			}
			stage = "read";
			let mtimeMs: number;
			try {
				const stat = await fs.stat(target);
				if (!stat.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
				mtimeMs = stat.mtimeMs;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				stage = "forget";
				if (dryRun || await removeArchivedSessionIfUnchanged(target, archivedAt, async () => true)) report.missing.push(target);
				else report.kept += 1;
				continue;
			}
			const since = Math.max(archivedAt, mtimeMs);
			if (since > cutoff) { report.kept += 1; continue; }
			const idleDays = Math.floor((now - since) / (24 * 60 * 60 * 1000));
			if (dryRun) { report.deleted.push({ path: target, idleDays }); continue; }
			// 动态导入避免 session-reader → agent-manager → 本模块的初始化环。
			stage = "delete";
			const { deleteSession } = await import("./session-reader");
			const completed = await removeArchivedSessionIfUnchanged(target, archivedAt, async () => {
				if (isActive(target)) { report.skippedActive.push(target); return false; }
				// The file may have been used while this sweep waited for the registry lock.
				if ((await fs.stat(target)).mtimeMs > cutoff) return false;
				await deleteSession(target);
				removed = true; stage = "forget";
				return true;
			});
			if (!completed) { report.kept += 1; continue; }
			report.deleted.push({ path: target, idleDays });
			try { log(`[piweb] 归档会话已满 ${retentionDays} 天（归档后 ${idleDays} 天没有活动），已删除：${target}`); } catch { /* Already completed. */ }
		} catch (error) {
			report.failures.push({ path: target, stage, ...apiError(error, "归档清理未完成，请稍后重试。"), ...(removed ? { removed } : {}) });
			if (!removed) report.kept += 1;
		}
	}
	return report;
}

interface RetentionState {
	started: boolean;
	running?: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
	repeat?: ReturnType<typeof setInterval>;
	lastWall: number;
	lastMonotonic: number;
}
const globalForRetention = globalThis as typeof globalThis & { __piWebArchivedRetention?: RetentionState };

/** 起一个后台清理器：启动后不久跑一次，之后按间隔重复（幂等，重复调用无副作用） */
export function startArchivedSessionRetention({
	intervalMs = SWEEP_INTERVAL_MS,
	delayMs = 5_000,
	log = console.log,
	isActive,
}: { intervalMs?: number; delayMs?: number; log?: (message: string) => void; isActive?: (sessionPath: string) => boolean } = {}): void {
	const state = globalForRetention.__piWebArchivedRetention ??= { started: false, lastWall: Date.now(), lastMonotonic: performance.now() };
	if (state.started) return;
	state.started = true;
	state.lastWall = Date.now(); state.lastMonotonic = performance.now();
	const writeLog = (message: string) => { try { log(message); } catch { /* Logging must not kill the scheduler. */ } };
	const run = () => {
		if (state.running) return;
		const task = (async () => {
		try {
			const wallNow = Date.now(), monotonicNow = performance.now();
			if (Math.abs((wallNow - state.lastWall) - (monotonicNow - state.lastMonotonic)) > 5 * 60 * 1000) {
				// Retain the trusted baseline: accepting the jumped time here would
				// delete the same batch on the next interval even if the clock stayed wrong.
				writeLog("[piweb] 系统时间发生跳变，本次归档清理已暂停。");
				return;
			}
			state.lastWall = wallNow; state.lastMonotonic = monotonicNow;
			const report = await sweepArchivedSessions({ log: writeLog, isActive });
			if (report.deleted.length || report.missing.length || report.failures.length) {
				writeLog(`[piweb] 归档清理：删除 ${report.deleted.length} 个，清理失效记录 ${report.missing.length} 个，保留 ${report.kept} 个，失败 ${report.failures.length} 个`);
			}
		} catch (error) {
			writeLog(`[piweb] 归档清理失败：${apiError(error).errorCode}`);
		}
		})();
		state.running = task;
		void task.finally(() => { if (state.running === task) state.running = undefined; });
	};
	state.timer = setTimeout(() => {
		run();
		state.repeat = setInterval(run, intervalMs);
		state.repeat.unref?.();
	}, delayMs);
	state.timer.unref?.();
}
