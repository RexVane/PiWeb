/**
 * workspace-store：手动添加的工作区注册表（~/.pi/agent/web-workspaces.json）。
 * 会话 cwd + 手动添加的目录共同构成侧栏「工作区」列表；pi 不受影响（独立文件）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_ROOT } from "./app-root";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir } from "./pi";
import { randomUUID } from "node:crypto";
import { withExternalSettingsLock, withSettingsWriteLock } from "./settings-write-lock";
import { createRecoverableCopy } from "./recoverable-remove";
import { apiError } from "./api-error";
import { replaceFileAtomically } from "./atomic-file";

interface WorkspaceFile {
	workspaces: string[];
	aliases?: Record<string, string>;
	archivedSessions?: string[];
	pinnedSessions?: string[];
	/** 归档时间（毫秒）：pathKey → 时间戳；用于侧栏显示已归档多久。 */
	archivedAt?: Record<string, number>;
	removedWorkspaces?: string[];
	/** 生长记录工作区开关（沿用旧字段兼容已有选择）：未设置默认开启，false 保持停用。 */
	growthInit?: Record<string, boolean>;
	recovery?: WorkspaceRegistryRecovery;
}

export interface WorkspaceRegistryRecovery {
	at: number;
	source: "last-good" | "empty";
	/** 只公开备份文件名，完整恢复位置记录在 backups/INDEX.md。 */
	backup: string;
	restored: { workspaces: number; aliases: number; archivedSessions: number; pinnedSessions: number };
}

export interface WorkspaceRegistrySnapshot {
	workspaces: string[];
	aliases: Record<string, string>;
	archivedSessions: string[];
	/** 有效归档起点（毫秒）：归档时间与文件 mtime 取较晚者，更新后重新显示时长。 */
	archivedAt: Record<string, number>;
	pinnedSessions: string[];
	removedWorkspaces: string[];
	error?: string;
	errorCode?: string;
	warning?: string;
	recovery?: WorkspaceRegistryRecovery;
}
class RegistryFormatError extends Error {}

function readRecovery(value: unknown): WorkspaceRegistryRecovery | undefined {
	if (!value || typeof value !== "object") return undefined;
	const r = value as WorkspaceRegistryRecovery;
	if (!Number.isFinite(r.at) || r.at <= 0 || !["last-good", "empty"].includes(r.source)
		|| typeof r.backup !== "string" || !r.backup || r.backup.length > 255 || path.basename(r.backup) !== r.backup || /[\\/\r\n\0]/.test(r.backup)
		|| !r.restored || ![r.restored.workspaces, r.restored.aliases, r.restored.archivedSessions, r.restored.pinnedSessions]
			.every((count) => Number.isSafeInteger(count) && count >= 0)) return undefined;
	return { at: r.at, source: r.source, backup: r.backup, restored: {
		workspaces: r.restored.workspaces, aliases: r.restored.aliases,
		archivedSessions: r.restored.archivedSessions, pinnedSessions: r.restored.pinnedSessions,
	} };
}

function recoveryNotice(data: WorkspaceFile): Pick<WorkspaceRegistrySnapshot, "warning" | "recovery"> {
	if (!data.recovery) return {};
	const r = data.recovery;
	const warning = r.source === "last-good"
		? `工作区记录损坏后已从最近有效记录恢复（工作区 ${r.restored.workspaces}、别名 ${r.restored.aliases}、归档 ${r.restored.archivedSessions}、置顶 ${r.restored.pinnedSessions}）；损坏原件已有备份，请核对恢复结果。`
		: "工作区记录损坏后已重建；原有别名、归档和置顶尚未恢复。损坏原件已有备份，请根据 backups/INDEX.md 核对并恢复。";
	return { warning, recovery: r };
}

function file(agentDir = getAgentDir()): string {
	return path.join(agentDir, "web-workspaces.json");
}

