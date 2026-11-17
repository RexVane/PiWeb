/**
 * Kimi Code（~/.kimi/sessions/<工作区>/<会话目录>/，会话目录里有 state.json 与 agents/main/wire.jsonl）
 *
 * state.json 给标题 / 工作区 / 时间；正文在 wire.jsonl：
 *  - `turn.prompt` / `turn.steer`：`input[]`（text）是用户输入，`origin.kind` 不是 user 的是技能激活/系统触发
 *  - `context.append_loop_event`：`event.type` 为 content.part（text/think）、tool.call（name/args/toolCallId）、
 *    tool.result（toolCallId + result.output）
 *  - `context.append_message`（time 为 0 的老格式）：user / assistant / tool，带 content[] 与 toolCalls[]
 *
 * 只读主 agent（agents/main）；子代理自己的 wire.jsonl 不导入。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { eachJsonLine, jsonlImportWarnings, listFiles, readFileBounded, readHead, reachedLimit, sortByRecency } from "./files";
import { kimiHome, kimiSessionsRoot } from "./paths";
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedSession, ImportSourceModule, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, outputBlocks, parseArguments, textBlock, toEpochMs } from "./types";

interface KimiState {
	title?: string;
	titleKind?: string;
	isCustomTitle?: boolean;
	customTitle?: string;
	cwd?: string;
	workDir?: string;
	createdAt?: unknown;
	updatedAt?: unknown;
}

/** session_index.jsonl：老会话 state.json 里没有 workDir 时用它兜底 */
async function kimiIndex(): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	try {
		const text = (await readFileBounded(path.join(kimiHome(), "session_index.jsonl"), 8 * 1024 * 1024)).toString("utf8");
		for (const record of eachJsonLine(text)) {
			const id = typeof record.sessionId === "string" ? record.sessionId : "";
			const dir = typeof record.sessionDir === "string" ? record.sessionDir : "";
			const workDir = typeof record.workDir === "string" ? record.workDir : "";
			if ((id || dir) && workDir) out.set(id || path.basename(dir), workDir);
		}
	} catch {
		// 没有索引文件是正常的（新版本才写）
	}
	return out;
}

/** 会话目录名就是会话 id；state.json 在它下面 */
function sessionDirOf(wire: string): string {
	return path.dirname(path.dirname(path.dirname(wire)));
}

async function readState(dir: string): Promise<KimiState> {
	try {
		return JSON.parse((await readFileBounded(path.join(dir, "state.json"), 1024 * 1024)).toString("utf8")) as KimiState;
	} catch {
		return {};
	}
}

function stateTitle(state: KimiState): string | undefined {
	const custom = typeof state.customTitle === "string" ? state.customTitle : state.isCustomTitle === true ? state.title : undefined;
	return cleanTitle(custom ?? (typeof state.title === "string" ? state.title : undefined));
}

/** 有没有真正的对话（只有元数据/step.end 的空会话不列出来） */
function hasDialogue(head: string): boolean {
	for (const record of eachJsonLine(head)) {
		if (record.type === "turn.prompt" || record.type === "turn.steer") return true;
		if (record.type === "context.append_message") {
			const message = record.message as Record<string, unknown> | undefined;
			if (message && (message.role === "user" || message.role === "assistant")) return true;
		}
	}
	return false;
}

/** result.output 可能是字符串、{text} 或块数组 */
function resultBlocks(output: unknown): ImportedBlock[] {
	if (typeof output === "string") return compactBlocks([textBlock(output)]);
	if (Array.isArray(output)) return outputBlocks(output);
	if (output && typeof output === "object") {
		const record = output as Record<string, unknown>;
		if (typeof record.text === "string") return compactBlocks([textBlock(record.text)]);
		if (record.content !== undefined) return outputBlocks(record.content);
	}
	return outputBlocks(output);
}

