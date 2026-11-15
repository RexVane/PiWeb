import type { TrajEntry, WebMessage } from "../types";

// 首屏快照/SSE 只带最近 300 条；更早的记录在聊天窗口往上滚时按 100 条/页懒加载。
export const MAX_VISIBLE_MESSAGES = 300;
export const MAX_VISIBLE_TRAJECTORY = 1000;
export const MAX_VISIBLE_TOOLS = 500;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 100_000;

/** Display previews have a budget; authoritative content remains in the session/export. */
export function previewMessage(message: WebMessage, imageUrl?: (part: number) => string): WebMessage {
	let truncated = message.truncated === true;
	let remaining = 500_000;
	let imageBudget = 3_000_000;
	let nestedCount = 0;
	const argumentsPreview = (value: unknown): unknown => {
		let encoded: string;
		try { encoded = JSON.stringify(value) ?? ""; } catch { truncated = true; return "[unavailable]"; }
		const maximum = Math.min(8_000, remaining);
		remaining -= Math.min(maximum, encoded.length);
		if (encoded.length <= maximum) return value;
		truncated = true; return { preview: encoded.slice(0, maximum), truncated: true };
	};
	const text = (value: string) => {
		const maximum = Math.min(MAX_TEXT, remaining);
		remaining -= Math.min(value.length, maximum);
		if (value.length <= maximum) return value;
		truncated = true;
		return `${value.slice(0, maximum)}…`;
	};
	const content = message.content.slice(0, 100).map((part, index) => {
		if (part.type === "image" && imageUrl) return { ...part, data: "", url: imageUrl(index) };
		if (part.type === "image" && !part.url) {
			if (part.data.length > imageBudget) { truncated = true; return { type: "text" as const, text: "[Image exceeds the preview limit; original remains in the session export.]" }; }
			imageBudget -= part.data.length;
		}
		if (part.type === "text") return { ...part, text: text(part.text) };
		if (part.type === "thinking") return { ...part, thinking: text(part.thinking) };
		if (part.type === "toolResult") {
			const maximumCalls = Math.max(0, 100 - nestedCount);
			if ((part.nestedCalls?.length ?? 0) > maximumCalls) truncated = true;
			const nestedCalls = part.nestedCalls?.slice(0, maximumCalls).map((call) => {
				nestedCount++;
				return { ...call, id: text(call.id), name: text(call.name), args: argumentsPreview(call.args), error: call.error ? text(call.error) : undefined };
			});
			return { ...part, text: text(part.text), patch: part.patch ? text(part.patch) : part.patch, nestedCalls };
		}
		if (part.type === "toolCall") {
			return { ...part, arguments: argumentsPreview(part.arguments) };
		}
		return part;
	});
	if (message.content.length > 100) truncated = true;
	return { ...message, content, ...(message.bash ? { bash: { ...message.bash, command: text(message.bash.command), output: text(message.bash.output) } } : {}), ...(message.summary ? { summary: text(message.summary) } : {}), ...(truncated ? { truncated: true } : {}) };
}

export interface HistoryPage {
	messages: WebMessage[];
	trajectory: TrajEntry[];
	total: number;
	pageStart: number;
	pageEnd: number;
	olderBefore?: number;
	newerAfter?: number;
}

export function historyPage(messages: WebMessage[], options: { before?: number; after?: number; limit?: number } = {}, project = previewMessage): HistoryPage {
	const total = messages.length;
	const limit = Math.max(1, Math.min(MAX_VISIBLE_MESSAGES, options.limit ?? 100));
	const end = Math.max(0, Math.min(total, options.before ?? (options.after === undefined ? total : options.after + limit)));
	let start = options.after === undefined ? Math.max(0, end - limit) : Math.max(0, Math.min(end, options.after));
	const page: WebMessage[] = [];
	let bytes = 0;
	// Latest-first when returning recent history; forward when advancing a page.
	const forward = options.after !== undefined;
	for (let at = forward ? start : end - 1; forward ? at < end : at >= start; forward ? at++ : at--) {
		const message = project(messages[at]);
		const size = new TextEncoder().encode(JSON.stringify(message)).byteLength;
		if (page.length && bytes + size > MAX_PAGE_BYTES) { if (!forward) start = at + 1; break; }
		page.push(message); bytes += size;
	}
	if (!forward) page.reverse();
	const pageEnd = forward ? start + page.length : end;
	return { messages: page, trajectory: [], total, pageStart: start, pageEnd, ...(start > 0 ? { olderBefore: start } : {}), ...(pageEnd < total ? { newerAfter: pageEnd } : {}) };
}

export function recentTrajectory(entries: TrajEntry[]): TrajEntry[] {
	let bytes = 0;
	const kept: TrajEntry[] = [];
	for (let index = entries.length - 1; index >= 0 && kept.length < MAX_VISIBLE_TRAJECTORY; index--) {
		const entry = entries[index];
		const size = (entry.detail?.length ?? 0) + (entry.thinking?.length ?? 0) + (entry.preview?.length ?? 0) + 512;
		if (kept.length && bytes + size > MAX_PAGE_BYTES) break;
		kept.push(entry); bytes += size;
	}
	return kept.reverse();
}