async function readFile(target = file()): Promise<WorkspaceFile> {
	try {
		const parsed = JSON.parse(await fs.readFile(target, "utf8")) as WorkspaceFile;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RegistryFormatError("invalid workspace registry");
		const stringLists = [parsed.workspaces, parsed.archivedSessions, parsed.pinnedSessions, parsed.removedWorkspaces];
		const record = (value: unknown, valid: (entry: unknown) => boolean) => value === undefined
			|| (value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(valid));
		if (stringLists.some((list) => list !== undefined && (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")))
			|| !record(parsed.aliases, (entry) => typeof entry === "string")
			|| !record(parsed.growthInit, (entry) => typeof entry === "boolean")
			|| !record(parsed.archivedAt, (entry) => typeof entry === "number" && Number.isFinite(entry))
			|| (parsed.recovery !== undefined && !readRecovery(parsed.recovery))) throw new RegistryFormatError("invalid workspace registry fields");
		const aliases = Object.fromEntries(
			Object.entries(typeof parsed.aliases === "object" && parsed.aliases !== null ? parsed.aliases : {})
				.filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		const growthInit = Object.fromEntries(
			Object.entries(typeof parsed.growthInit === "object" && parsed.growthInit !== null ? parsed.growthInit : {})
				.filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
		);
		const archivedAt = Object.fromEntries(
			Object.entries(typeof parsed.archivedAt === "object" && parsed.archivedAt !== null ? parsed.archivedAt : {})
				.filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
		);
		const recovery = readRecovery(parsed.recovery);
		return {
			workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces.filter((w) => typeof w === "string") : [],
			aliases,
			archivedSessions: Array.isArray(parsed.archivedSessions) ? parsed.archivedSessions.filter((s) => typeof s === "string") : [],
			pinnedSessions: Array.isArray(parsed.pinnedSessions) ? parsed.pinnedSessions.filter((s) => typeof s === "string") : [],
			...(Object.keys(archivedAt).length ? { archivedAt } : {}),
			removedWorkspaces: Array.isArray(parsed.removedWorkspaces) ? parsed.removedWorkspaces.filter((s) => typeof s === "string") : [],
			...(Object.keys(growthInit).length ? { growthInit } : {}),
			...(recovery ? { recovery } : {}),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { workspaces: [], aliases: {}, archivedSessions: [], pinnedSessions: [], removedWorkspaces: [] };
}

function pathKey(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** UI 新增目录与历史 CLI cwd 共用 realpath；离线或已移走的历史目录仍保留原路径。 */
const canonicalPaths = new Map<string, { at: number; value: Promise<string> }>();
export async function canonicalWorkspacePath(value: string, { fresh = false }: { fresh?: boolean } = {}): Promise<string> {
	if (!value) return value;
	const resolved = path.resolve(value);
	const cached = canonicalPaths.get(resolved);
	if (!fresh && cached && Date.now() - cached.at < 5000) return cached.value;
	const real = fs.realpath(resolved).catch(() => resolved);
	canonicalPaths.delete(resolved); canonicalPaths.set(resolved, { at: Date.now(), value: real });
	while (canonicalPaths.size > 1000) canonicalPaths.delete(canonicalPaths.keys().next().value!);
	return real;
}

/** 只规范工作区身份，不改变会话文件路径。去重保留首次出现的位置，读取不改写注册表。 */
async function normalizeWorkspaces(data: WorkspaceFile, fresh = false): Promise<WorkspaceFile> {
	const paths = new Map<string, string>();
	const values = new Set([
		...data.workspaces, ...(data.removedWorkspaces ?? []),
		...Object.keys(data.aliases ?? {}), ...Object.keys(data.growthInit ?? {}),
	]);
	await Promise.all([...values].map(async (value) => paths.set(value, await canonicalWorkspacePath(value, { fresh }))));
	const canonical = (value: string) => paths.get(value) ?? value;
	const unique = (values: string[]) => {
		const seen = new Set<string>();
		return values.map(canonical).filter((value) => {
			const key = pathKey(value);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	};
	const normalizeKeys = <T>(values: Record<string, T>) => {
		const result: Record<string, T> = {};
		for (const [original, value] of Object.entries(values)) {
			const key = pathKey(canonical(original));
			// 已有 canonical 别名优先；否则保留最早的符号链接别名。
			if (!(key in result) || pathKey(original) === key) result[key] = value;
		}
		return result;
	};
	const archivedAt: Record<string, number> = {};
	for (const [original, value] of Object.entries(data.archivedAt ?? {})) {
		if (value <= 0) continue;
		const key = pathKey(original);
		archivedAt[key] = Math.max(archivedAt[key] ?? 0, value);
	}
	return {
		...data,
		workspaces: unique(data.workspaces),
		removedWorkspaces: unique(data.removedWorkspaces ?? []),
		aliases: normalizeKeys(data.aliases ?? {}),
		archivedAt,
		...(data.growthInit ? { growthInit: normalizeKeys(data.growthInit) } : {}),
	};
}

async function write(data: WorkspaceFile, target: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
		// D3：replaceFileAtomically 在 rename 前 fsync 临时文件、成功后 fsync 目录项，
		// 断电时注册表要么是完整旧版、要么是完整新版（目录 fsync 不可用时安全降级）。
		await replaceFileAtomically(temporary, target);
		lastGood = { path: target, data: structuredClone(data) };
	} finally {
		await fs.unlink(temporary).catch(() => undefined);
	}
}

function emptyRegistry(): WorkspaceFile {
	return { workspaces: [], aliases: {}, archivedSessions: [], pinnedSessions: [], removedWorkspaces: [] };
}

interface Snapshot {
	path: string;
	stamp: string;
	data: WorkspaceFile;
}

let snapshot: Snapshot | null = null;
/** 写后缓存失效不会丢掉最后一次完整读取/写入的可恢复记录。 */
let lastGood: { path: string; data: WorkspaceFile } | null = null;

/** 校验戳：mtime + ctime + 大小 + inode 任一变化就回源（写到一半、被别的进程改写、原子替换都能看出来） */
function stampOf(stat: { mtimeMs: number; ctimeMs: number; size: number; ino: number }): string {
	return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
}

/**
 * 读注册表：按校验戳复用的进程内快照。
 *
 * 读不需要排他锁——这里以前走 withSettingsWriteLock + withExternalSettingsLock，
 * 于是侧栏每 3 秒的一次轮询都要在 ~/.pi/agent 里建出再删掉一个 `.lock` 目录；
 * 只读家目录、杀软扫描、或另一个 pi 进程留着锁时，整个会话列表会直接 500 并每次重试 2 秒。
 * 写路径仍然是「锁 + 原子替换」，所以并发读只会看到旧版或新版整体。
 * 返回值只读：要改数据走 mutate()。
 */
async function readCached(target: string): Promise<WorkspaceFile> {
	let stat;
	try {
		stat = await fs.stat(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		snapshot = null;
		return emptyRegistry();
	}
	const stamp = stampOf(stat);
	if (snapshot && snapshot.path === target && snapshot.stamp === stamp) return snapshot.data;
	const data = await readFile(target);
	snapshot = { path: target, stamp, data };
	lastGood = { path: target, data: structuredClone(data) };
	return data;
}

async function read(agentDir?: string): Promise<WorkspaceFile> {
	// 每次重新解析符号链接，避免链接改指向后沿用注册表快照中的旧 realpath。
	return normalizeWorkspaces(await readCached(file(agentDir)));
}

async function mutate<T>(change: (data: WorkspaceFile, target: string) => Promise<T> | T, agentDir?: string): Promise<T> {
	const target = file(agentDir);
	return withSettingsWriteLock(target, () => withExternalSettingsLock(target, async () => {
		try {
			canonicalPaths.clear();
			let data: WorkspaceFile;
			try { data = await readFile(target); }
			catch (error) {
				if (!(error instanceof SyntaxError || error instanceof RegistryFormatError)) throw error;
				const saved = await createRecoverableCopy(target, { reason: "修复损坏的工作区记录，保留原文件副本" });
				const previous = lastGood?.path === target ? lastGood.data : undefined;
				data = previous ? structuredClone(previous) : emptyRegistry();
				data.recovery = {
					at: Date.now(), source: previous ? "last-good" : "empty", backup: path.basename(saved.backup),
					restored: { workspaces: data.workspaces.length, aliases: Object.keys(data.aliases ?? {}).length,
						archivedSessions: data.archivedSessions?.length ?? 0, pinnedSessions: data.pinnedSessions?.length ?? 0 },
				};
				await write(data, target);
			}
			return await change(await normalizeWorkspaces(data, true), target);
		} finally {
			// 写完（或失败）都让下一次读重新取戳，避免把内存快照留在旧内容上
			snapshot = null;
		}
	}));
}

export async function listAdded(): Promise<string[]> {
	return (await read()).workspaces;
}

export async function getRemovedWorkspaces(): Promise<string[]> {
	return (await read()).removedWorkspaces ?? [];
}

export async function getAliases(): Promise<Record<string, string>> {
	return (await read()).aliases ?? {};
}

export async function setAlias(dir: string, name: string): Promise<Record<string, string>> {
	return mutate(async (data, target) => {
		const key = pathKey(await canonicalWorkspacePath(dir));
		if (!data.aliases) data.aliases = {};
		// 键统一走 pathKey（win32 小写），并清掉历史遗留的大小写变体，避免别名时有时无
		for (const existing of Object.keys(data.aliases)) {
			if (existing !== key && pathKey(existing) === key) delete data.aliases[existing];
		}
		if (name.trim()) {
			data.aliases[key] = name.trim();
		} else {
			delete data.aliases[key];
		}
		await write(data, target);
		return data.aliases;
	});
}

export async function isHomeWorkspace(dir: string): Promise<boolean> {
	const [root, home] = await Promise.all([canonicalWorkspacePath(dir), canonicalWorkspacePath(os.homedir())]);
	return pathKey(root) === pathKey(home);
}

/** A saved choice takes precedence. Home is browse-only until recording is explicitly enabled. */
export async function getGrowthInitConsent(dir: string): Promise<boolean> {
	return (await read()).growthInit?.[pathKey(await canonicalWorkspacePath(dir))] ?? !(await isHomeWorkspace(dir));
}

export async function setGrowthInitConsent(dir: string, allow: boolean): Promise<void> {
	await mutate(async (data, target) => {
		const key = pathKey(await canonicalWorkspacePath(dir));
		data.growthInit = { ...data.growthInit, [key]: allow };
		await write(data, target);
	});
}

export async function getArchivedSessions(agentDir?: string): Promise<string[]> {
	return (await read(agentDir)).archivedSessions ?? [];
}

export async function getPinnedSessions(): Promise<string[]> {
	return (await read()).pinnedSessions ?? [];
}

/** 只读查询：旧记录缺失归档时间时保持未知，不在侧栏轮询中迁移或写盘。 */
async function effectiveArchiveTimes(data: WorkspaceFile): Promise<Record<string, number>> {
	const sessions = data.archivedSessions ?? [];
	const times: Record<string, number> = {};
	// 按归档列表预先固定键顺序，文件查询只更新值，保证轮询 ETag 稳定。
	for (const sessionPath of sessions) {
		const key = pathKey(sessionPath);
		const archivedAt = data.archivedAt?.[key];
		if (archivedAt !== undefined) times[key] = archivedAt;
	}
	let next = 0;
	// 大量归档也只保留有限个文件查询，避免一次轮询排入数千个 I/O 请求。
	await Promise.all(Array.from({ length: Math.min(8, sessions.length) }, async () => {
		while (next < sessions.length) {
			const sessionPath = sessions[next++];
			const key = pathKey(sessionPath);
			const archivedAt = data.archivedAt?.[key];
			if (archivedAt === undefined) continue;
			let since = archivedAt;
			try {
				const stat = await fs.stat(sessionPath);
				if (stat.isFile()) since = Math.max(since, stat.mtimeMs);
			} catch { /* 文件暂不可读时仍保留已知的归档时间，不影响整个侧栏。 */ }
			times[key] = since;
		}
	}));
	return times;
}

export async function getWorkspaceRegistry(): Promise<WorkspaceRegistrySnapshot> {
	let data: WorkspaceFile;
	let error: string | undefined;
	let errorCode: string | undefined;
	try { data = await read(); }
	catch (failure) {
		const corrupt = failure instanceof SyntaxError || failure instanceof RegistryFormatError;
		error = corrupt ? "工作区记录无法读取，原文件已保留；下一次修改会先备份再恢复记录。"
			: "工作区记录无法读取，原文件已保留；请检查文件权限或稍后重试。";
		errorCode = corrupt ? "REGISTRY_CORRUPT" : apiError(failure).errorCode;
		data = await normalizeWorkspaces(lastGood?.path === file() ? lastGood.data : emptyRegistry());
	}
	return {
		workspaces: data.workspaces,
		aliases: data.aliases ?? {},
		archivedSessions: data.archivedSessions ?? [],
		archivedAt: await effectiveArchiveTimes(data),
		pinnedSessions: data.pinnedSessions ?? [],
		removedWorkspaces: data.removedWorkspaces ?? [],
		...(error ? { error } : {}),
		...(errorCode ? { errorCode } : {}),
		...recoveryNotice(data),
	};
}

/** 修改接口也返回持久化恢复提示，避免把重建记录当作无损的普通成功。 */
export async function getWorkspaceRecoveryNotice(): Promise<Pick<WorkspaceRegistrySnapshot, "warning" | "recovery">> {
	try { return recoveryNotice(await read()); }
	catch {
		return lastGood?.path === file() ? recoveryNotice(lastGood.data) : {};
	}
}

export async function pinSession(sessionPath: string): Promise<string[]> {
	const norm = path.resolve(sessionPath);
	const key = pathKey(norm);
	return mutate(async (data, target) => {
		if (!data.pinnedSessions) data.pinnedSessions = [];
		if (!data.pinnedSessions.some((p) => pathKey(p) === key)) {
			data.pinnedSessions.push(norm);
			await write(data, target);
		}
		return data.pinnedSessions;
	});
}

export async function unpinSession(sessionPath: string): Promise<string[]> {
	const norm = path.resolve(sessionPath);
	const key = pathKey(norm);
	return mutate(async (data, target) => {
		const previous = data.pinnedSessions ?? [];
		const next = previous.filter((p) => pathKey(p) !== key);
		if (next.length !== previous.length) {
			data.pinnedSessions = next;
			await write(data, target);
		}
		return next;
	});
}

export async function archiveSession(sessionPath: string, agentDir?: string): Promise<string[]> {
	const norm = path.resolve(sessionPath);
	const key = pathKey(norm);
	return mutate(async (data, target) => {
		let changed = false;
		if (!data.archivedSessions) data.archivedSessions = [];
		if (!data.archivedSessions.some((p) => pathKey(p) === key)) {
			data.archivedSessions.push(norm);
			data.archivedAt = { ...data.archivedAt, [key]: Date.now() };
			changed = true;
		}
		if (data.pinnedSessions?.some((p) => pathKey(p) === key)) {
			data.pinnedSessions = data.pinnedSessions.filter((p) => pathKey(p) !== key);
			changed = true;
		}
		if (changed) await write(data, target);
		return data.archivedSessions;
	}, agentDir);
}

export async function forgetSession(sessionPath: string, agentDir?: string): Promise<string[]> {
	const norm = path.resolve(sessionPath);
	const key = pathKey(norm);
	return mutate(async (data, target) => {
		const previous = data.archivedSessions ?? [];
		const next = previous.filter((p) => pathKey(p) !== key);
		const hadTime = !!data.archivedAt && key in data.archivedAt;
		let pinnedChanged = false;
		if (data.pinnedSessions?.some((p) => pathKey(p) === key)) {
			data.pinnedSessions = data.pinnedSessions.filter((p) => pathKey(p) !== key);
			pinnedChanged = true;
		}
		if (next.length !== previous.length || hadTime || pinnedChanged) {
			data.archivedSessions = next;
			if (data.archivedAt) delete data.archivedAt[key];
			await write(data, target);
		}
		return next;
	}, agentDir);
}

export async function addWorkspace(dir: string): Promise<{ workspaces: string[]; removedWorkspaces: string[] }> {
	return mutate(async (data, target) => {
		// 取得写锁后再解析路径，保留并发 addWorkspace 的调用顺序。
		const norm = await canonicalWorkspacePath(dir);
		const key = pathKey(norm);
		let changed = false;
		if (!data.workspaces.some((w) => pathKey(w) === key)) {
			data.workspaces.push(norm);
			changed = true;
		}
		if (data.removedWorkspaces) {
			const next = data.removedWorkspaces.filter((w) => pathKey(w) !== key);
			changed ||= next.length !== data.removedWorkspaces.length;
			data.removedWorkspaces = next;
		}
		if (changed) await write(data, target);
		return { workspaces: data.workspaces, removedWorkspaces: data.removedWorkspaces ?? [] };
	});
}

/** 自动扫描保留已移除状态；用户主动导入时可重新显示对应工作区。 */
export async function registerCwds(cwds: string[], { restoreRemoved = false }: { restoreRemoved?: boolean } = {}): Promise<string[]> {
	const target = file();
	const normalizedCwds = await Promise.all(cwds.filter((cwd) => typeof cwd === "string" && cwd).map((cwd) => canonicalWorkspacePath(cwd)));
	// 快路径：侧栏每 3 秒轮询一次，绝大多数时候没有任何新 cwd。
	// 先在内存快照上判断，没有新增就不取锁、不写盘、不读文件。
	const current = await normalizeWorkspaces(await readCached(target));
	const removedKeys = new Set((current.removedWorkspaces ?? []).map(pathKey));
	const knownKeys = new Set(current.workspaces.map(pathKey));
	let missing = false;
	for (const cwd of normalizedCwds) {
		const key = pathKey(cwd);
		if (removedKeys.has(key)) {
			if (restoreRemoved) missing = true;
			continue;
		}
		if (knownKeys.has(key)) continue;
		knownKeys.add(key);
		missing = true;
	}
	if (!missing) return current.workspaces;

	return mutate(async (data, writeTarget) => {
		let changed = false;
		if (restoreRemoved) {
			const requestedKeys = new Set(normalizedCwds.map(pathKey));
			const previous = data.removedWorkspaces ?? [];
			const next = previous.filter((cwd) => !requestedKeys.has(pathKey(cwd)));
			if (next.length !== previous.length) {
				data.removedWorkspaces = next;
				changed = true;
			}
		}
		const removed = new Set((data.removedWorkspaces ?? []).map(pathKey));
		const existingKeys = new Set(data.workspaces.map(pathKey));

		for (const norm of normalizedCwds) {
			const key = pathKey(norm);
			if (!removed.has(key) && !existingKeys.has(key)) {
				data.workspaces.push(norm);
				existingKeys.add(key);
				changed = true;
			}
		}
		if (changed) await write(data, writeTarget);
		return data.workspaces;
	});
}

export async function removeWorkspace(dir: string): Promise<{ workspaces: string[]; removedWorkspaces: string[]; aliases: Record<string, string> }> {
	return mutate(async (data, target) => {
		const norm = await canonicalWorkspacePath(dir);
		const key = pathKey(norm);
		data.workspaces = data.workspaces.filter((w) => pathKey(w) !== key);
		if (!data.removedWorkspaces) data.removedWorkspaces = [];
		if (!data.removedWorkspaces.some((w) => pathKey(w) === key)) {
			data.removedWorkspaces.push(norm);
		}
		if (data.aliases) {
			for (const k of Object.keys(data.aliases)) {
				if (pathKey(k) === key) delete data.aliases[k];
			}
		}
		await write(data, target);
		return { workspaces: data.workspaces, removedWorkspaces: data.removedWorkspaces, aliases: data.aliases ?? {} };
	});
}

let picking = false;

/** 收集子进程 stdout（utf8）与 stderr 尾部，带超时；退出码非 0 抛错 */
function runDialog(argv: string[], opts: { timeoutMs?: number; windowsHide?: boolean } = {}): Promise<string> {
	const { timeoutMs = 5 * 60 * 1000, windowsHide = false } = opts;
	return new Promise<string>((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], windowsHide });
		const decoder = new StringDecoder("utf8");
		let buf = "";
		let stderr = "";
		let decoderEnded = false;
		child.stdout.on("data", (data: Buffer) => {
			buf += decoder.write(data);
		});
		child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-1000); });
		let settled = false;
		let timeout: ReturnType<typeof setTimeout>;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (!decoderEnded) {
				decoderEnded = true;
				buf += decoder.end();
			}
			if (error) reject(error);
			else resolve(buf.trim());
		};
		child.on("error", (error) => finish(error));
		child.on("close", (code) => finish(code === 0 ? undefined : new Error(stderr || `folder picker exited with code ${code}`)));
		timeout = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			finish(new Error("folder picker timed out"));
		}, timeoutMs);
	});
}

