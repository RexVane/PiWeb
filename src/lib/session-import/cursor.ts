/**
 * Cursor Agent CLI 的会话：`~/.cursor/chats/<工作区 md5>/<会话 uuid>/store.db`
 *
 * 会话目录里：store.db（SQLite：`blobs(id, data)`、`meta(key, value)`）、meta.json（标题/时间）、
 * prompt_history.json（无标题时兜底）。对话是 blobs 里按 rowid 顺序排列的 JSON：role 为
 * user / assistant / tool，内容块类型 text、reasoning/thinking、tool-call、tool-result；
 * 其余 blob 是 Cursor 内部的 protobuf 回合图，跳过。工作区路径在 meta 表的 `0` 号记录里。
 *
 * Cursor 编辑器的会话在 state.vscdb（protobuf 结构）里，导不进来；这里只读 CLI 的存储。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { jsonlImportWarnings, readFileBounded } from "./files";
import { cursorChatsRoot } from "./paths";
import { openReadOnly } from "./sqlite";
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedSession, ImportSourceModule, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, outputBlocks, parseArguments, textBlock, toEpochMs } from "./types";

/** meta 表里 agent 记录的 value 可能是十六进制编码的 JSON，也可能是明文 JSON */
function parseAgentRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined || value === null) return undefined;
	const raw = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : "";
	const candidates = [raw];
	if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
		try {
			candidates.push(Buffer.from(raw, "hex").toString("utf8"));
		} catch {
			// 不是合法十六进制就只试原文
		}
	}
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			// 接着试下一种编码
		}
	}
	return undefined;
}

/** `<user_query>…</user_query>` 去掉外壳；编辑器注入的 <user_info> 内容整条丢弃 */
function userText(content: unknown): string {
	if (typeof content === "string") return cleanUserText(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const raw of content) {
		const block = raw as Record<string, unknown>;
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return cleanUserText(parts.join("\n"));
}

function cleanUserText(text: string): string {
	if (text.includes("<user_info>")) return "";
	const unwrapped = text.replace(/<\/?user_query>/g, "").replace(/\[REDACTED\]/g, "").trim();
	return unwrapped;
}

interface BlobBlock {
	type?: unknown;
	text?: unknown;
	reasoning?: unknown;
	thinking?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	args?: unknown;
	result?: unknown;
	isError?: unknown;
}

function assistantContent(content: unknown): { blocks: ImportedBlock[]; calls: Array<{ id: string; name: string }> } {
	const blocks: Array<ImportedBlock | null> = [];
	const calls: Array<{ id: string; name: string }> = [];
	if (typeof content === "string") {
		const text = content.replace(/\[REDACTED\]/g, "").trim();
		if (text) blocks.push({ type: "text", text });
		return { blocks: compactBlocks(blocks), calls };
	}
	if (!Array.isArray(content)) return { blocks: [], calls };
	for (const raw of content) {
		const block = raw as BlobBlock;
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
			blocks.push({ type: "text", text: block.text.replace(/\[REDACTED\]/g, "") });
			continue;
		}
		if (block.type === "reasoning" || block.type === "thinking") {
			const text = typeof block.text === "string" ? block.text : typeof block.reasoning === "string" ? block.reasoning : typeof block.thinking === "string" ? block.thinking : "";
			if (text.trim()) blocks.push({ type: "thinking", thinking: text });
			continue;
		}
		if (block.type === "tool-call") {
			const name = typeof block.toolName === "string" ? block.toolName : "";
			const id = typeof block.toolCallId === "string" && block.toolCallId ? block.toolCallId : "";
			if (!name || !id) continue;
			calls.push({ id, name });
			blocks.push({ type: "toolCall", id, name, arguments: parseArguments(block.args ?? {}) });
		}
	}
	return { blocks: compactBlocks(blocks), calls };
}

function toolResults(content: unknown, fallbackTs: number): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	const list = Array.isArray(content) ? content : [content];
	for (const raw of list) {
		const block = raw as BlobBlock & { type?: unknown };
		if (!block || typeof block !== "object") continue;
		if (block.type !== "tool-result") continue;
		const callId = typeof block.toolCallId === "string" ? block.toolCallId : "";
		if (!callId) continue;
		out.push(block as Record<string, unknown>);
	}
	void fallbackTs;
	return out;
}

