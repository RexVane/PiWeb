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

export async function listSessions(query?: string): Promise<SessionSummary[]> {
	const all = await SessionManager.listAll();
	let list = all.map(toSummary);
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
	await fs.unlink(sessionPath);
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
			.map((e: any) => toWebMessage(e.message));
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
