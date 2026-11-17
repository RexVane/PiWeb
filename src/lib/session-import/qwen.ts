/**
 * Qwen Code（Gemini CLI 的 fork）的会话：
 *  - 新布局：`~/.qwen/projects/<编码工作区>/chats/<会话 id>.jsonl`（逐行 JSON）
 *  - 老布局：`~/.qwen/tmp/<项目>/chats/session-*.json`（整包 JSON：{sessionId, startTime, messages[]}）
 *
 * JSONL 每行：`{type, sessionId, timestamp, message:{role:"user"|"model", parts:[...]}}`；
 * parts 里 `{text}` 是正文、`{text, thought:true}` 是思考、`{functionCall:{name,args}}` /
 * `{functionResponse:{name,response}}` 是工具调用与结果。系统/控制记录不进入对话。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { eachJsonLine, jsonlImportWarnings, listFiles, readFileBounded, reachedLimit, sortByRecency } from "./files";
import { qwenLegacyTmpRoot, qwenProjectsRoot } from "./paths";
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedMessage, ImportedSession, ImportSourceModule, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, outputBlocks, parseArguments, textBlock, toEpochMs } from "./types";

/** 编码的项目目录（和 Claude Code 一样用 - 替代分隔符）→ 路径；只用于记录里没有 cwd 的兜底 */
function decodeEncodedProject(name: string): string | undefined {
	const trimmed = name.replace(/^--+|-+$/g, "");
	const match = /^([A-Za-z])--(.*)$/.exec(trimmed);
	if (!match) return undefined;
	const rest = match[2].split("--").join("/");
	if (!rest) return undefined;
	const guess = `${match[1].toUpperCase()}:/${rest}`;
	return guess;
}

