/**
 * Grok CLI（~/.grok/sessions/<URL 编码的 cwd>/<session-uuid>/）
 *
 * 会话目录里有 chat_history.jsonl（正文）与 summary.json（标题/模型/时间/消息数）。
 * chat_history 每行 `{type, content, ...}`：system / user / assistant（含 tool_calls[]）/ reasoning / tool_result。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { eachJsonLine, listFiles, readHead, reachedLimit, sortByRecency } from "./files";
import { grokRoot } from "./paths";
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedSession, ImportSourceModule, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, outputBlocks, parseArguments, textBlock, toEpochMs } from "./types";

const ROOT = grokRoot;

/** 目录名是 URL 编码的 cwd（D%3A%5CAIApp%5CPiWeb），summary.json 缺失时用它兜底 */
function decodeProjectDir(name: string): string | undefined {
	try {
		const decoded = decodeURIComponent(name);
		return /^[A-Za-z]:[\\/]/.test(decoded) || decoded.startsWith("/") ? decoded : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 判断一段 chat_history 里是否有真正能导入的对话：至少一条 assistant，或一条不受合成标记影响的用户消息。
 * 与 read() 的接受口径一致——只列"read 一定能读出来"的会话。
 */
function importable(records: Record<string, unknown>[]): boolean {
	for (const record of records) {
		if (record.type === "assistant" || record.type === "tool_result") return true;
		if (record.type === "reasoning" && typeof record.summary === "string" && record.summary.trim()) return true;
		if (record.type !== "user" || record.synthetic_reason) continue;
		const blocks = userBlocks(record.content);
		if (blocks.some((block) => block.type === "text" && block.text.replace(/<[^>]+>/g, "").trim())) return true;
	}
	return false;
}

async function hasRealMessage(history: string): Promise<boolean> {
	try {
		return importable([...eachJsonLine(await readHead(history))]);
	} catch {
		return false;
	}
}

/** user 的 content 可能是字符串或块数组 */function userBlocks(content: unknown): ImportedBlock[] {
	if (typeof content === "string") return compactBlocks([textBlock(content)]);
	if (!Array.isArray(content)) return [];
	return compactBlocks(content.flatMap((raw): Array<ImportedBlock | null> => {
		if (typeof raw === "string") return [textBlock(raw)];
		const block = raw as Record<string, unknown>;
		if (typeof block?.text === "string") return [textBlock(block.text)];
		return [];
	}));
}

export const grokSource: ImportSourceModule = {
	id: "grok",

	async scan(options?: ScanOptions): Promise<ExternalSessionSummary[]> {
		// 先按 chat_history 的 mtime 排序（只 stat，不读内容），再从最近往下读：
		// summary.json 里有标题/模型/时间/消息数，读它即可，正文只在确认有真实对话时碰一下头部
		const limit = options?.limit ?? 0;
		const files = await listFiles(ROOT(), { match: (name) => name === "summary.json" });
		const candidates = await sortByRecency(files.map((file) => path.join(path.dirname(file), "chat_history.jsonl")));
		const out: ExternalSessionSummary[] = [];
		for (const { file: history, mtime } of candidates) {
			if (reachedLimit(out.length, limit)) break; // 只读最近的若干条
			const dir = path.dirname(history);
			let summary: Record<string, unknown>;
			try {
				summary = JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8")) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (mtime === undefined) continue; // 没有正文就没什么可导
			const info = summary.info as Record<string, unknown> | undefined;
			const numMessages = Number(summary.num_messages ?? summary.num_chat_messages);
			if (numMessages === 0) continue; // 开了没用的空会话
			// 只有系统提示与合成提醒（system_reminder）的会话读不出对话，别列进列表
			if (!(await hasRealMessage(history))) continue;
			out.push({
				source: "grok",
				externalId: path.basename(dir),
				title: cleanTitle(summary.session_summary ?? summary.generated_title),
				projectPath: typeof info?.cwd === "string" ? info.cwd : decodeProjectDir(path.basename(path.dirname(dir))),
				model: typeof summary.current_model_id === "string" ? summary.current_model_id : undefined,
				createdAt: toEpochMs(summary.created_at) ?? mtime,
				updatedAt: toEpochMs(summary.updated_at ?? summary.last_active_at) ?? mtime,
				...(Number.isFinite(numMessages) ? { messageCount: numMessages } : {}),
				location: history,
			});
		}
		return out;
	},

	async read(summary: ExternalSessionSummary): Promise<ImportedSession | null> {
		let text: string;
		try {
			text = await fs.readFile(summary.location, "utf8");
		} catch {
			return null;
		}
		const entries: ImportedEntry[] = [];
		const skipped: string[] = [];
		let encryptedReasoning = 0;
		let synthetic = 0;
		let model = summary.model;

		for (const record of eachJsonLine(text)) {
			const timestamp = toEpochMs(record.timestamp ?? record.time ?? record.created_at) ?? summary.createdAt ?? Date.now();
			switch (record.type) {
				case "system":
					continue; // 系统提示不进对话
				case "user": {
					const blocks = userBlocks(record.content);
					const plain = blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
					if (record.synthetic_reason || !plain) {
						synthetic += 1;
						continue;
					}
					entries.push({ type: "message", message: { role: "user", content: blocks, timestamp } });
					continue;
				}
				case "assistant": {
					if (typeof record.model_id === "string" && record.model_id.trim()) model = record.model_id;
					const blocks: Array<ImportedBlock | null> = [typeof record.content === "string" ? textBlock(record.content) : null];
					for (const call of (record.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
						const id = typeof call.id === "string" ? call.id : "";
						const name = typeof call.name === "string" ? call.name : "";
						if (id && name) blocks.push({ type: "toolCall", id, name, arguments: parseArguments(call.arguments ?? {}) });
					}
					const content = compactBlocks(blocks);
					if (!content.length) continue;
					entries.push({
						type: "message",
						message: { role: "assistant", content, timestamp, ...(model ? { model } : {}), ...(content.some((block) => block.type === "toolCall") ? { stopReason: "toolUse" } : {}) },
					});
					continue;
				}
				case "reasoning": {
					const text = typeof record.summary === "string" ? record.summary : "";
					if (text.trim()) entries.push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: text }], timestamp, ...(model ? { model } : {}) } });
					else encryptedReasoning += 1; // 加密推理无正文可导：计数后汇总成一行，不要刷屏
					continue;
				}
				case "tool_result": {
					const callId = typeof record.tool_call_id === "string" ? record.tool_call_id : "";
					if (!callId) continue;
					entries.push({ type: "message", message: { role: "toolResult", toolCallId: callId, content: outputBlocks(record.content), timestamp } });
					continue;
				}
				default:
					continue;
			}
		}

		if (synthetic) skipped.push(`跳过 ${synthetic} 条合成输入`);
		if (encryptedReasoning) skipped.push(`跳过 ${encryptedReasoning} 条仅含加密内容的推理记录`);
		if (!entries.some((entry) => entry.type === "message")) return null;
		return { summary: { ...summary, model }, entries, skipped };
	},
};
