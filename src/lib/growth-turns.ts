export interface SessionTurn {
	id: string;
	ts: number;
}

interface SessionEntry {
	type?: string;
	id?: string;
	timestamp?: string | number;
	message?: { role?: string; timestamp?: number };
}

/** 与会话统计一样遍历全部 JSONL 条目，不使用压缩后的渲染消息列表。 */
export function userTurnsFromEntries(entries: readonly SessionEntry[]): SessionTurn[] {
	const turns: SessionTurn[] = [];
	for (const [index, entry] of entries.entries()) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const entryTime = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(entry.timestamp ?? "");
		const ts = Number.isFinite(entryTime) ? entryTime : entry.message.timestamp;
		turns.push({ id: entry.id ?? `entry:${index}`, ts: typeof ts === "number" && Number.isFinite(ts) ? ts : NaN });
	}
	return turns;
}
