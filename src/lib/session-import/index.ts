/**
 * 导入会话的门面：扫描 → 选择 → 写入 pi 会话。
 *
 * 两条刻意的设计：
 *  1. **不从客户端拿路径**。前端只回传 `{source, externalId}`，服务端在导入时按来源重新扫描一次
 *     把 summary 解出来（扫描很便宜：SQLite 6~42ms，文件类只读文件头）。这样路径遍历之类的输入
 *     完全进不来，也不会因为前端缓存了过期数据而写错文件。
 *  2. **单来源失败不影响其他来源**。某个工具没装 / 库损坏时，那一组空着并带错误原因，其余照常。
 */
import path from "node:path";
import fs from "node:fs/promises";
import type { ExternalSessionSummary, ImportSource, ImportSourceModule } from "./types";
import { IMPORT_SOURCES } from "./types";
import { claudeSource } from "./claude";
import { codexSource } from "./codex";
import { grokSource } from "./grok";
import { dshSource } from "./dsh";
import { zcodeSource } from "./zcode";
import { opencodeSource } from "./opencode";
import { importedKey, listImportedKeys, findImported, writeImportedSession } from "./writer";

export const IMPORT_SOURCE_MODULES: Record<ImportSource, ImportSourceModule> = {
	claude: claudeSource,
	codex: codexSource,
	grok: grokSource,
	zcode: zcodeSource,
	dsh: dshSource,
	opencode: opencodeSource,
};

/** 单来源扫描超时：库被别的进程锁死时不让整个面板卡住 */
const SCAN_TIMEOUT_MS = 30_000;
/**
 * 面板每个来源只列最近这么多条：本机六个来源合计上千个会话，全读一遍纯属浪费，
 * 而用户真正要导的基本都是最近用的那几个。想看更早的会话时把这里调大即可。
 */
export const SCAN_LIMIT_PER_SOURCE = 15;
/** 单会话上限：超过就别导了，内存和解压都吃不消（dsh 解压后能膨胀到几百 MB） */
const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

export interface SourceScanError {
	source: ImportSource;
	message: string;
}

export interface ScanReport {
	summaries: ExternalSessionSummary[];
	errors: SourceScanError[];
	/** 已导入过的 `source:externalId`，界面用来标"已导入"并禁止重复选 */
	imported: string[];
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** 扫描全部来源；返回的 summary 带 imported 标记，且已按时间倒序 */
export async function scanAllSources(agentDir: string, options: { sources?: ImportSource[]; limit?: number } = {}): Promise<ScanReport> {
	const sources = options.sources ?? IMPORT_SOURCES;
	const limit = options.limit ?? SCAN_LIMIT_PER_SOURCE;
	const summaries: ExternalSessionSummary[] = [];
	const errors: SourceScanError[] = [];
	const imported = await listImportedKeys(agentDir);

	await Promise.all(sources.map(async (source) => {
		const module = IMPORT_SOURCE_MODULES[source];
		if (!module) return;
		try {
			const found = await withTimeout(module.scan({ limit }), SCAN_TIMEOUT_MS, "扫描超时（30 秒）");
			summaries.push(...found);
		} catch (error) {
			errors.push({ source, message: error instanceof Error ? error.message : String(error) });
		}
	}));

	summaries.sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0));
	return { summaries, errors, imported: [...imported] };
}

export interface ImportSelection {
	source: ImportSource;
	externalId: string;
}

export interface ImportOutcome {
	source: ImportSource;
	externalId: string;
	title?: string;
	status: "imported" | "skipped" | "failed";
	reason?: string;
	messageCount?: number;
	/** 导入到的 pi 会话文件（成功时） */
	path?: string;
	/** 落到的工具目录；源项目路径本机不存在时会与源项目不同 */
	workspace?: string;
	skipped?: string[];
}

export interface ImportReport {
	imported: number;
	skipped: number;
	failed: number;
	results: ImportOutcome[];
	/** 本次涉及到的目录（调用方据此注册工作区） */
	workspaces: string[];
}

export interface ImportOptions {
	agentDir: string;
	/** 源项目路径在本机不存在时的兜底工作区（必须已存在） */
	fallbackCwd?: string;
	now?: number;
	onProgress?: (done: number, total: number) => void;
}

