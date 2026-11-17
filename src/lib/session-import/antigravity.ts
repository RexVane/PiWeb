/**
 * Antigravity（桌面 / IDE）与 Antigravity CLI：`~/.gemini/antigravity(-cli)/`
 *
 * - `conversation_summaries.db`（SQLite）给标题、工作区（workspace_uris，file:// URI 列表）、最后修改时间；
 * - `brain/<会话 id>/.system_generated/logs/transcript_full.jsonl` 是逐步骤记录：
 *   USER_EXPLICIT/USER_INPUT = 用户输入；MODEL/PLANNER_RESPONSE = 思考 + 正文 + tool_calls；
 *   MODEL 的其它类型（GENERIC 等）= 工具结果，开头可能带 "Created At:/Completed At:" 两行。
 *
 * 子代理会话（parent_conversation_id / nesting_depth > 0）不导入；没有工作区的“项目外”会话也跳过。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eachJsonLine, jsonlImportWarnings, readFileBounded, reachedLimit, statMtime } from "./files";
import { antigravityCliRoot, antigravityRoot } from "./paths";
import { openReadOnly } from "./sqlite";
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedSession, ImportSource, ImportSourceModule, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, parseArguments, toEpochMs } from "./types";

interface ConversationRow {
	title?: string;
	preview?: string;
	cwd?: string;
	last?: number;
	parent?: string;
	nested?: number;
}

/** "2026-08-22 11:43:20.6658515+00:00"（SQLite 文本）→ epoch ms */
function agyTime(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number") return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text || text.startsWith("0001-01-01")) return undefined;
	const normalized = text.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** workspace_uris 是 JSON 数组，元素形如 file:///d%3A/AIApp/PiWeb */
function agyWorkspace(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	let list: unknown;
	try {
		list = JSON.parse(value);
	} catch {
		return undefined;
	}
	if (!Array.isArray(list)) return undefined;
	for (const item of list) {
		if (typeof item !== "string" || !item.startsWith("file:")) continue;
		try {
			const file = fileURLToPath(item);
			if (file) return file;
		} catch {
			// 坏 URI 跳过
		}
	}
	return undefined;
}

async function conversationSummaries(root: string): Promise<Map<string, ConversationRow>> {
	const out = new Map<string, ConversationRow>();
	const db = await openReadOnly(path.join(root, "conversation_summaries.db"));
	if (!db) return out;
	try {
		if (!db.hasTable("conversation_summaries")) return out;
		const wanted = ["conversation_id", "title", "preview", "last_modified_time", "workspace_uris", "parent_conversation_id", "nesting_depth"];
		const columns = wanted.filter((column) => db.hasColumn("conversation_summaries", column));
		if (!columns.includes("conversation_id")) return out;
		for (const row of db.all(`SELECT ${columns.join(", ")} FROM conversation_summaries`)) {
			const id = typeof row.conversation_id === "string" ? row.conversation_id : "";
			if (!id) continue;
			const nested = Number(row.nesting_depth ?? 0);
			out.set(id, {
				title: typeof row.title === "string" ? row.title : undefined,
				preview: typeof row.preview === "string" ? row.preview : undefined,
				cwd: agyWorkspace(row.workspace_uris),
				last: agyTime(row.last_modified_time),
				parent: typeof row.parent_conversation_id === "string" && row.parent_conversation_id ? row.parent_conversation_id : undefined,
				nested: Number.isFinite(nested) ? nested : 0,
			});
		}
	} finally {
		db.close();
	}
	return out;
}

/** 用户输入里去掉 <ADDITIONAL_METADATA> 之类的系统块，只留真正的请求 */
function agyRequest(content: string): string {
	const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
	let text = match ? match[1] : content;
	text = text
		.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
		.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
		.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, "");
	return text.trim();
}

/** 工具结果开头可能有 "Created At:" / "Completed At:" 各一行 */
function agyResult(content: string): string {
	let text = content;
	for (const head of ["Created At:", "Completed At:"]) {
		if (!text.startsWith(head)) continue;
		const newline = text.indexOf("\n");
		text = newline >= 0 ? text.slice(newline + 1) : "";
	}
	return text.trim();
}

