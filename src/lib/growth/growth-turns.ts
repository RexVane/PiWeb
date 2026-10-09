interface SessionEntry {
	type?: string;
	id?: string;
	message?: { role?: string; content?: unknown };
}

export interface RoundPrompts {
	/** 本轮的用户消息 entryId（按出现顺序） */
	ids: string[];
	/** 第一条用户消息的首个非空行（纯图片提问为空） */
	title: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join("");
}

/**
 * 一次运行（agent_start → agent_settled）新增的用户消息：首条提问 + steer / followUp 追加的消息。
 * 遍历原始 JSONL 条目而不是渲染消息：上下文压缩后不再渲染的消息也算。
 */
export function promptsFromEntries(entries: readonly SessionEntry[], fromIndex = 0): RoundPrompts {
	const ids: string[] = [];
	let title = "";
	for (const entry of entries.slice(Math.max(0, fromIndex))) {
		if (entry.type !== "message" || entry.message?.role !== "user" || !entry.id) continue;
		ids.push(entry.id);
		if (!title) title = textOf(entry.message.content).split("\n").map((line) => line.trim()).find(Boolean) ?? "";
	}
	return { ids, title };
}
