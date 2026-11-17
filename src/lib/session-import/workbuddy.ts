/**
 * WorkBuddy / WorkBuddy AI：`~/.workbuddy(-ai)/projects/<项目>/<会话>.jsonl`
 *
 * 每行一个记录（结构接近 Claude Code 的会话格式），关键字段：
 *  - `{type:"message", role:"user"|"assistant", content:[{type:"input_text"|"output_text", text}]}`
 *  - `{type:"reasoning", ...}`（有正文时作思考块）
 *  - `{type:"function_call", name, callId, arguments}` / `{type:"function_call_result", callId, output}`
 *  - `{type:"ai-title"|"custom-title", aiTitle/customTitle}` 与每行都带的 `cwd`
 *
 * 子代理的记录在 `<会话>/subagents/` 下，不导入；真正的会话 id 是文件名。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { eachJsonLine, jsonlImportWarnings, listFiles, readFileBounded, readHead, reachedLimit, sortByRecency } from "./files";
import { workbuddyRoots } from "./paths";
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedSession, ImportSourceModule, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, outputBlocks, parseArguments, textBlock, toEpochMs } from "./types";

/** 用户消息里的系统提醒块（OS 信息等）不算对话内容 */
function userBlocks(content: unknown): ImportedBlock[] {
	if (typeof content === "string") return compactBlocks([textBlock(content)]);
	if (!Array.isArray(content)) return [];
	const blocks: Array<ImportedBlock | null> = [];
	for (const raw of content) {
		const block = raw as Record<string, unknown>;
		if (typeof raw === "string") {
			blocks.push(textBlock(raw));
			continue;
		}
		const text = typeof block?.text === "string" ? block.text : "";
		if (!text.trim()) continue;
		if (text.trimStart().startsWith("<system-reminder")) continue;
		blocks.push({ type: "text", text });
	}
	return compactBlocks(blocks);
}

function assistantBlocks(content: unknown): ImportedBlock[] {
	if (typeof content === "string") return compactBlocks([textBlock(content)]);
	if (!Array.isArray(content)) return [];
	return compactBlocks(content.map((raw) => {
		const block = raw as Record<string, unknown>;
		const text = typeof block?.text === "string" ? block.text : "";
		return text.trim() ? { type: "text" as const, text } : null;
	}));
}

/** 扫列表时从文件头拿 cwd / 标题 / 首条用户消息 */
function headInfo(head: string): { cwd?: string; title?: string; firstUser?: string; sessionId?: string } {
	const info: { cwd?: string; title?: string; firstUser?: string; sessionId?: string } = {};
	for (const record of eachJsonLine(head)) {
		if (!info.cwd && typeof record.cwd === "string" && record.cwd) info.cwd = record.cwd;
		if (!info.sessionId && typeof record.sessionId === "string" && record.sessionId) info.sessionId = record.sessionId;
		if (record.type === "custom-title" && typeof record.customTitle === "string" && record.customTitle.trim()) info.title = record.customTitle;
		else if (record.type === "ai-title" && typeof record.aiTitle === "string" && record.aiTitle.trim()) info.title ??= record.aiTitle;
		if (!info.firstUser && record.type === "message" && record.role === "user") {
			const text = userBlocks(record.content).map((block) => (block.type === "text" ? block.text : "")).join(" ").replace(/\s+/g, " ").trim();
			if (text) info.firstUser = text;
		}
	}
	return info;
}

async function metaCwd(file: string): Promise<string | undefined> {
	try {
		const meta = JSON.parse((await readFileBounded(`${file.slice(0, -".jsonl".length)}.meta.json`, 1024 * 1024)).toString("utf8")) as Record<string, unknown>;
		return typeof meta.cwd === "string" && meta.cwd ? meta.cwd : undefined;
	} catch {
		return undefined;
	}
}

