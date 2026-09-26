/**
 * 把导入的条目写成**合法**的 pi 会话文件。
 *
 * 这个文件的每条规则都对应 SDK 的一处硬要求，写错就会出现"列表里有、打开报错"或
 * "模型请求 400"这类问题：
 *  1. 首行 header 且 version=3（小于 3 会被 SDK 迁移，条目 id 全被重写）
 *  2. 条目 parentId 串成单链，首条为 null
 *  3. 每个 toolResult.toolCallId 必须能对上前面某条 assistant 的 toolCall.id，
 *     源里缺调用记录时补一条占位 toolCall（否则压缩/请求阶段会挂）
 *  4. content 永远是数组；message.timestamp 是毫秒数
 *  5. 文件落在 <agentDir>/sessions/<编码 cwd>/ 下，header.cwd 必须是真实存在的目录
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ImportedBlock, ImportedEntry, ImportedMessage, ImportedSession, ImportSource } from "./types";
import { fallbackTitle } from "./types";

/** 来源前缀：标题里标出来源，侧栏一眼能看出是导入的 */
const SOURCE_LABEL: Record<ImportSource, string> = {
	claude: "Claude",
	codex: "Codex",
	grok: "Grok",
	zcode: "ZCode",
	dsh: "dsh",
	opencode: "opencode",
};

const PROVENANCE_TYPE = "piweb-import";

const entryId = () => randomUUID().replace(/-/g, "").slice(0, 8);

