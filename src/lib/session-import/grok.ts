/**
 * Grok CLI（~/.grok/sessions/<URL 编码的 cwd>/<session-uuid>/）
 *
 * 会话目录里有 chat_history.jsonl（正文）与 summary.json（标题/模型/时间/消息数）。
 * chat_history 每行 `{type, content, ...}`：system / user / assistant（含 tool_calls[]）/ reasoning / tool_result。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { eachJsonLine, listFiles, readHead, reachedLimit, statMtime } from "./files";
import { grokRoot } from "./paths";
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedSession, ImportSourceModule, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, dataUrlImageBlock, outputBlocks, parseArguments, textBlock, toEpochMs } from "./types";

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
		if (record.type === "reasoning" && reasoningText(record.summary)) return true;
		if (record.type !== "user" || record.synthetic_reason) continue;
		const blocks = userBlocks(record.content);
		if (blocks.some((block) => block.type === "image" || (block.type === "text" && block.text.replace(/<[^>]+>/g, "").trim()))) return true;
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

/** user 的 content 可能是字符串、文本块或 data URL 图片块 */
function userBlocks(content: unknown): ImportedBlock[] {
	if (typeof content === "string") return compactBlocks([textBlock(content)]);
	if (!Array.isArray(content)) return [];
	return compactBlocks(content.flatMap((raw): Array<ImportedBlock | null> => {
		if (typeof raw === "string") return [textBlock(raw)];
		const block = raw as Record<string, unknown>;
		if (typeof block?.text === "string") return [textBlock(block.text)];
		if (block?.type === "image") return [dataUrlImageBlock(block.url, block.mime ?? block.mimeType)];
		return [];
	}));
}

/** Grok 新版把 reasoning.summary 从字符串改成了 summary_text 块数组；两代格式都要读 */
function reasoningText(summary: unknown): string {
	if (typeof summary === "string") return summary.trim();
	if (!Array.isArray(summary)) return "";
	return summary
		.map((item) => {
			if (typeof item === "string") return item;
			const block = item as { text?: unknown; summary_text?: unknown };
			return typeof block?.text === "string" ? block.text : typeof block?.summary_text === "string" ? block.summary_text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

export const grokSource: ImportSourceModule = {
	id: "grok",

	async scan(options?: ScanOptions): Promise<ExternalSessionSummary[]> {
		const limit = options?.limit ?? 0;
		const files = await listFiles(ROOT(), { match: (name) => name === "summary.json" });
		// summary.updated_at / last_active_at 是 Grok 的权威活动时间。必须先按它排序再 LIMIT，
		// 不能用复制、恢复备份时会变化的 chat_history mtime 决定“最近 15 条”。
		const candidates = (await Promise.all(files.map(async (summaryFile) => {
			const dir = path.dirname(summaryFile);
			const history = path.join(dir, "chat_history.jsonl");
			try {
				const summary = JSON.parse(await fs.readFile(summaryFile, "utf8")) as Record<string, unknown>;
				const mtime = await statMtime(history);
				if (mtime === undefined) return null;
				return {
					dir,
					history,
					summary,
					mtime,
					updatedAt: toEpochMs(summary.updated_at ?? summary.last_active_at) ?? mtime,
				};
			} catch {
				return null;
			}
		}))).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
			.sort((left, right) => right.updatedAt - left.updatedAt);

		const out: ExternalSessionSummary[] = [];
		for (const { dir, history, summary, mtime, updatedAt } of candidates) {
			if (reachedLimit(out.length, limit)) break;
			const info = summary.info as Record<string, unknown> | undefined;
			// num_messages 包含 trace/内部事件；num_chat_messages 才对应 chat_history 的会话记录数
			const numMessages = Number(summary.num_chat_messages ?? summary.num_messages);
			// 子代理会话（grok 的 spawn_subagent：subagent / subagent_fork / subagent_resume，本机 24 条）
			if (typeof summary.session_kind === "string" && summary.session_kind.startsWith("subagent")) continue;
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
				updatedAt,
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
		let runtimeContext = 0;
		let model = summary.model;

		for (const record of eachJsonLine(text)) {
			const timestamp = toEpochMs(record.timestamp ?? record.time ?? record.created_at) ?? summary.createdAt ?? Date.now();
			switch (record.type) {
				case "system":
					runtimeContext += 1;
					continue; // 系统提示由 pi 按目标工作区重新生成，不冒充用户消息
				case "user": {
					const blocks = userBlocks(record.content);
					if (record.synthetic_reason || !blocks.length) {
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
					const text = reasoningText(record.summary);
					if (text) entries.push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: text }], timestamp, ...(model ? { model } : {}) } });
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
		if (runtimeContext) skipped.push(`跳过 ${runtimeContext} 条源工具运行时上下文（pi 会按当前工作区重新生成）`);
		if (!entries.some((entry) => entry.type === "message")) return null;
		return { summary: { ...summary, model }, entries, skipped };
	},
};
