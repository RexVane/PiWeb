/**
 * Claude Code（~/.claude/projects/<slug>/*.jsonl）
 *
 * 每行自带 type，无统一头行；消息行是 {type:user|assistant, message:{role,model,content[],usage,stop_reason}}。
 * content 块有 text / thinking / tool_use / tool_result / image；工具结果出现在后续 user 行里，
 * 靠 tool_use_id 与前面的 tool_use 配对（这一步交给 writer 兜底修复）。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { eachJsonLine, listFiles, readHead, reachedLimit, sortByRecency } from "./files";
import { claudeRoot } from "./paths";
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedMessage, ImportedSession, ImportSourceModule, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, outputBlocks, textBlock, toEpochMs } from "./types";

const ROOT = claudeRoot;

/** 合成信封（命令输出、系统提醒等）不是真人输入，导入时跳过 */
const SYNTHETIC_PREFIXES = ["<command-name>", "<command-message>", "<local-command-stdout>", "<local-command-caveat>", "<system-reminder>", "<user_info>", "<bash-input>", "<bash-stdout>"];

const isSynthetic = (text: string) => SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix));

/**
 * 子代理的转写不能当作会话：Claude Code 把它们放在
 * `<项目>/<会话 uuid>/subagents/` 下（含更深的 workflows/wf_<id>/ 层，本机 236 个子代理文件 vs 70 个主会话）。
 * 那是主代理派出去的活，不是你在用的那条对话。
 * 这些文件里的记录全是 isSidechain，本来也会被 isMessageLine 挡掉，
 * 这里再按路径显式排除一次：意图更清楚，也不怕以后格式变化。
 */
const isSubagentTranscript = (file: string) => file.split(/[/\\]/).includes("subagents");

function isMessageLine(record: Record<string, unknown>): boolean {
	return (record.type === "user" || record.type === "assistant") && record.isSidechain !== true && Boolean(record.message);
}

function projectPathFrom(records: Record<string, unknown>[]): string | undefined {
	for (const record of records) {
		if (typeof record.cwd === "string" && record.cwd.trim()) return record.cwd;
	}
	return undefined;
}

function modelFrom(records: Record<string, unknown>[]): string | undefined {
	for (const record of records) {
		const message = record.message as { model?: unknown } | undefined;
		if (typeof message?.model === "string" && message.model.trim()) return message.model;
	}
	return undefined;
}

/** 标题：优先会话摘要行，其次首条真人用户消息（Claude Code 不写标题字段） */
function titleFrom(records: Record<string, unknown>[]): string | undefined {
	for (const record of records) {
		if (record.type === "summary" && typeof record.summary === "string" && record.summary.trim()) return record.summary.trim();
	}
	for (const record of records) {
		if (record.type !== "user") continue;
		const plain = userTextOf((record.message as { content?: unknown } | undefined)?.content);
		if (plain && !isSynthetic(plain)) return plain;
	}
	return undefined;
}

function userTextOf(content: unknown): string {
	const items = Array.isArray(content) ? content : [content];
	return items
		.map((item) => (typeof item === "string" ? item : typeof (item as { text?: unknown })?.text === "string" ? ((item as { text: string }).text) : ""))
		.join("\n")
		.replace(/\s+/g, " ")
		.trim();
}

/** assistant 消息的 content 数组 */
function assistantBlocks(content: unknown): ImportedBlock[] {
	if (!Array.isArray(content)) return compactBlocks([textBlock(typeof content === "string" ? content : undefined)]);
	return compactBlocks(content.flatMap((raw): Array<ImportedBlock | null> => {
		const block = raw as Record<string, unknown>;
		if (block?.type === "text") return [textBlock(block.text)];
		if (block?.type === "thinking") return [typeof block.thinking === "string" && block.thinking ? { type: "thinking", thinking: block.thinking } : null];
		if (block?.type === "tool_use") {
			const id = typeof block.id === "string" ? block.id : "";
			const name = typeof block.name === "string" ? block.name : "";
			return id && name ? [{ type: "toolCall" as const, id, name, arguments: block.input ?? {} }] : [];
		}
		if (block?.type === "image") {
			const source = block.source as Record<string, unknown> | undefined;
			if (source?.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
				return [{ type: "image", data: source.data, mimeType: source.media_type }];
			}
		}
		return [];
	}));
}

/**
 * Claude 的 stop_reason → pi 的 stopReason（与 pi-ai 的 anthropic 映射一致）。
 * 拆开的记录每行都带整条回复的 stop_reason（思考那行也写着 tool_use），所以以合并后的内容为准：
 * 有工具调用就是 toolUse。原样写进去的 tool_use / end_turn pi 不认，界面会把中途的说明当成最终回答。
 */
function stopReasonOf(content: ImportedBlock[], raw: unknown): { stopReason: string; errorMessage?: string } {
	if (raw === "refusal" || raw === "sensitive") return { stopReason: "error", errorMessage: `Claude stopped with: ${raw}` };
	if (content.some((block) => block.type === "toolCall")) return { stopReason: "toolUse" };
	return { stopReason: raw === "max_tokens" ? "length" : "stop" };
}

/** user 行可能同时含文本与工具结果：文本进用户消息，工具结果单列 */
function splitUserContent(content: unknown): { text: ImportedBlock[]; results: Array<{ toolCallId: string; content: ImportedBlock[]; isError: boolean }> } {
	const text: Array<ImportedBlock | null> = [];
	const results: Array<{ toolCallId: string; content: ImportedBlock[]; isError: boolean }> = [];
	const items = Array.isArray(content) ? content : [content];
	for (const raw of items) {
		if (typeof raw === "string") {
			text.push(textBlock(raw));
			continue;
		}
		const block = raw as Record<string, unknown>;
		if (block?.type === "text") text.push(textBlock(block.text));
		else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
			results.push({ toolCallId: block.tool_use_id, content: outputBlocks(block.content), isError: block.is_error === true });
		} else if (block?.type === "image") {
			const source = block.source as Record<string, unknown> | undefined;
			if (source?.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
				text.push({ type: "image", data: source.data, mimeType: source.media_type });
			}
		}
	}
	return { text: compactBlocks(text), results };
}