export const cursorSource: ImportSourceModule = {
	id: "cursor",

	async scan(options?: ScanOptions): Promise<ExternalSessionSummary[]> {
		const limit = options?.limit ?? 0;
		const root = cursorChatsRoot();
		let workspaces: string[] = [];
		try {
			workspaces = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch {
			return [];
		}
		const candidates: Array<{ dir: string; dbPath: string; sessionId: string; mtime: number }> = [];
		for (const workspace of workspaces) {
			options?.signal?.throwIfAborted();
			let sessions: string[] = [];
			try {
				sessions = (await fs.readdir(path.join(root, workspace), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
			} catch {
				continue;
			}
			for (const sessionId of sessions) {
				options?.signal?.throwIfAborted();
				const dir = path.join(root, workspace, sessionId);
				const dbPath = path.join(dir, "store.db");
				try {
					const st = await fs.stat(dbPath);
					if (!st.isFile()) continue;
					candidates.push({ dir, dbPath, sessionId, mtime: st.mtimeMs });
				} catch {
					continue;
				}
			}
		}
		candidates.sort((left, right) => right.mtime - left.mtime);
		const scanSlice = limit > 0 ? candidates.slice(0, Math.max(500, limit * 20)) : candidates;
		const out: ExternalSessionSummary[] = [];
		for (const { dir, dbPath, sessionId, mtime } of scanSlice) {
			options?.signal?.throwIfAborted();
			let meta: Record<string, unknown> = {};
			try {
				meta = JSON.parse((await readFileBounded(path.join(dir, "meta.json"), 256 * 1024)).toString("utf8")) as Record<string, unknown>;
			} catch {
				meta = {};
			}
			if (meta.hasConversation === false) continue;
			const db = await openReadOnly(dbPath);
			if (!db) continue;
			let record: Record<string, unknown> | undefined;
			try {
				if (db.hasTable("meta")) record = parseAgentRecord(db.get("SELECT value FROM meta WHERE key = '0'")?.value);
			} catch {
				record = undefined;
			} finally {
				db.close();
			}
			const projectPath = typeof record?.workspacePath === "string" && record.workspacePath.trim() ? record.workspacePath : "";
			if (!projectPath) continue;
			let title = cleanTitle(meta.title);
			if (!title) {
				try {
					const prompts = JSON.parse((await readFileBounded(path.join(dir, "prompt_history.json"), 256 * 1024)).toString("utf8")) as unknown;
					if (Array.isArray(prompts) && typeof prompts[0] === "string") title = cleanTitle(prompts[0]);
				} catch {
					// 没有 prompt_history 就靠首条消息
				}
			}
			const createdAt = toEpochMs(meta.createdAtMs ?? record?.createdAt);
			out.push({
				source: "cursor",
				externalId: sessionId,
				title,
				projectPath,
				createdAt,
				updatedAt: toEpochMs(meta.updatedAtMs ?? record?.updatedAt) ?? createdAt ?? mtime,
				...(typeof record?.lastUsedModel === "string" && record.lastUsedModel ? { model: record.lastUsedModel } : {}),
				location: dbPath,
			});
		}
		out.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
		return limit > 0 ? out.slice(0, limit) : out;
	},

	async read(summary: ExternalSessionSummary): Promise<ImportedSession | null> {
		const db = await openReadOnly(summary.location);
		if (!db) return null;
		let rows: Record<string, unknown>[] = [];
		try {
			if (!db.hasTable("blobs")) return null;
			rows = db.all("SELECT data FROM blobs ORDER BY rowid");
		} catch {
			return null;
		} finally {
			db.close();
		}
		const entries: ImportedEntry[] = [];
		const skipped: string[] = [];
		let model = summary.model;
		let lastTs = toEpochMs(summary.updatedAt ?? summary.createdAt) ?? Date.now();
		for (const row of rows) {
			const data = row.data;
			const text = typeof data === "string" ? data : data instanceof Uint8Array ? Buffer.from(data).toString("utf8") : Buffer.isBuffer(data) ? data.toString("utf8") : "";
			if (!text) continue;
			let blob: Record<string, unknown>;
			try {
				const parsed = JSON.parse(text) as unknown;
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				blob = parsed as Record<string, unknown>;
			} catch {
				continue; // protobuf 回合图
			}
			const timestamp = toEpochMs(blob.createdAt) ?? lastTs;
			lastTs = timestamp;
			const provider = blob.providerOptions as Record<string, unknown> | undefined;
			const cursor = provider?.cursor as Record<string, unknown> | undefined;
			if (typeof cursor?.modelName === "string" && cursor.modelName.trim()) model = cursor.modelName;
			const role = typeof blob.role === "string" ? blob.role : "";
			if (role === "user") {
				const content = userText(blob.content);
				if (!content) continue;
				entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: content }], timestamp } });
				continue;
			}
			if (role === "assistant") {
				const { blocks } = assistantContent(blob.content);
				if (!blocks.length) continue;
				entries.push({
					type: "message",
					message: { role: "assistant", content: blocks, timestamp, ...(model ? { model } : {}), ...(blocks.some((block) => block.type === "toolCall") ? { stopReason: "toolUse" } : {}) },
				});
				continue;
			}
			if (role === "tool") {
				for (const result of toolResults(blob.content, timestamp)) {
					const callId = String(result.toolCallId ?? "");
					const name = typeof result.toolName === "string" ? result.toolName : undefined;
					entries.push({
						type: "message",
						message: { role: "toolResult", toolCallId: callId, ...(name ? { toolName: name } : {}), content: outputBlocks(result.result), isError: result.isError === true ? true : undefined, timestamp },
					});
				}
			}
		}
		if (!entries.some((entry) => entry.type === "message")) return null;
		return { summary: { ...summary, model }, entries, skipped };
	},
};
