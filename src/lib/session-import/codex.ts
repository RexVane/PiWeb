/**
 * Codex CLI（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）
 *
 * 每行统一 `{timestamp, type, payload}`；payload.type = session_meta / response_item / event_msg …
 * response_item.payload 里才有对话：message / reasoning / function_call / custom_tool_call(+output)。
 * 注意首行可达十几 KB（含 base_instructions），必须读到换行再 parse。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { eachJsonLine, listFiles, readHead, reachedLimit, sortByRecency } from "./files";
import { codexRoot } from "./paths";
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedSession, ImportSourceModule, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, outputBlocks, parseArguments, textBlock, toEpochMs } from "./types";

const ROOT = codexRoot;

/**
 * 合成输入前缀（与参考实现同口径：精确前缀，不用 "#" 通配，避免误杀用户粘贴的 markdown）
 */
const SYNTHETIC_PREFIXES = [
	"<",
	"# AGENTS.md",
	"# Context from my IDE setup",
	"# In app browser:",
	"# Browser comments:",
	"# Files mentioned by the user:",
	"# Diff comments:",
	"# Selected text:",
	"# Review findings:",
	"You are Codex",
];

const isSynthetic = (text: string) => SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix));

interface Meta {
	cwd?: string;
	createdAt?: number;
	model?: string;
	provider?: string;
	/** true = 这条 rollout 是别的线程派出来的（子代理），不是主对话 */
	subagent?: boolean;
}

/**
 * 子代理线程的判定，依据 session_meta.payload（本机 51 个 rollout 里有 22 个是子代理）：
 *  - parent_thread_id：它的存在就说明这条线程由另一条线程派生
 *  - source 是对象（`{"subagent":{…}}`）而主线程是字符串 "cli" / "vscode"
 *  - thread_source：主线程恒为 "user"，子代理是 "subagent" / "guardian_review"
 * 三个条件在本机实测完全一致（22 个子代理全部同时命中，29 个主线程一个都不命中）。
 */
function isSubagentMeta(payload: Record<string, unknown>): boolean {
	if (typeof payload.parent_thread_id === "string" && payload.parent_thread_id) return true;
	if (payload.source && typeof payload.source === "object") return true;
	return typeof payload.thread_source === "string" && payload.thread_source !== "user";
}

function metaFrom(records: Record<string, unknown>[]): Meta {
	const meta: Meta = {};
	for (const record of records) {
		if (record.type !== "session_meta") continue;
		const payload = record.payload as Record<string, unknown> | undefined;
		if (!payload) continue;
		if (typeof payload.cwd === "string") meta.cwd = payload.cwd;
		meta.createdAt = toEpochMs(payload.timestamp) ?? toEpochMs(record.timestamp);
		if (typeof payload.model_provider === "string") meta.provider = payload.model_provider;
		if (typeof payload.model === "string") meta.model = payload.model;
		if (isSubagentMeta(payload)) meta.subagent = true;
	}
	// 模型有时只在 turn_context 里出现
	for (const record of records) {
		if (record.type !== "turn_context") continue;
		const payload = record.payload as Record<string, unknown> | undefined;
		if (typeof payload?.model === "string") meta.model = payload.model;
	}
	return meta;
}

function messageBlocks(payload: Record<string, unknown>): ImportedBlock[] {
	const content = payload.content;
	if (!Array.isArray(content)) return compactBlocks([textBlock(typeof content === "string" ? content : undefined)]);
	return compactBlocks(content.flatMap((raw): Array<ImportedBlock | null> => {
		const block = raw as Record<string, unknown>;
		if (typeof block?.text === "string") return [textBlock(block.text)];
		return [];
	}));
}

function reasoningText(payload: Record<string, unknown>): ImportedBlock | null {
	const summary = payload.summary;
	if (typeof summary === "string") return summary.trim() ? { type: "thinking", thinking: summary } : null;
	if (Array.isArray(summary)) {
		const text = summary.map((item) => (item as { text?: unknown })?.text).filter((value): value is string => typeof value === "string").join("\n");
		return text.trim() ? { type: "thinking", thinking: text } : null;
	}
	return null;
}

