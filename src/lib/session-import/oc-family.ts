/**
 * ZCode 与 opencode 的会话库是同一套血缘（session / message / part 三表，data 列存 JSON），
 * 差别只在排序字段与少量列名，所以共用这一份适配器，各自只传自己的库路径与来源 id。
 *
 * 只读、只取顶层会话（parent_id 为空）：库里的 parent_id 指子代理/侧链会话，本机 ZCode 421 条里有
 * 330 条是这种，导进来只会淹没侧栏；对应用户"只取主链"的要求。
 */
import type { ExternalSessionSummary, ImportedBlock, ImportedEntry, ImportedMessage, ImportedSession, ImportSource, ImportSourceModule, ImportedUsage, ScanOptions } from "./types";
import { cleanTitle, compactBlocks, outputBlocks, textBlock, toEpochMs } from "./types";
import { openReadOnly, parseJsonColumn, type ReadOnlyDb } from "./sqlite";
import { zcodeDb, opencodeDb } from "./paths";

interface FamilyOptions {
	id: ImportSource;
	/** 库文件绝对路径 */
	dbPath(): string;
}

/** `data:` URL 形式的附件能还原成真正的图片块（opencode 用这种） */
function imageFromUrl(url: unknown, mime: unknown): ImportedBlock | null {
	if (typeof url !== "string" || !url.startsWith("data:")) return null;
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
	if (!match) return null;
	return { type: "image", data: match[2], mimeType: typeof mime === "string" && mime ? mime : match[1] };
}

function orderClause(db: ReadOnlyDb, table: string, fallback: string): string {
	return db.hasColumn(table, "sequence") ? `sequence, time_created, id` : fallback;
}

/** 消息里的 provider/model 列名两代不同：zcode 用 modelId/providerId，opencode 用 modelID/providerID */
function modelOf(data: Record<string, unknown>): { provider?: string; model?: string } {
	const pick = (camel: string) => {
		const value = data[camel];
		return typeof value === "string" && value ? value : undefined;
	};
	return { provider: pick("providerID") ?? pick("providerId"), model: pick("modelID") ?? pick("modelId") };
}

function usageOf(data: Record<string, unknown>): ImportedUsage {
	const tokens = data.tokens as Record<string, unknown> | undefined;
	if (!tokens) return {};
	const cache = tokens.cache as Record<string, unknown> | undefined;
	const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
	return {
		input: num(tokens.input),
		output: num(tokens.output),
		reasoning: num(tokens.reasoning),
		cacheRead: num(cache?.read),
		cacheWrite: num(cache?.write),
		totalTokens: num(tokens.total),
	};
}

/** 消息内容块（user 消息也会带 file 附件） */
function partBlocks(data: Record<string, unknown>): { blocks: ImportedBlock[]; ignored: number } {
	const type = typeof data.type === "string" ? data.type : "";
	if (type === "text") return { blocks: compactBlocks([textBlock(data.text)]), ignored: 0 };
	if (type === "file") {
		const image = imageFromUrl(data.url, data.mime);
		if (image) return { blocks: [image], ignored: 0 };
		// zcode 的附件是 zcode-artifact:// 协议，取不出字节：留一条文本注记而不是丢弃
		const name = typeof data.filename === "string" ? data.filename : typeof data.mime === "string" ? data.mime : "附件";
		return { blocks: compactBlocks([textBlock(`[附件: ${name}]`)]), ignored: 0 };
	}
	return { blocks: [], ignored: 1 };
}

/**
 * 一条 message = 一次模型请求（opencode 血缘的表结构就是这样），所以按 pi 的原生形状合成：
 * **一条 assistant 消息**（思考 + 正文 + 全部 toolCall，与 pi 自己写出来的完全一致），
 * 后面紧跟每个调用的 toolResult。拆成多条反而会打散一次请求内的调用/结果配对，
 * 用量也只能挂到最后一个碎片上。
 */
