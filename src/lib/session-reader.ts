/**
 * session-reader：枚举 / 搜索 / 冷读取 ~/.pi/agent/sessions/**.jsonl（pi 零改动）。
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSummary, WebMessage } from "./types";
import { sessionDisplayMessages, syncSessionsFromDisk } from "./agent-manager";
import { getAgentDir } from "./pi";
import { BoundaryError, isPathInside } from "./path-security";
import { promptTitleText } from "./chat/skill-expansion";
import { canonicalWorkspacePath } from "./workspace-store";

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
async function summarize(filePath: string, stat: { mtime: Date }): Promise<SessionSummary | null> {
	try {
		let header: { cwd?: unknown; timestamp?: unknown } | null = null;
		let name: string | undefined;
		let messageCount = 0;
		let firstMessage = "";
		let lastActivity: number | undefined;
		const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
		for await (const line of rl) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (!header) {
				if (entry?.type !== "session") return null;
				header = entry;
				continue;
			}
			if (entry?.type === "session_info") name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
			if (entry?.type !== "message") continue;
			messageCount += 1;
			const message = entry.message;
			if (!message || typeof message.role !== "string" || !("content" in message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const at = typeof message.timestamp === "number" ? message.timestamp : new Date(entry.timestamp).getTime();
			if (isValidTime(at)) lastActivity = Math.max(lastActivity ?? 0, at);
			if (!firstMessage && message.role === "user") {
				const content = message.content;
				firstMessage = promptTitleText(typeof content === "string"
					? content
					: Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") : "");
			}
		}
		if (!header) return null;
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

interface CachedSummary {
	mtimeMs: number;
	size: number;
	summary: SessionSummary | null;
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
const INDEX_VERSION = 4;
const INDEX_FILENAME = "piweb-session-index.json";
const INDEX_MAX_ENTRIES = 5000;
const INDEX_SAVE_DELAY_MS = 1500;
let indexLoadedFrom: string | null = null;
let indexDirty = false;
let indexTimer: ReturnType<typeof setTimeout> | null = null;

function indexPath(): string {
	return path.join(getAgentDir(), INDEX_FILENAME);
}

type IndexEntry = [mtimeMs: number, size: number, summary: SessionSummary | null];

async function loadIndex(): Promise<void> {
	const target = indexPath();
	if (indexLoadedFrom === target) return;
	indexLoadedFrom = target;
	// 会话库换了目录（PI_CODING_AGENT_DIR）就不能再沿用上一个目录的摘要
	summaryCache.clear();
	try {
		const raw = JSON.parse(await fs.readFile(target, "utf8")) as { version?: unknown; entries?: Record<string, unknown> };
		if (raw?.version !== INDEX_VERSION || !raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) return;
		for (const [file, entry] of Object.entries(raw.entries)) {
			if (!Array.isArray(entry) || entry.length !== 3) continue;
			const [mtimeMs, size, summary] = entry as IndexEntry;
			if (typeof mtimeMs !== "number" || typeof size !== "number") continue;
			summaryCache.set(file, { mtimeMs, size, summary: summary && typeof summary === "object" ? summary : null });
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
		entries[file] = [cached.mtimeMs, cached.size, cached.summary];
	}
	try {
		await fs.mkdir(path.dirname(target), { recursive: true });
		const temporary = `${target}.${process.pid}.tmp`;
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

async function scanSessions(): Promise<SessionSummary[]> {
	const root = path.join(getAgentDir(), "sessions");
	const files: string[] = [];
	let dirs: import("node:fs").Dirent[] = [];
	try {
		dirs = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	await Promise.all(dirs.filter((d) => d.isDirectory() || d.isSymbolicLink()).map(async (d) => {
		try {
			for (const f of await fs.readdir(path.join(root, d.name))) if (f.endsWith(".jsonl")) files.push(path.join(root, d.name, f));
		} catch {
			/* 目录读不了就跳过 */
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
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
				if (cached.summary) out.push(cached.summary);
				return;
			}
			const summary = await summarize(file, stat);
			summaryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
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
let listCache: { at: number; list: SessionSummary[] } | null = null;

export async function listSessions(query?: string): Promise<SessionSummary[]> {
	let list: SessionSummary[];
	if (listCache && Date.now() - listCache.at < 1200) {
		list = listCache.list;
	} else {
		await loadIndex();
		scanning ??= scanSessions().finally(() => { scanning = null; });
		list = await scanning;
		listCache = { at: Date.now(), list };
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
	list.sort((a, b) => b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path));
	return list;
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
	try {
		await fs.unlink(target);
	} catch (error) {
		// 未落盘的惰性会话（还没发过消息）本来就没有文件，删除视为成功
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** 冷读取：还原消息（含被压缩掉的历史）+ 会话名（不启动 agent） */
export async function readSession(sessionPath: string): Promise<{
	cwd: string;
	name: string;
	messages: WebMessage[];
}> {
	const sm = SessionManager.open(sessionPath);
	let messages: WebMessage[] = [];
	try {
		messages = sessionDisplayMessages(sm);
	} catch {
		messages = [];
	}
	let name = "";
	try {
		name = (sm as unknown as { getSessionName?: () => string }).getSessionName?.() ?? "";
	} catch {
		name = "";
	}
	return { cwd: await canonicalWorkspacePath(sm.getCwd()), name, messages };
}
