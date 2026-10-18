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
import { forgetSession, getArchivedEntries } from "./workspace-store";

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
	const report: RetentionReport = { scanned: 0, deleted: [], missing: [], skippedActive: [], kept: 0 };
	if (!Number.isFinite(retentionDays) || retentionDays <= 0) return report;
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const entries = await getArchivedEntries({ now, persist: !dryRun });

	for (const { path: sessionPath, archivedAt } of entries) {
		report.scanned += 1;
		const target = path.resolve(sessionPath);
		if (isActive(target)) {
			report.skippedActive.push(target);
			report.kept += 1;
			continue;
		}
		let mtimeMs: number;
		try {
			const stat = await fs.stat(target);
			if (!stat.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
			mtimeMs = stat.mtimeMs;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// 文件没了（手动删过等）：只清理归档记录
			report.missing.push(target);
			if (!dryRun) await forgetSession(target);
			continue;
		}
		const since = Math.max(archivedAt, mtimeMs);
		if (since > cutoff) {
			report.kept += 1;
			continue;
		}
		const idleDays = Math.floor((now - since) / (24 * 60 * 60 * 1000));
		report.deleted.push({ path: target, idleDays });
		if (dryRun) continue;
		// 运行时再取：session-reader → agent-manager → 本模块 构成环，静态导入会在初始化期踩空
		const { deleteSession } = await import("./session-reader");
		await deleteSession(target);
		await forgetSession(target);
		log(`[piweb] 归档会话已满 ${retentionDays} 天（归档后 ${idleDays} 天没有活动），已删除：${target}`);
	}
	return report;
}

let started = false;
let lastSweep = 0;

/** 起一个后台清理器：启动后不久跑一次，之后按间隔重复（幂等，重复调用无副作用） */
export function startArchivedSessionRetention({
	intervalMs = SWEEP_INTERVAL_MS,
	delayMs = 5_000,
	log = console.log,
	isActive,
}: { intervalMs?: number; delayMs?: number; log?: (message: string) => void; isActive?: (sessionPath: string) => boolean } = {}): void {
	if (started) return;
	started = true;
	const run = async () => {
		lastSweep = Date.now();
		try {
			const report = await sweepArchivedSessions({ log, isActive });
			if (report.deleted.length || report.missing.length) {
				log(`[piweb] 归档清理：删除 ${report.deleted.length} 个，清理失效记录 ${report.missing.length} 个，保留 ${report.kept} 个`);
			}
		} catch (error) {
			log(`[piweb] 归档清理失败：${error instanceof Error ? error.message : error}`);
		}
	};
	const timer = setTimeout(() => {
		void run();
		const repeat = setInterval(() => void run(), intervalMs);
		repeat.unref?.();
	}, delayMs);
	timer.unref?.();
}

/** 距上次清理是否已经超过一个间隔（供复用现有定时器时判断） */
export function shouldSweep(now = Date.now(), intervalMs = SWEEP_INTERVAL_MS): boolean {
	return now - lastSweep >= intervalMs;
}