function assistantEntries(parts: Record<string, unknown>[], base: { timestamp: number; provider?: string; model?: string }): { entries: ImportedEntry[]; ignored: number } {
	const entries: ImportedEntry[] = [];
	let ignored = 0;
	let blocks: ImportedBlock[] = [];
	const results: Array<{ toolCallId: string; toolName: string; content: ImportedBlock[]; isError: boolean }> = [];

	for (const data of parts) {
		const type = typeof data.type === "string" ? data.type : "";
		if (type === "text") {
			const block = textBlock(data.text);
			if (block) blocks.push(block);
			continue;
		}
		if (type === "reasoning") {
			// 加密推理只有密文（opencode 会存 reasoningEncryptedContent）：无正文可导，丢掉
			if (typeof data.text === "string" && data.text.trim()) blocks.push({ type: "thinking", thinking: data.text });
			continue;
		}
		if (type === "tool") {
			const callId = typeof data.callID === "string" ? data.callID : "";
			const name = typeof data.tool === "string" ? data.tool : "";
			const state = data.state as Record<string, unknown> | undefined;
			if (!callId || !name) continue;
			blocks.push({ type: "toolCall", id: callId, name, arguments: state?.input ?? {} });
			const failed = state?.status === "error";
			const content = outputBlocks(state?.output ?? state?.error ?? "");
			results.push({
				toolCallId: callId,
				toolName: name,
				content: content.length ? content : compactBlocks([textBlock(failed ? "工具执行失败" : "(无输出)")]),
				isError: failed,
			});
			continue;
		}
		// step-start / step-finish / timeline / compaction / patch 等：pi 侧没有对应概念或会重复
		ignored += 1;
	}

	const hasCall = results.length > 0;
	if (blocks.length) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				content: blocks,
				timestamp: base.timestamp,
				stopReason: hasCall ? "toolUse" : "stop",
				...(base.provider ? { provider: base.provider } : {}),
				...(base.model ? { model: base.model } : {}),
			},
		});
	}
	for (const result of results) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				content: result.content,
				...(result.isError ? { isError: true } : {}),
				timestamp: base.timestamp,
			},
		});
	}
	return { entries, ignored };
}