export const claudeSource: ImportSourceModule = {
	id: "claude",

	async scan(options?: ScanOptions): Promise<ExternalSessionSummary[]> {
		const limit = options?.limit ?? 0;
		const candidates = await sortByRecency(await listFiles(ROOT(), { match: (name) => name.endsWith(".jsonl") }));
		const out: ExternalSessionSummary[] = [];
		for (const { file, mtime } of candidates) {
			if (reachedLimit(out.length, limit)) break; // 只读最近的若干条：后面的文件根本不打开
			if (isSubagentTranscript(file)) continue; // 主代理派给子代理的活不算会话
			let head: string;
			try {
				head = await readHead(file);
			} catch {
				continue;
			}
			const records = [...eachJsonLine(head)].filter((record) => record.type !== undefined).slice(0, 200);
			const first = records.find(isMessageLine);
			if (!first) continue; // 只有元信息、没有消息的文件不列
			out.push({
				source: "claude",
				externalId: path.basename(file, ".jsonl"),
				title: cleanTitle(titleFrom(records)),
				projectPath: projectPathFrom(records),
				model: modelFrom(records),
				createdAt: toEpochMs(first.timestamp) ?? mtime,
				updatedAt: mtime,
				// 消息数需要整读，扫描阶段不统计（界面显示 —）
				location: file,
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
		let sidechains = 0;
		let synthetic = 0;
		let projectPath = summary.projectPath;
		let model = summary.model;
		let provider: string | undefined;
		/**
		 * Claude Code 把一次回复按内容块拆成多行（思考、正文、每个工具调用各一行），共用 message.id，
		 * 每行还带着整条回复的 usage。必须合并回一条：拆开后并行调用变成 assistant[A] → assistant[B]，
		 * pi-ai 会给 A 补一条 "No result provided"，后面真正的 A 结果就成了孤儿，接着聊直接 400；usage 也会重复计 N 次。
		 * 流式时工具边跑边出结果，同一 id 的行之间会夹着 tool_result，所以按 id 跨位置合并。
		 */
		const assistantById = new Map<string, Extract<ImportedMessage, { role: "assistant" }>>();
		const rawStopById = new Map<string, unknown>();

		for (const record of eachJsonLine(text)) {
			if (record.isSidechain === true) {
				sidechains += 1;
				continue;
			}
			if (typeof record.cwd === "string" && record.cwd.trim()) projectPath = projectPath ?? record.cwd;
			const message = record.message as Record<string, unknown> | undefined;
			if (!message) continue;
			if (typeof message.model === "string" && message.model.trim()) model = message.model;
			if (typeof message.provider === "string" && message.provider.trim()) provider = message.provider;
			const timestamp = toEpochMs(record.timestamp) ?? toEpochMs(message.timestamp) ?? summary.createdAt ?? Date.now();

			if (record.type === "assistant") {
				const content = assistantBlocks(message.content);
				const id = typeof message.id === "string" && message.id ? message.id : undefined;
				const existing = id ? assistantById.get(id) : undefined;
				if (!content.length && !existing) continue;
				const usage = message.usage as Record<string, unknown> | undefined;
				const target = existing ?? { role: "assistant" as const, content: [], timestamp };
				target.content.push(...content);
				if (typeof message.model === "string") target.model = message.model;
				// 同一回复的每行 usage 相同（后面的行只会更完整）：取最后一行，只记一次
				if (usage) {
					target.usage = {
						input: Number(usage.input_tokens) || 0,
						output: Number(usage.output_tokens) || 0,
						cacheRead: Number(usage.cache_read_input_tokens) || 0,
						cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
					};
				}
				if (id && message.stop_reason != null) rawStopById.set(id, message.stop_reason);
				const { stopReason, errorMessage } = stopReasonOf(target.content, id ? rawStopById.get(id) : message.stop_reason);
				target.stopReason = stopReason;
				if (errorMessage) target.errorMessage = errorMessage;
				else delete target.errorMessage;
				if (!existing) {
					entries.push({ type: "message", message: target });
					if (id) assistantById.set(id, target);
				}
				continue;
			}

			if (record.type === "user") {
				const { text: textBlocks, results } = splitUserContent((message as { content?: unknown }).content);
				const plain = textBlocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
				const keepText = textBlocks.filter((block) => block.type !== "text");
				if (plain && !isSynthetic(plain.trim()) && !/^Caveat:/i.test(plain.trim())) {
					entries.push({ type: "message", message: { role: "user", content: [...keepText, { type: "text", text: plain }], timestamp } as ImportedMessage });
					// 真人发了新消息，之前的回复已经结束：不要再把后面的行合并到它前面去
					assistantById.clear();
				} else if (plain) {
					synthetic += 1;
				}
				for (const result of results) {
					entries.push({
						type: "message",
						message: { role: "toolResult", toolCallId: result.toolCallId, content: result.content, isError: result.isError || undefined, timestamp } as ImportedMessage,
					});
				}
			}
		}

		if (sidechains) skipped.push(`跳过 ${sidechains} 条侧链（子代理）记录`);
		if (synthetic) skipped.push(`跳过 ${synthetic} 条合成输入（命令回显/系统提醒）`);
		if (!entries.some((entry) => entry.type === "message")) return null;
		return { summary: { ...summary, projectPath, model, provider }, entries, skipped };
	},
};