export const kimiSource: ImportSourceModule = {
	id: "kimi",

	async scan(options?: ScanOptions): Promise<ExternalSessionSummary[]> {
		const limit = options?.limit ?? 0;
		const files = (await listFiles(kimiSessionsRoot(), { match: (name) => name === "wire.jsonl", maxDepth: 6 }))
			.filter((file) => /[\\/]agents[\\/]main[\\/]wire\.jsonl$/.test(file));
		const candidates = await sortByRecency(files);
		const index = await kimiIndex();
		const out: ExternalSessionSummary[] = [];
		for (const { file: wire, mtime } of candidates) {
			options?.signal?.throwIfAborted();
			if (reachedLimit(out.length, limit)) break;
			const dir = sessionDirOf(wire);
			const id = path.basename(dir);
			const state = await readState(dir);
			const projectPath = [state.cwd, state.workDir, index.get(id)].find((value): value is string => typeof value === "string" && value.trim() !== "");
			if (!projectPath) continue; // 没有工作区就导不回原项目
			let head: string;
			try {
				head = await readHead(wire);
			} catch {
				continue;
			}
			if (!hasDialogue(head)) continue;
			const createdAt = toEpochMs(state.createdAt) ?? mtime;
			out.push({
				source: "kimi",
				externalId: id,
				title: stateTitle(state),
				projectPath,
				createdAt,
				updatedAt: toEpochMs(state.updatedAt) ?? mtime ?? createdAt,
				location: wire,
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
		let model = summary.model;
		let assistant: { blocks: ImportedBlock[]; timestamp: number } | null = null;
		let folded = 0;

		const flush = () => {
			if (!assistant || !assistant.blocks.length) return;
			const blocks = compactBlocks(assistant.blocks);
			if (!blocks.length) {
				assistant = null;
				return;
			}
			entries.push({
				type: "message",
				message: {
					role: "assistant",
					content: blocks,
					timestamp: assistant.timestamp,
					...(model ? { model } : {}),
					...(blocks.some((block) => block.type === "toolCall") ? { stopReason: "toolUse" } : {}),
				},
			});
			assistant = null;
		};
		const fallbackTs = () => toEpochMs(summary.updatedAt ?? summary.createdAt) ?? Date.now();

		for (const record of eachJsonLine(text)) {
			const timestamp = toEpochMs(record.time) ?? fallbackTs();
			if (record.type === "usage.record" && typeof record.model === "string" && record.model.trim()) model = record.model;
			if (record.type === "turn.prompt" || record.type === "turn.steer") {
				const origin = record.origin as Record<string, unknown> | undefined;
				const kind = typeof origin?.kind === "string" ? origin.kind : "";
				const input = Array.isArray(record.input) ? record.input : [];
				const blocks = compactBlocks(input.map((part) => {
					const item = part as Record<string, unknown>;
					return typeof item.text === "string" ? textBlock(item.text) : null;
				}));
				if (!blocks.length) continue;
				if (kind && kind !== "user") {
					// 技能激活 / 后台任务播报 / 子代理任务：不是对话本身，折叠掉
					folded += 1;
					continue;
				}
				flush();
				entries.push({ type: "message", message: { role: "user", content: blocks, timestamp } });
				continue;
			}
			if (record.type === "context.append_loop_event") {
				const event = record.event as Record<string, unknown> | undefined;
				if (!event) continue;
				const eventType = typeof event.type === "string" ? event.type : "";
				if (eventType === "content.part") {
					const part = event.part as Record<string, unknown> | undefined;
					if (!part) continue;
					if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
						assistant ??= { blocks: [], timestamp };
						assistant.blocks.push({ type: "text", text: part.text });
					} else if (part.type === "think" && typeof part.think === "string" && part.think.trim()) {
						assistant ??= { blocks: [], timestamp };
						assistant.blocks.push({ type: "thinking", thinking: part.think });
					}
					continue;
				}
				if (eventType === "tool.call") {
					const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
					const name = typeof event.name === "string" ? event.name : "";
					if (!id || !name) continue;
					toolNames.set(id, name);
					assistant ??= { blocks: [], timestamp };
					assistant.blocks.push({ type: "toolCall", id, name, arguments: parseArguments(event.args ?? {}) });
					continue;
				}
				if (eventType === "tool.result") {
					const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
					const result = event.result as Record<string, unknown> | undefined;
					if (!callId) continue;
					flush();
					const name = toolNames.get(callId);
					entries.push({
						type: "message",
						message: { role: "toolResult", toolCallId: callId, ...(name ? { toolName: name } : {}), content: resultBlocks(result?.output), timestamp },
					});
				}
				continue;
			}
			if (record.type === "context.append_message") {
				// 旧格式（Python kimi-cli / 迁移会话）：Kimi Code 自己写的带 time 的重复记录跳过
				if (record.time !== undefined && record.time !== 0) continue;
				const message = record.message as Record<string, unknown> | undefined;
				if (!message) continue;
				const role = typeof message.role === "string" ? message.role : "";
				const content = Array.isArray(message.content) ? message.content : [];
				const blocks = compactBlocks(content.map((part) => {
					const item = part as Record<string, unknown>;
					if (item.type === "text" && typeof item.text === "string") return textBlock(item.text);
					if (item.type === "think" && typeof item.think === "string" && item.think.trim()) return { type: "thinking" as const, thinking: item.think };
					return null;
				}));
				if (role === "user") {
					if (!blocks.length) continue;
					flush();
					entries.push({ type: "message", message: { role: "user", content: blocks, timestamp } });
					continue;
				}
				if (role === "assistant") {
					const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
					const callBlocks = compactBlocks(calls.map((raw) => {
						const call = raw as Record<string, unknown>;
						const id = typeof call.id === "string" ? call.id : "";
						const fn = call.function as Record<string, unknown> | undefined;
						const name = typeof call.name === "string" ? call.name : typeof fn?.name === "string" ? fn.name : "";
						if (!id || !name) return null;
						toolNames.set(id, name);
						const args = call.arguments ?? fn?.arguments ?? {};
						return { type: "toolCall" as const, id, name, arguments: parseArguments(args) };
					}));
					if (!blocks.length && !callBlocks.length) continue;
					flush();
					entries.push({
						type: "message",
						message: { role: "assistant", content: [...blocks, ...callBlocks], timestamp, ...(model ? { model } : {}), ...(callBlocks.length ? { stopReason: "toolUse" } : {}) },
					});
					continue;
				}
				if (role === "tool") {
					const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
					if (!callId) continue;
					const name = toolNames.get(callId);
					flush();
					entries.push({ type: "message", message: { role: "toolResult", toolCallId: callId, ...(name ? { toolName: name } : {}), content: blocks, timestamp } });
				}
			}
		}
		flush();
		if (folded) skipped.push(`跳过 ${folded} 条非用户触发的注入消息`);
		if (!entries.some((entry) => entry.type === "message")) return null;
		return { summary: { ...summary, title: summary.title ?? fallbackTitle(entries), model }, entries, skipped };
	},
};

/** 没有标题时用第一条用户消息 */
function fallbackTitle(entries: ImportedEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join(" ").replace(/\s+/g, " ").trim();
		if (text) return text.slice(0, 48);
	}
	return undefined;
}
