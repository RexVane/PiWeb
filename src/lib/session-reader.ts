/**
 * session-reader：枚举 / 搜索 / 冷读取 ~/.pi/agent/sessions/**.jsonl（pi 零改动）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createHash, randomUUID } from "node:crypto";
import type { SessionSummary, WebMessage } from "./types";
import { getManaged, getSessionHistory, syncSessionsFromDisk } from "./agent-manager";
import type { HistoryPage } from "./chat/web-history";
import { getAgentDir } from "./pi";
import { BoundaryError, isPathInside } from "./path-security";
import { promptTitleText } from "./chat/skill-expansion";
import { canonicalWorkspacePath } from "./workspace-store";
import { listUploadsReferencedBySession, removeUnreferencedUploads } from "./files-service";

function toSummary(info: {
	path: string;
	name?: string;
	cwd: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}): SessionSummary {
	return {
		path: info.path,
		name: info.name,
		cwd: info.cwd,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	};
}

/** Date 能表示的毫秒数（±8.64e15）：超出范围的 toISOString 会抛 RangeError */
function isValidTime(ms: number): boolean {
	return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
}

/** firstMessage 只当侧栏标题与搜索用：整段贴进来的长提问不该随每 3 秒一次的列表轮询反复下发 */
export const FIRST_MESSAGE_MAX_CHARS = 300;