/**
 * osascript 输出转 POSIX 路径。
 * `POSIX path of ...` 输出 `/Users/...`（带引号，内部转义）；裸 `choose folder` 输出
 * HFS 冒号格式 `alias Macintosh HD:Users:...`——后端按 POSIX 解析会 workspace not found。
 */
function applePathToPosix(out: string): string {
	let s = out.trim();
	// 去掉 alias 前缀与包裹引号
	s = s.replace(/^alias\s+/i, "").replace(/^"(.*)"$/s, "$1");
	// 已经是 POSIX 路径
	if (s.startsWith("/")) return s.replace(/\\(.)/g, "$1");
	// HFS 冒号格式：Macintosh HD:Users:kaijimima:proj: → /Users/kaijimima/proj
	if (/^[A-Za-z][A-Za-z0-9 ]*:(.+)$/.test(s)) {
		const rest = s.slice(s.indexOf(":") + 1);
		return `/${rest.split(":").filter(Boolean).join("/")}`;
	}
	return s;
}

/**
 * 弹出系统原生文件夹选择对话框。
 * - Windows：PowerShell 脚本（现代资源管理器风格，屏幕居中）
 * - macOS：osascript choose folder（原生选择框）
 * - Linux：zenity / kdialog（哪个可用用哪个）
 * 都不可用时抛错，由接口通知前端打开应用内目录浏览器。
 */
