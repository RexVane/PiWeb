/**
 * session-reader：枚举 / 搜索 / 冷读取 ~/.pi/agent/sessions/**.jsonl（pi 零改动）。
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSummary, WebMessage } from "./types";
import { toWebMessage } from "./agent-manager";
import { getAgentDir } from "./pi";
import { BoundaryError, isPathInside } from "./path-security";

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
			if (Number.isFinite(at)) lastActivity = Math.max(lastActivity ?? 0, at);
			if (!firstMessage && message.role === "user") {
				const content = message.content;
				firstMessage = typeof content === "string"
					? content
					: Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") : "";
			}
		}
		if (!header) return null;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified = lastActivity && lastActivity > 0 ? new Date(lastActivity) : !Number.isNaN(headerTime) ? new Date(headerTime) : stat.mtime;
		return toSummary({
			path: filePath,
			name,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			created: new Date(String(header.timestamp)),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
		});
	} catch {
		return null;
	}
}

/** 按文件缓存的摘要：mtime 与大小都没变就不重读（侧栏每 3 秒轮询一次，全盘重读几 MB JSONL 太浪费） */
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: SessionSummary | null }>();
/** 并发列表请求共用一次扫描 */
let scanning: Promise<SessionSummary[]> | null = null;

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
			if (summary) out.push(summary);
		}));
	}
	for (const key of summaryCache.keys()) if (!seen.has(key)) summaryCache.delete(key);
	return out;
}

/** 列表短缓存：多标签每 3 秒各轮询一次，1.2 秒 TTL 吸收并发请求 */
let listCache: { at: number; list: SessionSummary[] } | null = null;

export async function listSessions(query?: string): Promise<SessionSummary[]> {
	let list: SessionSummary[];
	if (listCache && Date.now() - listCache.at < 1200) {
		list = listCache.list;
	} else {
		scanning ??= scanSessions().finally(() => { scanning = null; });
		list = await scanning;
		listCache = { at: Date.now(), list };
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
	if (path.extname(target).toLowerCase() !== ".jsonl" || !isPathInside(path.resolve(root), target)) {
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

/** 冷读取：还原上下文消息 + 会话名（不启动 agent） */
export async function readSession(sessionPath: string): Promise<{
	cwd: string;
	name: string;
	messages: WebMessage[];
}> {
	const sm = SessionManager.open(sessionPath);
	let messages: WebMessage[] = [];
	try {
		const entries = sm.buildContextEntries();
		messages = entries
			.filter((e: any) => e.type === "message" && e.message)
			.map((e: any) => toWebMessage(e.message, e.id));
	} catch {
		messages = [];
	}
	let name = "";
	try {
		name = (sm as unknown as { getSessionName?: () => string }).getSessionName?.() ?? "";
	} catch {
		name = "";
	}
	return { cwd: sm.getCwd(), name, messages };
}