export const workbuddySource: ImportSourceModule = {
	id: "workbuddy",

	async scan(options?: ScanOptions): Promise<ExternalSessionSummary[]> {
		const limit = options?.limit ?? 0;
		type Candidate = { file: string; mtime?: number; tag: string };
		const candidates: Candidate[] = [];
		for (const root of workbuddyRoots()) {
			// 两个目录（正式版 / 国际版）里的会话 id 可能重复，外部键带上目录标签
			const tag = /workbuddy-ai$/i.test(root) ? "workbuddy-ai" : "workbuddy";
			const files = await listFiles(path.join(root, "projects"), { match: (name) => name.endsWith(".jsonl"), maxDepth: 6 });
			for (const { file, mtime } of await sortByRecency(files)) {
				if (file.endsWith(".meta.json")) continue;
				if (/[\\/]subagents[\\/]/.test(file)) continue; // 子代理会话
				candidates.push({ file, mtime, tag });
			}
		}
		candidates.sort((left, right) => (right.mtime ?? 0) - (left.mtime ?? 0));
		const out: ExternalSessionSummary[] = [];
		for (const { file, mtime, tag } of candidates) {
			options?.signal?.throwIfAborted();
			if (reachedLimit(out.length, limit)) break;
			let head: string;
			try {
				head = await readHead(file);
			} catch {
				continue;
			}
			const info = headInfo(head);
			const cwd = info.cwd ?? (await metaCwd(file));
			if (!cwd) continue; // 没有工作区就导不回原项目
			const id = info.sessionId || path.basename(file, ".jsonl");
			out.push({
				source: "workbuddy",
				externalId: `${tag}:${id}`,
				title: cleanTitle(info.title) ?? cleanTitle(info.firstUser),
				projectPath: cwd,
				createdAt: mtime,
				updatedAt: mtime,
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
		let model = summary.model;
		let synthetic = 0;
		const fallbackTs = toEpochMs(summary.updatedAt ?? summary.createdAt) ?? Date.now();

		for (const record of eachJsonLine(text)) {
			const timestamp = toEpochMs(record.timestamp) ?? fallbackTs;
			const provider = record.providerData as Record<string, unknown> | undefined;
			if (typeof provider?.model === "string" && provider.model.trim()) model = provider.model;
			switch (record.type) {
				case "message": {
					if (record.role === "user") {
						const blocks = userBlocks(record.content);
						if (!blocks.length) {
							synthetic += 1;
							continue;
						}
						entries.push({ type: "message", message: { role: "user", content: blocks, timestamp } });
					} else if (record.role === "assistant") {
						const blocks = assistantBlocks(record.content);
						if (!blocks.length) continue;
						entries.push({ type: "message", message: { role: "assistant", content: blocks, timestamp, ...(model ? { model } : {}) } });
					}
					continue;
				}
				case "reasoning": {
					const think = [record.summary, record.text, record.content].find((value): value is string => typeof value === "string" && value.trim() !== "");
					if (!think) continue;
					entries.push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: think }], timestamp, ...(model ? { model } : {}) } });
					continue;
				}
				case "function_call": {
					const callId = typeof record.callId === "string" ? record.callId : "";
					const name = typeof record.name === "string" ? record.name : "";
					if (!callId || !name) continue;
					entries.push({
						type: "message",
						message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: parseArguments(record.arguments ?? {}) }], timestamp, ...(model ? { model } : {}), stopReason: "toolUse" },
					});
					continue;
				}
				case "function_call_result": {
					const callId = typeof record.callId === "string" ? record.callId : "";
					if (!callId) continue;
					const name = typeof record.name === "string" ? record.name : undefined;
					entries.push({
						type: "message",
						message: { role: "toolResult", toolCallId: callId, ...(name ? { toolName: name } : {}), content: outputBlocks(record.output), timestamp },
					});
					continue;
				}
				default:
					continue;
			}
		}

		if (synthetic) skipped.push(`跳过 ${synthetic} 条只有系统提醒的输入`);
		if (!entries.some((entry) => entry.type === "message")) return null;
		return { summary: { ...summary, model }, entries, skipped };
	},
};