/** 会话目录编码：与 SDK 的 SessionManager 完全一致（--D--AIApp-PiWeb--） */
export function encodeSessionDir(cwd: string): string {
	return `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function safeId(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned.slice(0, 80) || "session";
}

/** 文件名里带来源与外部 id → "是否导入过"只需看文件名，O(1) 且不依赖任何数据库 */
export function importedFileName(source: ImportSource, externalId: string, createdAt?: number): string {
	const stamp = new Date(createdAt ?? Date.now()).toISOString().replace(/[:.]/g, "-");
	return `${stamp}_import-${source}-${safeId(externalId)}.jsonl`;
}

/** 幂等检查：本机是否已经导入过这条外部会话 */
export async function findImported(agentDir: string, source: ImportSource, externalId: string): Promise<string | null> {
	const suffix = `_import-${source}-${safeId(externalId)}.jsonl`;
	const root = path.join(agentDir, "sessions");
	let dirs: string[] = [];
	try {
		dirs = await fs.readdir(root);
	} catch {
		return null;
	}
	for (const dir of dirs) {
		// 文件名带时间戳前缀，只能列目录后按后缀匹配
		let files: string[] = [];
		try {
			files = await fs.readdir(path.join(root, dir));
		} catch {
			continue;
		}
		const hit = files.find((name) => name.endsWith(suffix));
		if (hit) return path.join(root, dir, hit);
	}
	return null;
}

/**
 * 一次列目录得到所有已导入的 `source:externalId`：扫描几百条会话时逐条 findImported 要把
 * sessions 目录翻几百遍（每次 O(目录数)），这里聚合一次给界面标记"已导入"。
 */
export async function listImportedKeys(agentDir: string): Promise<Set<string>> {
	const keys = new Set<string>();
	const root = path.join(agentDir, "sessions");
	let dirs: string[] = [];
	try {
		dirs = await fs.readdir(root);
	} catch {
		return keys;
	}
	for (const dir of dirs) {
		let files: string[] = [];
		try {
			files = await fs.readdir(path.join(root, dir));
		} catch {
			continue;
		}
		for (const name of files) {
			const match = /_import-([A-Za-z0-9]+)-(.+)\.jsonl$/.exec(name);
			if (match) keys.add(`${match[1]}:${match[2]}`);
		}
	}
	return keys;
}

/** 与 findImported / importedFileName 共用同一个键（避免两边规则不一致导致重复导入） */
export function importedKey(source: ImportSource, externalId: string): string {
	return `${source}:${safeId(externalId)}`;
}

/** 内容块清洗：toolCall 必须有 id/name；toolResult 文本转块 */
function cleanBlocks(blocks: ImportedBlock[]): ImportedBlock[] {
	const out: ImportedBlock[] = [];
	for (const block of blocks) {
		if (!block) continue;
		if (block.type === "text") {
			if (block.text) out.push(block);
		} else if (block.type === "thinking") {
			if (block.thinking) out.push(block);
		} else if (block.type === "toolCall") {
			if (block.id && block.name) out.push({ ...block, arguments: block.arguments ?? {} });
		} else if (block.type === "image") {
			if (block.data && block.mimeType) out.push(block);
		}
	}
	return out;
}

/**
 * 保证 toolResult 有对应的 toolCall：源里常见"只留了结果、调用被截断"的情况，
 * 缺了就补一条占位 assistant 消息，否则 pi 侧组装请求时会因为孤立 toolResult 报错。
 */
function repairToolPairing(messages: ImportedMessage[]): { messages: ImportedMessage[]; repaired: number } {
	const known = new Set<string>();
	const out: ImportedMessage[] = [];
	let repaired = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") known.add(block.id);
			out.push(message);
			continue;
		}
		if (message.role !== "toolResult" || known.has(message.toolCallId)) {
			out.push(message);
			continue;
		}
		known.add(message.toolCallId);
		repaired += 1;
		out.push({
			role: "assistant",
			content: [{ type: "toolCall", id: message.toolCallId, name: message.toolName || "tool", arguments: {} }],
			timestamp: Math.max(0, message.timestamp - 1),
			stopReason: "toolUse",
		});
		out.push(message);
	}
	return { messages: out, repaired };
}

export interface WriteImportedOptions {
	/** 目标工作区目录（必须真实存在——调用方负责校验与兜底） */
	cwd: string;
	agentDir: string;
	now?: number;
}

export interface WriteImportedResult {
	path: string;
	messageCount: number;
	skipped: string[];
}

/** 写一个导入会话；调用方需先确认该外部会话没有导入过 */
export async function writeImportedSession(session: ImportedSession, options: WriteImportedOptions): Promise<WriteImportedResult> {
	const { summary, entries } = session;
	const now = options.now ?? Date.now();
	const createdAt = summary.createdAt ?? now;

	const messages = repairToolPairing(entries.filter((entry): entry is { type: "message"; message: ImportedMessage } => entry.type === "message").map((entry) => entry.message));
	const skipped = [...(session.skipped ?? [])];
	if (messages.repaired > 0) skipped.push(`补齐 ${messages.repaired} 条缺失的工具调用记录`);

	const lines: string[] = [];
	lines.push(JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date(createdAt).toISOString(), cwd: path.resolve(options.cwd) }));

	let parentId: string | null = null;
	const push = (body: Record<string, unknown>, at: number) => {
		const id = entryId();
		lines.push(JSON.stringify({ ...body, id, parentId, timestamp: new Date(at).toISOString() }));
		parentId = id;
	};

	if (summary.provider && summary.model) push({ type: "model_change", provider: summary.provider, modelId: summary.model }, createdAt);

	let lastAt = createdAt;
	for (const message of messages.messages) {
		const at = Number.isFinite(message.timestamp) ? message.timestamp : lastAt;
		lastAt = at;
		const content = cleanBlocks(message.content);
		if (!content.length && message.role !== "toolResult") continue;
		if (message.role === "assistant") {
			push({
				type: "message",
				message: {
					role: "assistant",
					content,
					timestamp: at,
					stopReason: message.stopReason ?? "stop",
					...(message.api ? { api: message.api } : {}),
					...(message.provider ? { provider: message.provider } : summary.provider ? { provider: summary.provider } : {}),
					...(message.model ? { model: message.model } : summary.model ? { model: summary.model } : {}),
					...(message.usage ? { usage: normalizeUsage(message.usage) } : {}),
					...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
				},
			}, at);
			continue;
		}
		if (message.role === "toolResult") {
			push({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: message.toolCallId,
					...(message.toolName ? { toolName: message.toolName } : {}),
					content,
					isError: Boolean(message.isError),
					timestamp: at,
				},
			}, at);
			continue;
		}
		push({ type: "message", message: { role: "user", content, timestamp: at } }, at);
	}

	const title = fallbackTitle(entries, summary.title);
	if (title) push({ type: "session_info", name: `【${SOURCE_LABEL[summary.source]}】${title}` }, lastAt);
	// 来源凭据：两边都会忽略未知 custom 条目，不影响上下文
	push({ type: "custom", customType: PROVENANCE_TYPE, data: { source: summary.source, externalId: summary.externalId, sourcePath: summary.location, projectPath: summary.projectPath ?? null, importedAt: new Date(now).toISOString() } }, lastAt);

	const dir = path.join(options.agentDir, "sessions", encodeSessionDir(options.cwd));
	await fs.mkdir(dir, { recursive: true });
	const target = path.join(dir, importedFileName(summary.source, summary.externalId, createdAt));
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
		// Publish a complete file atomically without replacing an existing imported session.
		await fs.link(temporary, target);
	} finally {
		await fs.rm(temporary, { force: true });
	}
	return { path: target, messageCount: messages.messages.length, skipped };
}

/** pi 的 usage 形状：缺的字段补 0，cost 恒为 0（导入的历史没有真实计费） */
function normalizeUsage(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens?: number }) {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(usage.reasoning ? { reasoning: usage.reasoning } : {}),
		totalTokens: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
