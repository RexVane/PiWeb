/**
 * dsh（DeepSeek Harness）：`~/.dsh/sessions/<编码 cwd>/session-<uuid>/session.jsonl.zstd`
 *
 * 多帧 zstd 压缩的 JSONL，行形状 `{type, seq, time, data}`。实测要点（照抄真实文件）：
 *  - assistant/message 的 content 里 **已经带 tool-call 块**，与独立的 tool/call 行是同一批调用
 *    （本机 241 : 241 完全对应），所以只取前者，否则工具调用会翻倍。
 *  - tool/result 是 `message.content[0] = {type:"tool-result", toolCallId, content:[...], isError}`，
 *    比别的来源深一层。
 *  - plugin / agent-instructions 来源的 user/message 是运行时注入（沙箱策略、AGENTS.md 快照、
 *    压缩摘要），pi 端会注入自己的那一套，导入时跳过并计数。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { listFiles, reachedLimit, sortByRecency } from "./files";
import { dshRoot } from "./paths";
import { readZstdHead, readZstdJsonl } from "./dsh-zstd";
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedSession, ImportSourceModule, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, outputBlocks, parseArguments, textBlock, toEpochMs } from "./types";

const ROOT = dshRoot;

/**
 * 目录名是编码后的 cwd（`--D-AIApp-PiWeb--`）；非 ASCII 用 `~XXXX` 表示码位
 * （`--D-AIApp-Ordo-~524D~7AEF~9875~9762--` = `D:\AIApp\Ordo-前端页面`）。
 * 还原不出来就返回 undefined，交给 header.cwd。
 */