async function projectExists(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/** 从会话记录里找 cwd（JSONL 的 message 行/元数据行可能带） */
function cwdOf(records: Record<string, unknown>[]): string | undefined {
	for (const record of records) {
		const direct = record.cwd;
		if (typeof direct === "string" && direct.trim()) return direct;
		const message = record.message as Record<string, unknown> | undefined;
		const nested = message?.cwd;
		if (typeof nested === "string" && nested.trim()) return nested;
	}
	return undefined;
}

interface QwenPart {
	text?: unknown;
	thought?: unknown;
	functionCall?: { name?: unknown; args?: unknown; id?: unknown };
	functionResponse?: { name?: unknown; response?: unknown; id?: unknown; isError?: unknown };
}

/** 一行 Qwen JSONL 能贡献的消息；返回 null 表示这一行不是对话 */
function lineMessages(record: Record<string, unknown>, indexes: { line: number }): ImportedMessage[] {
	const message = record.message as Record<string, unknown> | undefined;
	if (!message || !Array.isArray(message.parts)) return [];
	const role = typeof message.role === "string" ? message.role : typeof record.type === "string" ? record.type : "";
	const assistant = role === "model" || role === "assistant";
	if (!assistant && role !== "user") return [];
	const timestamp = toEpochMs(record.timestamp ?? record.time ?? message.timestamp);
	if (timestamp === undefined) return [];
	const parts = message.parts as QwenPart[];
	const blocks: Array<ImportedBlock | null> = [];
	const callIds: string[] = [];
	parts.forEach((part, index) => {
		if (!part || typeof part !== "object") return;
		if (typeof part.text === "string") {
			if (!part.text.trim()) return;
			blocks.push(part.thought === true ? { type: "thinking", thinking: part.text } : { type: "text", text: part.text });
			return;
		}
		if (part.functionCall) {
			const name = typeof part.functionCall.name === "string" ? part.functionCall.name : "";
			if (!name) return;
			const id = typeof part.functionCall.id === "string" && part.functionCall.id ? part.functionCall.id : `qwen-${indexes.line}-${index}`;
			callIds.push(id);
			blocks.push({ type: "toolCall", id, name, arguments: parseArguments(part.functionCall.args ?? {}) });
		}
	});
	const content = compactBlocks(blocks);
	if (!content.length) return [];
	return [{
		role: assistant ? "assistant" : "user",
		content,
		timestamp,
		...(assistant && callIds.length ? { stopReason: "toolUse" } : {}),
	} as ImportedMessage];
}

export const qwenSource: ImportSourceModule = {
	id: "qwen",

	async scan(options?: ScanOptions): Promise<ExternalSessionSummary[]> {
		const limit = options?.limit ?? 0;
		const candidates: Array<{ file: string; kind: "jsonl" | "json"; encoded?: string }> = [];
		// 新布局
		for (const file of await listFiles(qwenProjectsRoot(), { match: (name) => name.endsWith(".jsonl"), maxDepth: 5 })) {
			if (!/[\\/]chats[\\/]/.test(file)) continue;
			candidates.push({ file, kind: "jsonl", encoded: path.basename(path.dirname(path.dirname(file))) });
		}
		// 老布局
		for (const file of await listFiles(qwenLegacyTmpRoot(), { match: (name) => name.startsWith("session-") && name.endsWith(".json"), maxDepth: 5 })) {
			if (!/[\\/]chats[\\/]/.test(file)) continue;
			candidates.push({ file, kind: "json", encoded: path.basename(path.dirname(path.dirname(file))) });
		}
		const ordered = await sortByRecency(candidates.map((candidate) => candidate.file));
		const byFile = new Map(candidates.map((candidate) => [candidate.file, candidate]));
		const out: ExternalSessionSummary[] = [];
		for (const { file, mtime } of ordered) {
			options?.signal?.throwIfAborted();
			if (reachedLimit(out.length, limit)) break;
			const candidate = byFile.get(file);
			if (!candidate) continue;
			let head: string;
			try {
				head = (await readFileBounded(file, 512 * 1024)).toString("utf8");
			} catch {
				continue;
			}
			let records: Record<string, unknown>[];
			if (candidate.kind === "jsonl") records = [...eachJsonLine(head)];
			else {
				try {
					const parsed = JSON.parse(head) as unknown;
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
					const envelope = parsed as Record<string, unknown>;
					const messages = Array.isArray(envelope.messages) ? (envelope.messages as Record<string, unknown>[]) : [];
					records = [{ ...envelope, message: undefined }, ...messages];
				} catch {
					continue;
				}
			}
			if (!records.length) continue;
			let projectPath = cwdOf(records);
			if (!projectPath && candidate.encoded) {
				const guess = decodeEncodedProject(candidate.encoded);
				if (guess && (await projectExists(guess))) projectPath = guess;
			}
			if (!projectPath) continue; // 不知道工作区就导不回去
			const firstUser = records
				.map((record) => lineMessages(record, { line: 0 }))
				.flat()
				.find((message) => message.role === "user");
			const fallback = firstUser && firstUser.role === "user"
				? firstUser.content.map((block) => (block.type === "text" ? block.text : "")).join(" ").replace(/\s+/g, " ").trim()
				: "";
			const envelope = candidate.kind === "json" ? records[0] : records[0];
			out.push({
				source: "qwen",
				externalId: candidate.kind === "json" ? path.basename(file, ".json") : path.basename(file, ".jsonl"),
				title: cleanTitle(typeof envelope.name === "string" ? envelope.name : undefined) ?? cleanTitle(fallback || undefined),
				projectPath,
				createdAt: toEpochMs(envelope.startTime ?? envelope.createdAt) ?? mtime,
				updatedAt: toEpochMs(envelope.lastUpdated ?? envelope.updatedAt) ?? mtime,
				location: file,
			});
		}
		return out;
	},

	async read(summary: ExternalSessionSummary): Promise<ImportedSession | null> {
		let text: string;
		try {
			text = (await readFileBounded(summary.location)).toString("utf8");
		} catch {
			return null;
		}
		const entries: ImportedEntry[] = [];
		const skipped: string[] = jsonlImportWarnings(text);
		const toolNames = new Map<string, string>();
		const pending: string[] = [];
		let synthetic = 0;
		let legacy = false;
		const records: Record<string, unknown>[] = [];
		if (summary.location.endsWith(".jsonl")) {
			for (const record of eachJsonLine(text)) records.push(record);
		} else {
			legacy = true;
			try {
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const messages = Array.isArray(parsed.messages) ? (parsed.messages as Record<string, unknown>[]) : [];
				if (typeof parsed.cwd === "string") messages.push({ cwd: parsed.cwd });
				records.push(...messages);
			} catch {
				return null;
			}
		}
		const fallbackTs = toEpochMs(summary.updatedAt ?? summary.createdAt) ?? Date.now();
		let line = 0;
		for (const record of records) {
			line += 1;
			if (legacy) {
				const legacyMessage = record as Record<string, unknown>;
				const role = typeof legacyMessage.type === "string" ? legacyMessage.type : "";
				const timestamp = toEpochMs(legacyMessage.timestamp) ?? fallbackTs;
				const contents = Array.isArray(legacyMessage.content) ? legacyMessage.content : [];
				const blocks = compactBlocks(contents.map((raw) => {
					const block = raw as Record<string, unknown>;
					return typeof block?.text === "string" ? textBlock(block.text) : null;
				}));
				const calls = Array.isArray(legacyMessage.toolCalls) ? legacyMessage.toolCalls : [];
				const callBlocks: Array<ImportedBlock | null> = calls.map((raw, index) => {
					const call = raw as Record<string, unknown>;
					const name = typeof call.name === "string" ? call.name : "";
					if (!name) return null;
					const id = typeof call.id === "string" && call.id ? call.id : `qwen-legacy-${line}-${index}`;
					toolNames.set(id, name);
					pending.push(id);
					return { type: "toolCall" as const, id, name, arguments: parseArguments(call.args ?? call.arguments ?? {}) };
				});
				if (role === "user") {
					if (!blocks.length) continue;
					entries.push({ type: "message", message: { role: "user", content: blocks, timestamp } });
				} else if (role === "gemini" || role === "assistant" || role === "model") {
					const content = compactBlocks([...blocks, ...callBlocks]);
					if (!content.length) continue;
					entries.push({ type: "message", message: { role: "assistant", content, timestamp, ...(callBlocks.length ? { stopReason: "toolUse" } : {}) } });
				}
				continue;
			}
			// 新布局：逐行消息
			const messages = lineMessages(record, { line });
			for (const item of messages) {
				if (item.role !== "assistant") {
					entries.push({ type: "message", message: item });
					continue;
				}
				const calls = item.content.filter((block) => block.type === "toolCall");
				for (const call of calls) {
					if (call.type !== "toolCall") continue;
					toolNames.set(call.id, call.name);
					pending.push(call.id);
				}
				entries.push({ type: "message", message: item });
			}
			// functionResponse 在随后的 user 行 parts 里：接成工具结果（这一行本身没有正文，不会产出消息）
			const rawMessage = record.message as Record<string, unknown> | undefined;
			const parts = Array.isArray(rawMessage?.parts) ? (rawMessage!.parts as QwenPart[]) : [];
			for (const part of parts) {
				const response = part?.functionResponse;
				if (!response) continue;
				const name = typeof response.name === "string" ? response.name : "";
				const callId = pending.shift();
				if (!callId) {
					synthetic += 1;
					continue;
				}
				const payload = response.response ?? response;
				// Gemini 的工具响应通常是 { output: "…" }（run_shell_command 等），直接取正文
				const output = payload && typeof payload === "object" && !Array.isArray(payload) && "output" in (payload as Record<string, unknown>)
					? (payload as Record<string, unknown>).output
					: payload;
				const content = outputBlocks(output);
				entries.push({
					type: "message",
					message: { role: "toolResult", toolCallId: callId, ...(name ? { toolName: name } : {}), content, timestamp: toEpochMs(record.timestamp) ?? fallbackTs },
				});
			}
		}
		if (synthetic) skipped.push(`跳过 ${synthetic} 条对不上工具调用的结果`);
		if (!entries.some((entry) => entry.type === "message")) return null;
		return { summary, entries, skipped };
	},
};