/** 标题：Codex 不写标题字段，用首条真人用户消息（rollout 头几十行里就有） */
function titleFrom(records: Record<string, unknown>[]): string | undefined {
	for (const record of records) {
		if (record.type !== "response_item") continue;
		const payload = record.payload as Record<string, unknown> | undefined;
		if (payload?.type !== "message" || payload.role !== "user") continue;
		const blocks = messageBlocks(payload);
		const plain = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n").replace(/\s+/g, " ").trim();
		if (plain && !isSynthetic(plain)) return plain;
	}
	return undefined;
}

export const codexSource: ImportSourceModule = {
	id: "codex",

	async scan(options?: ScanOptions): Promise<ExternalSessionSummary[]> {
		const limit = options?.limit ?? 0;
		const candidates = await sortByRecency(await listFiles(ROOT(), { match: (name) => name.startsWith("rollout-") && name.endsWith(".jsonl") }));
		const out: ExternalSessionSummary[] = [];
		for (const { file, mtime } of candidates) {
			if (reachedLimit(out.length, limit)) break; // 只读最近的若干条
			let head: string;
			try {
				head = await readHead(file);
			} catch {
				continue;
			}
			const records = [...eachJsonLine(head)].slice(0, 300);
			const meta = metaFrom(records);
			if (meta.subagent) continue; // 主代理派给子代理的活，不算会话
			const hasMessage = records.some((record) => record.type === "response_item");
			if (!hasMessage) continue;
			out.push({
				source: "codex",
				externalId: path.basename(file, ".jsonl"),
				title: cleanTitle(titleFrom(records)),
				projectPath: meta.cwd,
				model: meta.model,
				provider: meta.provider,
				createdAt: meta.createdAt ?? mtime,
				updatedAt: mtime,
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
		let synthetic = 0;
		let reasoningSkipped = 0;
		let meta: Meta = { cwd: summary.projectPath, createdAt: summary.createdAt, model: summary.model, provider: summary.provider };

		for (const record of eachJsonLine(text)) {
			if (record.type === "session_meta") {
				meta = { ...meta, ...metaFrom([record]) };
				continue;
			}
			if (record.type !== "response_item") continue;
			const payload = record.payload as Record<string, unknown> | undefined;
			if (!payload) continue;
			const timestamp = toEpochMs(record.timestamp) ?? toEpochMs(payload.timestamp) ?? meta.createdAt ?? Date.now();

			switch (payload.type) {
				case "message": {
					const role = payload.role;
					if (role === "developer") continue; // 系统提示，不进对话
					const blocks = messageBlocks(payload);
					const plain = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
					if (role === "user") {
						if (!plain || isSynthetic(plain)) {
							synthetic += 1;
							continue;
						}
						entries.push({ type: "message", message: { role: "user", content: blocks, timestamp } });
					} else if (role === "assistant") {
						if (!blocks.length) continue;
						entries.push({ type: "message", message: { role: "assistant", content: blocks, timestamp, ...(meta.model ? { model: meta.model } : {}) } });
					}
					continue;
				}
				case "reasoning": {
					// 有摘要就保留成 thinking；只有加密内容时跳过
					const thinking = reasoningText(payload);
					if (!thinking) {
						reasoningSkipped += 1;
						continue;
					}
					entries.push({ type: "message", message: { role: "assistant", content: [thinking], timestamp, ...(meta.model ? { model: meta.model } : {}) } });
					continue;
				}
				case "function_call":
				case "custom_tool_call": {
					const callId = typeof payload.call_id === "string" ? payload.call_id : "";
					const name = typeof payload.name === "string" ? payload.name : "";
					if (!callId || !name) continue;
					const args = parseArguments(payload.arguments ?? payload.input ?? {});
					entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp, stopReason: "toolUse", ...(meta.model ? { model: meta.model } : {}) } });
					continue;
				}
				case "function_call_output":
				case "custom_tool_call_output": {
					const callId = typeof payload.call_id === "string" ? payload.call_id : "";
					if (!callId) continue;
					entries.push({ type: "message", message: { role: "toolResult", toolCallId: callId, content: outputBlocks(payload.output ?? payload.content), timestamp } });
					continue;
				}
				default:
					continue;
			}
		}

		if (synthetic) skipped.push(`跳过 ${synthetic} 条合成输入`);
		if (reasoningSkipped) skipped.push(`跳过 ${reasoningSkipped} 条仅含加密内容的推理记录`);
		if (!entries.some((entry) => entry.type === "message")) return null;
		return { summary: { ...summary, ...meta, projectPath: meta.cwd, model: meta.model, provider: meta.provider }, entries, skipped };
	},
};