export function decodeCwdDir(name: string): string | undefined {
	const match = /^--(.+)--$/.exec(name);
	if (!match) return undefined;
	const body = match[1].replace(/~([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
	if (!/^[A-Za-z]-/.test(body)) return undefined; // 只有盘符风格能可靠还原（POSIX 路径无法与 - 区分）
	return `${body[0]}:\\${body.slice(2).split("-").filter(Boolean).join("\\")}`;
}

interface DshHeader {
	id?: string;
	cwd?: string;
	createdAt?: number;
}

function parseRecords(text: string): { header: DshHeader; records: Record<string, unknown>[] } {
	const records: Record<string, unknown>[] = [];
	let header: DshHeader = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed.type === "session") {
			header = { id: typeof parsed.id === "string" ? parsed.id : undefined, cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined, createdAt: toEpochMs(parsed.createdAt) };
			continue;
		}
		records.push(parsed);
	}
	return { header, records };
}

/** request/header 里带 provider+model；取最后一次生效的作为会话的模型 */
function configOf(data: Record<string, unknown> | undefined): { provider?: string; model?: string } {
	const config = (data?.header as Record<string, unknown> | undefined)?.config as Record<string, unknown> | undefined;
	return {
		provider: typeof config?.provider === "string" ? config.provider : undefined,
		model: typeof config?.model === "string" ? config.model : undefined,
	};
}

/** assistant/message 的 content 块：reasoning→thinking、text→text、tool-call→toolCall */
function assistantBlocks(content: unknown): ImportedBlock[] {
	if (!Array.isArray(content)) return [];
	return compactBlocks(content.flatMap((raw): Array<ImportedBlock | null> => {
		const block = raw as Record<string, unknown>;
		if (block?.type === "reasoning" || block?.type === "thinking") {
			return typeof block.text === "string" && block.text.trim() ? [{ type: "thinking", thinking: block.text }] : [];
		}
		if (block?.type === "text") return [textBlock(block.text)];
		if (block?.type === "tool-call") {
			const id = typeof block.id === "string" ? block.id : "";
			const name = typeof block.name === "string" ? block.name : "";
			return id && name ? [{ type: "toolCall", id, name, arguments: parseArguments(block.arguments) }] : [];
		}
		return [];
	}));
}

/** 用户消息块：只认 text */
function userBlocks(content: unknown): ImportedBlock[] {
	if (!Array.isArray(content)) return [];
	return compactBlocks(content.flatMap((raw): Array<ImportedBlock | null> => {
		const block = raw as Record<string, unknown>;
		return block?.type === "text" ? [textBlock(block.text)] : [];
	}));
}

/**
 * 一个会话目录里可能同时存在 `session.jsonl.zstd` 与 `session.v3.jsonl.zstd`（迁移产物，
 * 本机有 6 个这样的目录）。两者是同一个会话、externalId 相同，都列出来就会重复，
 * 导入时还会被判成"重复选择"。选 v3：它是迁移后的规范格式，去掉了流式分片，
 * 实测消息条数反而更多（44/171/241/256 → 46/179/247/262），也确认了 v3 才是最新的完整历史。
 */
function pickPerSession(files: string[]): string[] {
	const best = new Map<string, string>();
	for (const file of files) {
		const dir = path.dirname(file);
		const previous = best.get(dir);
		if (!previous || (file.includes(".v3.") && !previous.includes(".v3."))) best.set(dir, file);
	}
	return [...best.values()];
}

/** tool/result 的输出深一层：{type:"tool-result", toolCallId, content:[{type:"text"}], isError} */
function toolResultOf(message: Record<string, unknown> | undefined): { callId: string; content: ImportedBlock[]; isError: boolean } {
	const blocks = Array.isArray(message?.content) ? (message?.content as Record<string, unknown>[]) : [];
	const node = (blocks.find((block) => block?.type === "tool-result") ?? blocks[0]) as Record<string, unknown> | undefined;
	const source = message?.source as Record<string, unknown> | undefined;
	const callId = typeof node?.toolCallId === "string" ? node.toolCallId : typeof source?.callId === "string" ? source.callId : "";
	return { callId, content: outputBlocks(node?.content ?? node), isError: node?.isError === true };
}

export const dshSource: ImportSourceModule = {
	id: "dsh",

	async scan(options?: ScanOptions): Promise<ExternalSessionSummary[]> {
		const limit = options?.limit ?? 0;
		const files = await listFiles(ROOT(), { match: (name) => name.endsWith(".jsonl.zstd") });
		const candidates = await sortByRecency(pickPerSession(files));
		const out: ExternalSessionSummary[] = [];
		for (const { file, mtime } of candidates) {
			if (reachedLimit(out.length, limit)) break; // 只解压最近的若干条：其余的连 zstd 都不碰
			let head: { text: string; complete: boolean };
			try {
				head = await readZstdHead(file);
			} catch {
				continue;
			}
			const { header, records } = parseRecords(head.text);
			if (!header.id) continue;
			// 建了却从没用过的会话（只有 header 与几条配置）：整个文件都解出来却没有消息，不该列进列表
			if (head.complete && !records.some((record) => record.type === "user/message" || record.type === "assistant/message")) continue;
			let title: string | undefined;
			let provider: string | undefined;
			let model: string | undefined;
			for (const record of records) {
				const data = record.data as Record<string, unknown> | undefined;
				if (record.type === "session/title") {
					title = cleanTitle(data?.title ?? data?.name) ?? title;
				}
				if (record.type === "request/header") {
					const config = configOf(data);
					provider = config.provider ?? provider;
					model = config.model ?? model;
				}
			}
			const sessionDir = path.basename(path.dirname(file));
			out.push({
				source: "dsh",
				externalId: sessionDir || header.id,
				title,
				projectPath: header.cwd ?? decodeCwdDir(path.basename(path.dirname(path.dirname(file)))),
				provider,
				model,
				createdAt: header.createdAt ?? mtime,
				updatedAt: mtime,
				// 扫描只解前若干帧，统计整会话条数不可靠：留空由界面显示 —
				location: file,
			});
		}
		return out;
	},

	async read(summary: ExternalSessionSummary): Promise<ImportedSession | null> {
		let text: string;
		try {
			text = await readZstdJsonl(summary.location);
		} catch {
			return null;
		}
		const { header, records } = parseRecords(text);
		const entries: ImportedEntry[] = [];
		let title = summary.title;
		let injected = 0;
		let provider = summary.provider;
		let model = summary.model;
		let lastAt = header.createdAt ?? summary.createdAt ?? Date.now();

		for (const record of records) {
			const type = typeof record.type === "string" ? record.type : "";
			const at = toEpochMs(record.time) ?? lastAt;
			lastAt = at;
			const data = record.data as Record<string, unknown> | undefined;

			if (type === "user/message") {
				const source = data?.source as Record<string, unknown> | undefined;
				if (source?.kind !== "user") {
					injected += 1; // 插件注入 / AGENTS.md 快照 / 压缩摘要：pi 端会注入自己的版本
					continue;
				}
				const content = userBlocks(data?.content);
				if (!content.length) continue;
				entries.push({ type: "message", message: { role: "user", content, timestamp: at } });
				continue;
			}

			if (type === "assistant/message") {
				const message = data?.message as Record<string, unknown> | undefined;
				const content = assistantBlocks(message?.content);
				if (!content.length) continue;
				const hasCall = content.some((block) => block.type === "toolCall");
				entries.push({ type: "message", message: { role: "assistant", content, timestamp: at, stopReason: hasCall ? "toolUse" : "stop" } });
				continue;
			}

			// tool/call 行与 assistant/message 里的 tool-call 块是同一批调用，重复导入会让调用翻倍
			if (type === "tool/call") continue;

			if (type === "tool/result") {
				const message = data?.message as Record<string, unknown> | undefined;
				const result = toolResultOf(message);
				if (!result.callId || !result.content.length) continue;
				entries.push({ type: "message", message: { role: "toolResult", toolCallId: result.callId, content: result.content, isError: result.isError, timestamp: at } });
				continue;
			}

			if (type === "session/title") {
				title = cleanTitle(data?.title ?? data?.name) ?? title;
				continue;
			}

			if (type === "request/header") {
				const config = configOf(data);
				provider = config.provider ?? provider;
				model = config.model ?? model;
			}
		}

		if (!entries.some((entry) => entry.type === "message")) return null;
		const skipped: string[] = [];
		if (injected) skipped.push(`跳过 ${injected} 条运行时注入消息（沙箱策略 / AGENTS.md 快照 / 压缩摘要）`);
		return {
			summary: { ...summary, title, provider, model, projectPath: header.cwd ?? summary.projectPath },
			entries,
			skipped,
		};
	},
};