function createSource(options: FamilyOptions): ImportSourceModule {
	async function open(): Promise<ReadOnlyDb | null> {
		return openReadOnly(options.dbPath());
	}

	return {
		id: options.id,

		async scan(scanOptions?: ScanOptions): Promise<ExternalSessionSummary[]> {
			const db = await open();
			if (!db) return [];
			try {
				if (!db.hasTable("session") || !db.hasTable("message")) return [];
				// 空会话（只有标题没有消息）与子代理会话直接在 SQL 里排掉，这样 LIMIT 才是"最近 N 条有效会话"
				const limit = scanOptions?.limit ?? 0;
				const rows = db.all(
					`SELECT s.id AS id, s.title AS title, s.directory AS directory, s.time_created AS created, s.time_updated AS updated,
					        (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
					 FROM session s
					 WHERE s.parent_id IS NULL AND (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) > 0
					 ORDER BY COALESCE(s.time_updated, s.time_created) DESC${limit > 0 ? " LIMIT ?" : ""}`,
					limit > 0 ? [limit] : [],
				);
				const file = options.dbPath();
				const out: ExternalSessionSummary[] = [];
				for (const row of rows) {
					const id = typeof row.id === "string" ? row.id : "";
					if (!id) continue;
					const title = cleanTitle(/^New session - /.test(String(row.title)) ? undefined : row.title);
					out.push({
						source: options.id,
						externalId: id,
						title,
						projectPath: typeof row.directory === "string" ? row.directory : undefined,
						createdAt: toEpochMs(row.created),
						updatedAt: toEpochMs(row.updated),
						messageCount: typeof row.msg_count === "number" ? row.msg_count : undefined,
						location: `${file}|${id}`,
					});
				}
				return out;
			} finally {
				db.close();
			}
		},

		async read(summary: ExternalSessionSummary): Promise<ImportedSession | null> {
			const separator = summary.location.lastIndexOf("|");
			if (separator < 0) return null;
			const file = summary.location.slice(0, separator);
			const sessionId = summary.location.slice(separator + 1);
			const db = await openReadOnly(file);
			if (!db) return null;
			try {
				const session = db.get("SELECT title, directory, time_created FROM session WHERE id = ?", [sessionId]);
				const messages = db.all(`SELECT id, data FROM message WHERE session_id = ? ORDER BY ${orderClause(db, "message", "time_created, id")}`, [sessionId]);
				const parts = db.all(`SELECT message_id, data FROM part WHERE session_id = ? ORDER BY ${orderClause(db, "part", "message_id, time_created, id")}`, [sessionId]);
				const partsByMessage = new Map<string, Record<string, unknown>[]>();
				for (const row of parts) {
					const messageId = typeof row.message_id === "string" ? row.message_id : "";
					const data = parseJsonColumn(row.data);
					if (!messageId || !data) continue;
					const list = partsByMessage.get(messageId);
					if (list) list.push(data);
					else partsByMessage.set(messageId, [data]);
				}

				const entries: ImportedEntry[] = [];
				let ignored = 0;
				let provider: string | undefined;
				let model: string | undefined;
				let lastAt = toEpochMs(session?.time_created) ?? summary.createdAt ?? Date.now();

				for (const row of messages) {
					const id = typeof row.id === "string" ? row.id : "";
					const data = parseJsonColumn(row.data);
					if (!data) continue;
					const time = data.time as Record<string, unknown> | undefined;
					const at = toEpochMs(time?.created) ?? toEpochMs(time?.completed) ?? lastAt;
					lastAt = at;
					const own = partsByMessage.get(id) ?? [];
					const role = typeof data.role === "string" ? data.role : "";

					if (role === "user") {
						const blocks: ImportedBlock[] = [];
						for (const part of own) {
							const result = partBlocks(part);
							blocks.push(...result.blocks);
							ignored += result.ignored;
						}
						if (!blocks.length) continue;
						entries.push({ type: "message", message: { role: "user", content: blocks, timestamp: at } });
						continue;
					}
					if (role !== "assistant") continue;

					const info = modelOf(data);
					provider = info.provider ?? provider;
					model = info.model ?? model;
					const usage = usageOf(data);
					const expanded = assistantEntries(own, { timestamp: at, provider: info.provider, model: info.model });
					ignored += expanded.ignored;
					// 一次请求的 token 记在这条消息**最后一个 assistant 条目**上（末尾常是工具结果，
					// 所以不能简单取 entries 的最后一项目），否则同一笔用量会被数多次或整个丢掉
					const usageIndex = expanded.entries.reduce((last, entry, index) => (entry.type === "message" && entry.message.role === "assistant" ? index : last), -1);
					expanded.entries.forEach((entry, index) => {
						if (index === usageIndex && entry.type === "message" && entry.message.role === "assistant" && Object.keys(usage).length) {
							entries.push({ type: "message", message: { ...entry.message, usage } });
							return;
						}
						entries.push(entry);
					});
				}

				if (!entries.some((entry) => entry.type === "message")) return null;
				const title = cleanTitle(/^New session - /.test(String(session?.title)) ? undefined : session?.title) ?? cleanTitle(summary.title);
				const skipped: string[] = [];
				if (ignored) skipped.push(`跳过 ${ignored} 个内部片段（步骤标记 / 压缩记录 / 补丁快照）`);
				return {
					summary: { ...summary, title, provider, model, projectPath: (typeof session?.directory === "string" ? session.directory : summary.projectPath) },
					entries,
					skipped,
				};
			} finally {
				db.close();
			}
		},
	};
}

export function createOcFamilySource(id: ImportSource, file: () => string): ImportSourceModule {
	return createSource({ id, dbPath: file });
}