async function isDirectory(target: string | undefined): Promise<boolean> {
	if (!target || !path.isAbsolute(target)) return false;
	try {
		return (await fs.stat(target)).isDirectory();
	} catch {
		return false;
	}
}

/** 源文件大小闸门：`file|id` 形式的 SQLite 位置没有单文件概念，直接放行（读的是库里的行） */
async function oversize(location: string): Promise<boolean> {
	if (location.includes("|")) return false;
	try {
		return (await fs.stat(location)).size > MAX_SOURCE_BYTES;
	} catch {
		return false;
	}
}

export async function importSessions(items: ImportSelection[], options: ImportOptions): Promise<ImportReport> {
	const results: ImportOutcome[] = [];
	const workspaces = new Set<string>();
	const fallback = (await isDirectory(options.fallbackCwd)) ? path.resolve(options.fallbackCwd as string) : undefined;
	const scanned = new Map<ImportSource, Map<string, ExternalSessionSummary>>();
	const seen = new Set<string>();

	const resolveSummary = async (source: ImportSource, externalId: string): Promise<ExternalSessionSummary | undefined> => {
		let cache = scanned.get(source);
		if (!cache) {
			const module = IMPORT_SOURCE_MODULES[source];
			if (!module) return undefined;
			cache = new Map();
			// limit: 0 = 不限：这里要按 id 反查任意一条会话（面板只列最近的 15 条，
			// 但选择来自面板、且可能已经过几分钟，所以解析一定要能看到全部，不能跟着截断）
			for (const summary of await module.scan({ limit: 0 })) cache.set(summary.externalId, summary);
			scanned.set(source, cache);
		}
		return cache.get(externalId);
	};

	let done = 0;
	for (const item of items) {
		const { source, externalId } = item;
		const outcome: ImportOutcome = { source, externalId, status: "failed" };
		try {
			if (!IMPORT_SOURCE_MODULES[source]) {
				outcome.reason = "不支持的来源";
			} else if (seen.has(importedKey(source, externalId))) {
				outcome.status = "skipped";
				outcome.reason = "同一次导入里重复选择";
			} else if (await findImported(options.agentDir, source, externalId)) {
				outcome.status = "skipped";
				outcome.reason = "已经导入过";
			} else {
				const summary = await resolveSummary(source, externalId);
				if (!summary) {
					outcome.reason = "源会话已不存在（可能被源工具删掉或移动）";
				} else if (await oversize(summary.location)) {
					outcome.reason = "源会话过大（超过 200MB），已跳过";
				} else {
					const session = await IMPORT_SOURCE_MODULES[source].read(summary);
					if (!session) {
						outcome.reason = "源会话读不出可导入的消息";
					} else if (session.entries.length > MAX_ENTRIES) {
						outcome.reason = `消息过多（${session.entries.length} 条），已跳过`;
					} else {
						// 源项目路径本机存在就导回原工作区，否则落到用户选的兜底工作区
						const sourceProject = session.summary.projectPath;
						const target = (await isDirectory(sourceProject)) ? path.resolve(sourceProject as string) : fallback;
						if (!target) {
							outcome.reason = sourceProject ? `源项目目录不存在：${sourceProject}` : "源会话没有项目目录，且未选择兜底工作区";
						} else {
							const written = await writeImportedSession(session, { cwd: target, agentDir: options.agentDir, now: options.now });
							outcome.status = "imported";
							outcome.path = written.path;
							outcome.messageCount = written.messageCount;
							outcome.workspace = target;
							outcome.title = session.summary.title;
							if (written.skipped.length) outcome.skipped = written.skipped;
							workspaces.add(target);
							seen.add(importedKey(source, externalId));
						}
					}
				}
			}
		} catch (error) {
			outcome.reason = error instanceof Error ? error.message : String(error);
		}
		results.push(outcome);
		done += 1;
		options.onProgress?.(done, items.length);
	}

	return {
		imported: results.filter((result) => result.status === "imported").length,
		skipped: results.filter((result) => result.status === "skipped").length,
		failed: results.filter((result) => result.status === "failed").length,
		results,
		workspaces: [...workspaces],
	};
}