function clipFirstMessage(text: string): string {
	if (text.length <= FIRST_MESSAGE_MAX_CHARS) return text;
	let end = FIRST_MESSAGE_MAX_CHARS;
	const last = text.charCodeAt(end - 1);
	// 别把代理对（emoji 等）切成半个
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}…`;
}

/**
 * 单个 JSONL → 摘要，与 SDK `SessionManager.listAll()` 的口径一致：
 * 首行必须是 session 头；名字取最后一条 session_info；messageCount 计全部 message 条目；
 * firstMessage 取首条用户消息的文本块；modified 取用户 / 助手消息的最后活动时间（没有就回落头时间戳、再回落 mtime）。
 */
async function summarize(filePath: string, stat: { mtime: Date }, cached?: CachedSummary): Promise<SessionSummary | null> {
	try {
		let resumable = cached?.scan && cached.size <= (await fs.stat(filePath)).size ? cached.scan : undefined;
		const handle = await fs.open(filePath, "r");
		let originalMetadata: Awaited<ReturnType<typeof handle.stat>>;
		try { originalMetadata = await handle.stat(); } catch (error) { await handle.close(); throw error; }
		const prefixStamp = async (offset: number) => {
			const first = Buffer.alloc(Math.min(offset, 4096)), last = Buffer.alloc(Math.min(offset, 128));
			const a = await handle.read(first, 0, first.length, 0);
			const b = await handle.read(last, 0, last.length, Math.max(0, offset - last.length));
			return createHash("sha256").update(first.subarray(0, a.bytesRead)).update(last.subarray(0, b.bytesRead)).digest("hex");
		};
		try { if (resumable && (!resumable.stamp || await prefixStamp(resumable.offset) !== resumable.stamp)) resumable = undefined; }
		catch (error) { await handle.close(); throw error; }
		let header: { cwd?: unknown; timestamp?: unknown } | null = resumable?.header ?? null;
		let name: string | undefined = resumable?.name;
		let messageCount = resumable?.messageCount ?? 0;
		let firstMessage = resumable?.firstMessage ?? "";
		let lastActivity: number | undefined = resumable?.lastActivity;
		let offset = resumable?.offset ?? 0;
		let invalidHeader = false;
		const accept = (line: string) => {
			if (!line.trim()) return;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				return;
			}
			if (!header) {
				if (entry?.type !== "session") { invalidHeader = true; return; }
				header = entry;
				return;
			}
			if (entry?.type === "session_info") name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
			if (entry?.type !== "message") return;
			messageCount += 1;
			const message = entry.message;
			if (!message || typeof message.role !== "string" || !("content" in message)) return;
			if (message.role !== "user" && message.role !== "assistant") return;
			const at = typeof message.timestamp === "number" ? message.timestamp : new Date(entry.timestamp).getTime();
			if (isValidTime(at)) lastActivity = Math.max(lastActivity ?? 0, at);
			if (!firstMessage && message.role === "user") {
				const content = message.content;
				firstMessage = clipFirstMessage(promptTitleText(typeof content === "string"
					? content
					: Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") : ""));
			}
		};
		const decoder = new StringDecoder("utf8");
		let pending = "", pendingBytes = 0;
		try {
			const buffer = Buffer.allocUnsafe(64 * 1024);
			let position = offset;
			for (;;) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
				if (!bytesRead) break;
				position += bytesRead;
				let from = 0;
				const chunk = buffer.subarray(0, bytesRead);
				for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, from)) {
					const segment = chunk.subarray(from, at);
					pending += decoder.write(segment); pendingBytes += segment.length;
					accept(pending + decoder.end());
					offset += pendingBytes + 1;
					pending = ""; pendingBytes = 0; from = at + 1;
				}
				const remainder = chunk.subarray(from);
				pending += decoder.write(remainder); pendingBytes += remainder.length;
			}
			// A partially appended last record is retried next scan, never cached as complete.
			// Valid JSON without LF is still retried: the writer may append to this
			// exact line. A complete snapshot never skips an unfinished delimiter.
			if (pending) { try { const final = pending + decoder.end(); JSON.parse(final); accept(final); } catch { /* incomplete line */ } }
			if (cached) {
				cached.scan = { header, name, messageCount, firstMessage, lastActivity, offset, stamp: await prefixStamp(offset) };
				cached.ino = originalMetadata.ino;
			}
		} finally { await handle.close(); }
		if (!header || invalidHeader) return null;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const created = isValidTime(headerTime) ? new Date(headerTime) : stat.mtime;
		const modified = lastActivity && lastActivity > 0 ? new Date(lastActivity) : created;
		return toSummary({
			path: filePath,
			name,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			// 头里缺 timestamp 或写坏了：回落 mtime。以前直接 new Date(String(...))，Invalid Date 的 toISOString 一抛，
			// 整个会话就被 catch 吞成 null，从侧栏里悄悄消失
			created,
			modified,
			messageCount,
			firstMessage: clipFirstMessage(firstMessage) || "(no messages)",
		});
	} catch {
		return null;
	}
}

/** 按文件缓存的摘要：mtime 与大小都没变就不重读（侧栏每 3 秒轮询一次，全盘重读几 MB JSONL 太浪费） */
const summaryCache = new Map<string, CachedSummary>();
/** 并发列表请求共用一次扫描 */
let scanning: Promise<SessionSummary[]> | null = null;
let scanSource: string | null = null;
let indexLoading: { source: string; promise: Promise<void> } | null = null;

interface CachedSummary {
	mtimeMs: number;
	size: number;
	summary: SessionSummary | null;
	ino?: number;
	scan?: { header: { cwd?: unknown; timestamp?: unknown } | null; name?: string; messageCount: number; firstMessage: string; lastActivity?: number; offset: number; stamp?: string };
}

/**
 * 摘要缓存落盘：进程内的 summaryCache 一重启就没了，而冷启动要把 ~/.pi/agent/sessions 下
 * 的 JSONL 全量解析一遍（本机 36 个会话 / 17.5MB ≈ 136ms，会话越多越贵）。落盘后重启只需
 * 按 mtime + 大小校验，命中就沿用摘要——侧栏首次渲染从"全量解析"变成"读一个小 JSON"。
 * 索引只是加速：读不到、版本不符、写不进去都退化成全量扫描，绝不影响正确性。
 */
/**
 * 2：firstMessage 开始截断，旧索引里的整段原文要重新摘要
 * 3：技能展开的首条消息还原成 `/skill:name 参数`，旧索引里存的是 `<skill name=…>` 加 SKILL.md 正文
 * 4：头时间戳坏掉的会话不再摘要成 null，旧索引里缓存的 null 要重读才能回到侧栏
 */
const INDEX_VERSION = 5;
const INDEX_FILENAME = "piweb-session-index.json";
const INDEX_MAX_ENTRIES = 5000;
const INDEX_SAVE_DELAY_MS = 1500;
let indexLoadedFrom: string | null = null;
let indexDirty = false;
let indexTimer: ReturnType<typeof setTimeout> | null = null;

function indexPath(): string {
	return path.join(getAgentDir(), INDEX_FILENAME);
}

type IndexEntry = [mtimeMs: number, size: number, summary: SessionSummary | null, scan?: CachedSummary["scan"], ino?: number];

async function loadIndex(): Promise<void> {
	const source = indexPath();
	if (indexLoadedFrom === source && !indexLoading) return;
	if (indexLoading?.source === source) return indexLoading.promise;
	const promise = loadIndexData(source).finally(() => { if (indexLoading?.promise === promise) indexLoading = null; });
	indexLoading = { source, promise };
	return promise;
}

async function loadIndexData(target: string): Promise<void> {
	if (indexLoadedFrom === target) return;
	indexLoadedFrom = target;
	listCache = null;
	// 会话库换了目录（PI_CODING_AGENT_DIR）就不能再沿用上一个目录的摘要
	summaryCache.clear();
	try {
		const raw = JSON.parse(await fs.readFile(target, "utf8")) as { version?: unknown; entries?: Record<string, unknown> };
		if (raw?.version !== INDEX_VERSION || !raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) return;
		for (const [file, entry] of Object.entries(raw.entries).slice(0, INDEX_MAX_ENTRIES)) {
			if (!Array.isArray(entry) || entry.length < 3 || entry.length > 5) continue;
			const [mtimeMs, size, summary, scan, ino] = entry as IndexEntry;
			if (!Number.isFinite(mtimeMs) || !Number.isSafeInteger(size) || size < 0) continue;
			const validSummary = summary && typeof summary === "object" && summary.path === file && typeof summary.cwd === "string"
				&& (summary.name === undefined || typeof summary.name === "string")
				&& typeof summary.created === "string" && !Number.isNaN(Date.parse(summary.created))
				&& typeof summary.modified === "string" && !Number.isNaN(Date.parse(summary.modified))
				&& Number.isSafeInteger(summary.messageCount) && summary.messageCount >= 0 && typeof summary.firstMessage === "string";
			if (summary !== null && !validSummary) continue;
			const validScan = scan && typeof scan === "object" && scan.header && typeof scan.header === "object"
				&& (scan.name === undefined || typeof scan.name === "string")
				&& (scan.lastActivity === undefined || isValidTime(scan.lastActivity))
				&& typeof scan.stamp === "string" && /^[a-f0-9]{64}$/.test(scan.stamp)
				&& Number.isSafeInteger(scan.messageCount) && scan.messageCount >= 0 && typeof scan.firstMessage === "string"
				&& Number.isSafeInteger(scan.offset) && scan.offset >= 0 && scan.offset <= size;
			if (validSummary) summary.firstMessage = clipFirstMessage(summary.firstMessage);
			if (validScan) scan.firstMessage = clipFirstMessage(scan.firstMessage);
			summaryCache.set(file, { mtimeMs, size, summary: validSummary ? summary : null, ...(typeof ino === "number" && Number.isFinite(ino) ? { ino } : {}), ...(validScan ? { scan } : {}) });
		}
	} catch {
		/* 首次运行没有索引，或索引损坏：全量扫描即可 */
	}
}

function scheduleIndexSave(): void {
	indexDirty = true;
	if (indexTimer) return;
	indexTimer = setTimeout(() => {
		indexTimer = null;
		void saveIndex();
	}, INDEX_SAVE_DELAY_MS);
	indexTimer.unref?.();
}

async function saveIndex(): Promise<void> {
	if (!indexDirty) return;
	indexDirty = false;
	// 写回缓存所属的那个目录：索引路径不能在落盘时重新解析（会话库换目录时会把 A 的摘要写进 B）
	const target = indexLoadedFrom;
	if (!target) return;
	const entries: Record<string, IndexEntry> = {};
	// 只留最近改动的若干条，避免索引本身无限长
	for (const [file, cached] of [...summaryCache.entries()].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs).slice(0, INDEX_MAX_ENTRIES)) {
		entries[file] = [cached.mtimeMs, cached.size, cached.summary, cached.scan, cached.ino];
	}
	try {
		await fs.mkdir(path.dirname(target), { recursive: true });
		const temporary = target + "." + randomUUID() + ".tmp";
		try {
			await fs.writeFile(temporary, JSON.stringify({ version: INDEX_VERSION, entries }), "utf8");
			await fs.rename(temporary, target);
		} finally {
			await fs.rm(temporary, { force: true }).catch(() => undefined);
		}
	} catch {
		/* 索引写不进去只影响速度，下一次列表请求照常扫描 */
	}
}

/** 扫描失败的可见记录：以前所有 readdir 异常都被当成“没有会话”，EACCES/磁盘故障会让侧栏静默变空 */
function logSessionScanFailure(scope: string, target: string, error: unknown): void {
	console.warn(`[session-reader] 读取${scope}失败（${target}）：${error instanceof Error ? error.message : String(error)}`);
}

async function scanSessions(): Promise<SessionSummary[]> {
	const root = path.join(getAgentDir(), "sessions");
	const files: string[] = [];
	let dirs: import("node:fs").Dirent[] = [];
	try {
		dirs = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		// 会话库根目录还没有（首次启动/从未用过 pi）才是“没有会话”；其它错误必须向上报，不能伪装成空列表
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		logSessionScanFailure("会话目录", root, error);
		throw error;
	}
	await Promise.all(dirs.filter((d) => d.isDirectory() || d.isSymbolicLink()).map(async (d) => {
		const directory = path.join(root, d.name);
		try {
			for (const f of await fs.readdir(directory)) if (f.endsWith(".jsonl")) files.push(path.join(directory, f));
		} catch (error) {
			// 目录在扫描期间被删掉是正常并发，按空处理；其它错误（权限、IO）上报
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			logSessionScanFailure("会话子目录", directory, error);
			throw error;
		}
	}));
	const seen = new Set<string>();
	const out: SessionSummary[] = [];
	const BATCH = 16;
	let changed = false;
	for (let i = 0; i < files.length; i += BATCH) {
		await Promise.all(files.slice(i, i + BATCH).map(async (file) => {
			seen.add(file);
			const stat = await fs.stat(file).catch(() => null);
			if (!stat?.isFile()) return;
			const cached = summaryCache.get(file);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && (cached.ino === undefined || cached.ino === stat.ino)) {
				if (cached.summary) out.push(cached.summary);
				return;
			}
			const next: CachedSummary = { mtimeMs: stat.mtimeMs, size: stat.size, summary: null };
			if (cached && cached.ino === stat.ino && stat.size > cached.size && cached.scan && cached.scan.offset === cached.size) next.scan = cached.scan;
			const summary = await summarize(file, stat, next);
			next.summary = summary;
			summaryCache.set(file, next);
			changed = true;
			if (summary) out.push(summary);
		}));
	}
	for (const key of summaryCache.keys()) {
		if (!seen.has(key)) {
			summaryCache.delete(key);
			changed = true;
		}
	}
	if (changed) scheduleIndexSave();
	return out;
}

/** 列表短缓存：多标签每 3 秒各轮询一次，1.2 秒 TTL 吸收并发请求 */
let listCache: { at: number; source: string; list: SessionSummary[] } | null = null;

export interface SessionListOptions {
	/** 跳过排序后的前 N 条；只在传了 limit 时生效 */
	offset?: number;
	/** 最多返回多少条；不传（默认）= 返回全量，不设任何默认上限 */
	limit?: number;
}

export async function listSessions(query?: string, options: SessionListOptions = {}): Promise<SessionSummary[]> {
	const source = indexPath();
	let list: SessionSummary[];
	if (listCache && listCache.source === source && Date.now() - listCache.at < 1200) {
		list = listCache.list;
	} else {
		if (scanning && scanSource !== source) await scanning;
		await loadIndex();
		scanSource = source;
		scanning ??= scanSessions().finally(() => { scanning = null; scanSource = null; });
		list = await scanning;
		listCache = { at: Date.now(), source, list };
		// 顺带看看开着的会话有没有被终端 pi 写过（见 agent-manager syncWithDisk）
		syncSessionsFromDisk();
	}
	if (query?.trim()) {
		const q = query.trim().toLowerCase();
		list = list.filter(
			(s) =>
				s.name?.toLowerCase().includes(q) ||
				s.firstMessage.toLowerCase().includes(q) ||
				s.cwd.toLowerCase().includes(q),
		);
	}
	// 同一时间戳的会话按路径定序：扫描是并发的，顺序不固定会让 ETag 抖动、侧栏顺序跳动
	list = [...list].sort((a, b) => b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path));
	const { limit, offset } = options;
	// 分页是可选的：不传 limit 时返回全量（老调用方语义），只在调用方显式要一页时才截断。
	// 参数非法时整段忽略（退化成全量），不静默返回一个不完整的列表。
	if (limit === undefined) return list;
	const start = offset ?? 0;
	if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(start) || start < 0) return list;
	return list.slice(start, start + limit);
}

export async function deleteSession(sessionPath: string): Promise<void> {
	const root = path.join(getAgentDir(), "sessions");
	const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
	const target = path.resolve(sessionPath);
	if (path.extname(target).toLowerCase() !== ".jsonl" || (!isPathInside(root, target) && !isPathInside(realRoot, target))) {
		throw new BoundaryError("session path is outside the Pi session store");
	}
	const realTarget = await fs.realpath(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return target;
		throw error;
	});
	if (realTarget !== target && !isPathInside(realRoot, realTarget)) throw new BoundaryError("session path escapes the Pi session store");
	// I3：删除会话时把它独占引用的上传附件也清掉。先读要删的会话找出候选附件，再删文件，
	// 最后确认没有别的会话还引用它们；任何一步证据不足都保留附件（宁可不删也不误删）。
	const uploads = await listUploadsReferencedBySession(target).catch(() => []);
	try {
		await fs.unlink(target);
	} catch (error) {
		// 未落盘的惰性会话（还没发过消息）本来就没有文件，删除视为成功
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (uploads.length) await removeUnreferencedUploads(uploads).catch(() => undefined);
}

/** 冷读取：还原消息（含被压缩掉的历史）+ 会话名（不启动 agent） */
export async function readSession(sessionPath: string): Promise<{
	cwd: string;
	name: string;
	messages: WebMessage[];
	historyPage: Omit<HistoryPage, "messages" | "trajectory">;
}> {
	const managed = getManaged(sessionPath);
	const { messages, trajectory: _trajectory, ...page } = getSessionHistory(managed);
	const sm = managed.sm;
	let name = "";
	try {
		name = (sm as unknown as { getSessionName?: () => string }).getSessionName?.() ?? "";
	} catch {
		name = "";
	}
	return { cwd: await canonicalWorkspacePath(sm.getCwd()), name, messages, historyPage: page };
}