export function createAntigravitySource(id: ImportSource, root: () => string): ImportSourceModule {
	return {
		id,

		async scan(options?: ScanOptions): Promise<ExternalSessionSummary[]> {
			const rootDir = root();
			const summaries = await conversationSummaries(rootDir);
			const brain = path.join(rootDir, "brain");
			let conversations: string[] = [];
			try {
				conversations = (await fs.readdir(brain, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
			} catch {
				return [];
			}
			const limit = options?.limit ?? 0;
			const out: ExternalSessionSummary[] = [];
			for (const conversationId of conversations) {
				options?.signal?.throwIfAborted();
				if (reachedLimit(out.length, limit * 2)) break; // 先多收一些，排序后再截断
				const row = summaries.get(conversationId);
				if (!row || row.parent || (row.nested ?? 0) > 0) continue; // 子代理会话
				const transcript = path.join(brain, conversationId, ".system_generated", "logs", "transcript_full.jsonl");
				const mtime = await statMtime(transcript);
				if (mtime === undefined) continue;
				if (!row.cwd) continue; // 项目外会话没有可返回的工作区
				const createdAt = row.last;
				out.push({
					source: id,
					externalId: conversationId,
					title: cleanTitle(row.title || row.preview || undefined),
					projectPath: row.cwd,
					createdAt,
					updatedAt: row.last ?? mtime,
					location: transcript,
				});
			}
			out.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
			return limit > 0 ? out.slice(0, limit) : out;
		},

		async read(summary: ExternalSessionSummary): Promise<ImportedSession | null> {
			let text: string;
			try {
				text = (await readFileBounded(summary.location)).toString("utf8");
			} catch {
				return null;
			}
			// 同一步骤可能被写多次（重试）：后写的覆盖，位置按第一次出现
			const steps = new Map<number, Record<string, unknown>>();
			const order: number[] = [];
			for (const record of eachJsonLine(text)) {
				const step = typeof record.step_index === "number" ? record.step_index : undefined;
				if (step === undefined) continue;
				if (!steps.has(step)) order.push(step);
				steps.set(step, record);
			}
			const entries: ImportedEntry[] = [];
			const skipped: string[] = jsonlImportWarnings(text);
			let pendingTools: string[] = [];
			let orphanResults = 0;
			const fallbackTs = toEpochMs(summary.updatedAt ?? summary.createdAt) ?? Date.now();

			for (const step of order) {
				const record = steps.get(step)!;
				const timestamp = toEpochMs(record.created_at) ?? fallbackTs;
				if (record.source === "USER_EXPLICIT" && record.type === "USER_INPUT") {
					const request = agyRequest(String(record.content ?? ""));
					if (!request) continue;
					pendingTools = [];
					entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: request }], timestamp } });
					continue;
				}
				if (record.source === "MODEL" && record.type === "PLANNER_RESPONSE") {
					const content: Array<ImportedBlock | null> = [
						typeof record.thinking === "string" && record.thinking.trim() ? { type: "thinking", thinking: record.thinking } : null,
						typeof record.content === "string" && record.content.trim() ? { type: "text", text: record.content } : null,
					];
					const ids: string[] = [];
					for (const raw of Array.isArray(record.tool_calls) ? record.tool_calls : []) {
						const call = raw as Record<string, unknown>;
						const name = typeof call.name === "string" ? call.name : "";
						if (!name) continue;
						const callId = `agy-${step}-${ids.length}`;
						ids.push(callId);
						content.push({ type: "toolCall", id: callId, name, arguments: parseArguments(call.args ?? {}) });
					}
					const blocks = compactBlocks(content);
					if (blocks.length) {
						entries.push({
							type: "message",
							message: { role: "assistant", content: blocks, timestamp, ...(ids.length ? { stopReason: "toolUse" } : {}) },
						});
					}
					pendingTools = ids;
					continue;
				}
				if (record.source === "MODEL" && typeof record.content === "string" && record.content.trim()) {
					const result = agyResult(record.content);
					if (!result) continue;
					const callId = pendingTools.shift();
					if (!callId) {
						orphanResults += 1;
						continue;
					}
					entries.push({ type: "message", message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text: result }], timestamp } });
				}
			}
			if (orphanResults) skipped.push(`跳过 ${orphanResults} 条对不上工具调用的结果`);
			if (!entries.some((entry) => entry.type === "message")) return null;
			return { summary, entries, skipped };
		},
	};
}

export const antigravitySource = createAntigravitySource("antigravity", antigravityRoot);
export const antigravityCliSource = createAntigravitySource("antigravity-cli", antigravityCliRoot);