export async function pickFolderNative(purpose: "workspace" | "source" = "workspace"): Promise<{ path: string | null; canceled: boolean }> {
	if (picking) return { path: null, canceled: true };
	picking = true;
	const title = purpose === "source" ? "选择本地目录" : "选择工作区文件夹";
	try {
		if (process.platform === "win32") {
			const script = path.join(APP_ROOT, "scripts", "pick-folder.ps1");
			const out = await runDialog(
				["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, title],
				{ windowsHide: true },
			);
			return out ? { path: out, canceled: false } : { path: null, canceled: true };
		}
		if (process.platform === "darwin") {
			// 直接要 POSIX path 输出；老 osascript / 异常路径由 applePathToPosix 兜底转换
			try {
				const out = await runDialog(["osascript", "-e", `POSIX path of (choose folder with prompt "${title}")`]);
				const p = applePathToPosix(out);
				return p ? { path: p, canceled: false } : { path: null, canceled: true };
			} catch (error) {
				// 用户取消是 AppleScript -128；错误文案随系统语言变化。
				if (error instanceof Error && /\(-128\)\s*$/.test(error.message)) return { path: null, canceled: true };
				throw error;
			}
		}
		// Linux /其他：zenity → kdialog
		for (const argv of [
			["zenity", "--file-selection", "--directory", `--title=${title}`],
			["kdialog", "--getexistingdirectory", `${os.homedir()}`, "--title", title],
		]) {
			try {
				const out = await runDialog(argv);
				return out ? { path: out, canceled: false } : { path: null, canceled: true };
			} catch (error) {
				// 未安装（ENOENT）→ 试下一个；用户取消的 zenity 退出码 1 但 stdout 可能为空
				if (error instanceof Error && /ENOENT|not found|not recognized/i.test(error.message)) continue;
				if (/exited with code (1|5)$/.test(error instanceof Error ? error.message : String(error))) return { path: null, canceled: true };
				throw error;
			}
		}
		throw new Error("no folder picker available: install zenity or kdialog, or type the path manually");
	} finally {
		picking = false;
	}
}
