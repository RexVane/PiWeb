/**
 * session-reader：枚举 / 搜索 / 冷读取 ~/.pi/agent/sessions/**.jsonl（pi 零改动）。
 */
import fs from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSummary, WebMessage } from "./types";
import { toWebMessage } from "./agent-manager";

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

/** 列表短缓存：多标签每 3 秒各轮询一次会全盘扫描 JSONL，1.2 秒 TTL 吸收并发请求 */
let listCache: { at: number; list: SessionSummary[] } | null = null;

export async function listSessions(query?: string): Promise<SessionSummary[]> {
	let list: SessionSummary[];
	if (listCache && Date.now() - listCache.at < 1200) {
		list = listCache.list;
	} else {
		list = (await SessionManager.listAll()).map(toSummary);
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
	list.sort((a, b) => b.modified.localeCompare(a.modified));
	return list;
}

export async function deleteSession(sessionPath: string): Promise<void> {
	try {
		await fs.unlink(sessionPath);
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
