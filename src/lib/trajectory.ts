/**
 * 轨迹账本：对齐 dsh ui-trajectory 的 cell 模型（system/user/message/tool/compacted）。
 * 活跃会话由 pi 事件实时驱动；冷会话从 JSONL 条目离线重建。
 * pi 持久化 LLM / 工具 durationMs；TTFT/decode 由服务端自测，仅活跃会话有值。
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TrajEntry, TrajTokens } from "./types";
import { sanitizeToolOutput } from "./text-sanitize";

/** 只恢复 SDK 已记录的耗时，不从相邻消息时间戳推算。 */
function storedDuration(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function toTrajTokens(u: any): TrajTokens | undefined {
	if (!u || typeof u !== "object") return undefined;
	const t: TrajTokens = {};
	if (typeof u.input === "number") t.input = u.input;
	if (typeof u.output === "number") t.output = u.output;
	if (typeof u.cacheRead === "number") t.cacheRead = u.cacheRead;
	if (typeof u.cacheWrite === "number") t.cacheWrite = u.cacheWrite;
	return Object.keys(t).length ? t : undefined;
}

function textOf(content: any): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(textOf).join("");
	if (typeof content === "object") {
		if (typeof content.text === "string") return content.text;
		if (typeof content.thinking === "string") return content.thinking;
	}
	return "";
}

/** 工具参数里最像“这一行在干什么”的那个字段,给侧栏“最后一步”用 */
const SUMMARY_KEYS = ["command", "cmd", "script", "file_path", "path", "pattern", "query", "url"];

/** 工具参数 JSON 的上限：write 的 content 动辄整份文件，账本只保留可读的头部 */
const TOOL_ARGS_MAX_CHARS = 8_000;
/** 工具最终输出的上限：与 SSE 帧的 coercePartial 同量级，inspector 看内容也够用 */
const TOOL_RESULT_MAX_CHARS = 8_000;
/** assistant 正文 / 思考全文的上限：这些只是轨迹副本，会话 JSONL 里另有权威全文 */
const MESSAGE_TEXT_MAX_CHARS = 100_000;

function clipText(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

/** 参数对象 → 侧栏摘要（先把每个字符串值截短再挑可读字段；预计算一次存进条目） */
function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	try {
		const shallow = Object.fromEntries(
			Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 100) : v]),
		);
		const parsed = JSON.parse(JSON.stringify(shallow));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
		for (const key of SUMMARY_KEYS) {
			const value = (parsed as Record<string, unknown>)[key];
			if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ").slice(0, 80);
		}
	} catch {
		/* 序列化失败（超大/循环引用）就当没有摘要 */
	}
	return "";
}

/** 参数对象 → 供 inspector 展示的 JSON 文本；超长的字符串值先截断再序列化 */
function argsToDetail(args: unknown): string {
	const clip = (value: unknown): unknown =>
		typeof value === "string" && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
	const shallow =
		args && typeof args === "object" && !Array.isArray(args)
			? Object.fromEntries(Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, clip(v)]))
			: args;
	try {
		return clipText(JSON.stringify(shallow ?? {}, null, 2), TOOL_ARGS_MAX_CHARS);
	} catch {
		return "";
	}
}

/**
 * 侧栏「最后一步」的正文:优先真实输出(preview),没有就用事件到达时预计算的参数摘要,
 * 最后才是这行本来就有的 title。
 * 不能回落到 title —— 工具条目的 title 就是工具名(`trajectory.ts` 里 `title` / `tool_execution_start`),
 * 而 preview 只在工具返回文本时才写,于是 `bash · bash` 这种重复会一直显示到结果回来。
 */
export function toolStepPreview(entry: TrajEntry): string {
	const firstLine = (value: string | undefined) => (value ?? "").split("\n")[0].trim();
	const fromResult = firstLine(entry.preview);
	if (fromResult) return fromResult.slice(0, 80);
	// 新条目带 argSummary(事件到达时预计算);旧快照没有则退回解析 detail 的老路径
	if (entry.argSummary) return entry.argSummary.slice(0, 80);
	let args: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(entry.detail ?? "");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
	} catch {
		/* detail 可能是「args JSON + --- + 输出」的拼接,解析不了就当没有 */
	}
	if (args) {
		for (const key of SUMMARY_KEYS) {
			const value = args[key];
			if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ").slice(0, 80);
		}
	}
	// 参数里没有可读字段:保持只有工具名,不重复拼一遍
	return "";
}

/** 活跃会话的账本：消费 pi 事件流，维护 cell 列表与计时 */
export class TrajLedger {
	entries: TrajEntry[];
	private nextSeq: number;
	private streamingStart: { seq: number; t0: number; firstToken?: number } | null = null;
	/** turn_start 的时刻：请求发出前，LLM 时长与首 token 的真正起点 */
	private turnStartedAt: number | null = null;
	private toolIndex = new Map<string, number>(); // toolCallId -> entries 下标
	private toolStart = new Map<string, number>();
	private pendingToolArgs = new Map<string, unknown>();
	/** 新增或更新的条目（本轮事件循环内），供广播增量 */
	dirty: TrajEntry[] = [];

	constructor(initialEntries: TrajEntry[] = []) {
		this.entries = initialEntries.map((entry) => ({ ...entry }));
		this.nextSeq = Math.max(0, ...this.entries.map((entry) => entry.seq)) + 1;
	}

	private push(entry: Omit<TrajEntry, "seq">): TrajEntry {
		const full: TrajEntry = { ...entry, seq: this.nextSeq++ };
		this.entries.push(full);
		this.dirty.push(full);
		return full;
	}

	private touch(entry: TrajEntry | undefined): void {
		if (entry && !this.dirty.includes(entry)) this.dirty.push(entry);
	}

	drainDirty(): TrajEntry[] {
		const out = this.dirty;
		this.dirty = [];
		return out;
	}

	/** 事件到达时间（服务端计时基准） */
	onEvent(evt: AgentSessionEvent, now = Date.now()): void {
		switch (evt.type) {
			case "turn_start":
				this.turnStartedAt = now;
				break;
			case "message_start": {
				const m: any = evt.message;
				if (m?.role === "user") {
					this.push({ kind: "user", ts: m.timestamp ?? now, detail: textOf(m.content) });
				} else if (m?.role === "assistant") {
					// 供应商已经返回响应头才会有这条事件；起点用 turn_start（没有就退回现在）
					const t0 = this.turnStartedAt ?? now;
					this.turnStartedAt = null;
					this.streamingStart = { seq: this.nextSeq, t0 };
					this.push({ kind: "message", ts: t0, title: "assistant" });
				} else if (m?.role === "toolResult") {
					const idx = m.toolCallId ? this.toolIndex.get(m.toolCallId) : undefined;
					if (idx !== undefined) {
						const e = this.entries[idx];
						const result = sanitizeToolOutput(textOf(m.content));
						e.detail = result.text || e.detail;
						e.encodingLoss = result.encodingLoss || e.encodingLoss;
						e.isError = m.isError === true;
						e.tokens = toTrajTokens(m.usage) ?? e.tokens;
						const durationMs = storedDuration(m.durationMs);
						if (durationMs !== undefined) e.timing = { ...e.timing, durationMs };
						this.touch(e);
					}
				}
				break;
			}
			case "message_update": {
				const e: any = evt.assistantMessageEvent;
				if (!e) break;
				if ((e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") && e.delta?.length > 0 && this.streamingStart) {
					if (this.streamingStart.firstToken === undefined) {
						this.streamingStart.firstToken = now;
						const last = this.entries[this.entries.length - 1];
						if (last?.kind === "message") {
							last.timing = { ...(last.timing ?? {}), ttftMs: now - this.streamingStart.t0 };
							this.touch(last);
						}
					}
				}
				if (e.type === "toolcall_end" && e.toolCall) {
					this.pendingToolArgs.set(e.toolCall.id, e.toolCall.arguments);
				}
				break;
			}
			case "message_end": {
				const m: any = evt.message;
				if (m?.role === "assistant") {
					const last = this.entries[this.entries.length - 1];
					const e = last?.kind === "message" ? last : this.push({ kind: "message", ts: now });
					if (this.streamingStart) {
						e.timing = {
							...(this.streamingStart.firstToken === undefined
								? {}
								: {
									ttftMs: this.streamingStart.firstToken - this.streamingStart.t0,
									decodeMs: now - this.streamingStart.firstToken,
								}),
							durationMs: now - this.streamingStart.t0,
						};
					}
					const durationMs = storedDuration(m.durationMs);
					if (durationMs !== undefined) e.timing = { ...e.timing, durationMs };
					e.tokens = toTrajTokens(m.usage);
					e.thinking = clipText(
						textOf((m.content ?? []).filter((c: any) => c.type === "thinking").map((c: any) => c.thinking)),
						MESSAGE_TEXT_MAX_CHARS,
					) || undefined;
					e.detail = clipText(textOf((m.content ?? []).filter((c: any) => c.type === "text")), MESSAGE_TEXT_MAX_CHARS) || undefined;
					e.isError = m.stopReason === "error";
					if (m.stopReason === "error") e.title = "error";
					this.touch(e);
					this.streamingStart = null;
					// assistant 消息里的工具调用 → tool cell（结果随后由 tool_execution / toolResult 补全）
					for (const c of m.content ?? []) {
						if (c.type === "toolCall") {
							this.toolIndex.set(c.id, this.entries.length);
							this.push({
								kind: "tool",
								ts: now,
								toolName: c.name,
								toolCallId: c.id,
								title: c.name,
								detail: argsToDetail(c.arguments),
								argSummary: summarizeArgs(c.arguments),
							});
						}
					}
				}
				break;
			}
			case "tool_execution_start": {
				this.toolStart.set(evt.toolCallId, now);
				let idx = this.toolIndex.get(evt.toolCallId);
				if (idx === undefined) {
					idx = this.entries.length;
					this.toolIndex.set(evt.toolCallId, idx);
					this.push({
						kind: "tool",
						ts: now,
						toolName: evt.toolName,
						toolCallId: evt.toolCallId,
						title: evt.toolName,
						detail: argsToDetail(evt.args),
						argSummary: summarizeArgs(evt.args),
					});
				} else {
					const e = this.entries[idx];
					e.detail = argsToDetail(evt.args);
					e.argSummary = summarizeArgs(evt.args);
					this.touch(e);
				}
				break;
			}
			case "tool_execution_update": {
				const idx = this.toolIndex.get(evt.toolCallId);
				if (idx !== undefined) {
					const e = this.entries[idx];
					const result = sanitizeToolOutput(textOf(evt.partialResult));
					if (result.text) e.preview = result.text.slice(-2000);
					e.encodingLoss = result.encodingLoss || e.encodingLoss;
					this.touch(e);
				}
				break;
			}
			case "tool_execution_end": {
				const idx = this.toolIndex.get(evt.toolCallId);
				if (idx !== undefined) {
					const e = this.entries[idx];
					const result = sanitizeToolOutput(textOf(evt.result));
					// 输出截尾保留（新内容在尾部）；args 部分已在 start 时截过，两段加起来不会超限太多
					const keptArgs = e.detail?.includes("\n\n---\n\n") ? e.detail.slice(0, e.detail.indexOf("\n\n---\n\n")) : e.detail;
					const tailText = clipText(result.text, TOOL_RESULT_MAX_CHARS);
					e.detail = [keptArgs, tailText].filter(Boolean).join("\n\n---\n\n") || undefined;
					e.encodingLoss = result.encodingLoss || e.encodingLoss;
					e.isError = evt.isError === true;
					const startedAt = this.toolStart.get(evt.toolCallId);
					const durationMs = storedDuration((evt as any).durationMs) ?? (startedAt !== undefined ? now - startedAt : undefined);
					if (durationMs !== undefined) e.timing = { ...(e.timing ?? {}), durationMs };
					this.touch(e);
				}
				this.toolStart.delete(evt.toolCallId);
				break;
			}
			case "compaction_start":
				this.push({ kind: "compacted", ts: now, title: `compact (${evt.reason})` });
				break;
			case "compaction_end": {
				const last = [...this.entries].reverse().find((e) => e.kind === "compacted");
				if (last) {
					if (evt.errorMessage) {
						last.isError = true;
						last.detail = evt.errorMessage;
					}
					if (evt.result?.tokensBefore != null) last.tokens = { input: evt.result.tokensBefore };
					this.touch(last);
				}
				break;
			}
			default:
				break;
		}
	}
}

/** 冷会话：从 JSONL 条目离线重建账本（无 TTFT/decode——pi 未存） */
export function buildTrajectoryFromEntries(entries: any[]): TrajEntry[] {
	const out: TrajEntry[] = [];
	let seq = 1;
	// 消息体的 timestamp 是毫秒数，会话条目（compaction / branch_summary 等）的是 ISO 字符串。
	// 以前只认数字，压缩与分支摘要每次冷加载都被记成「现在」，在时间线上排到最后。
	// 都取不到时沿用上一条的时间，保持顺序
	let lastTs: number | undefined;
	const tsOf = (...candidates: unknown[]): number => {
		for (const value of candidates) {
			const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
			if (Number.isFinite(ms)) return (lastTs = ms);
		}
		return lastTs ?? Date.now();
	};

	for (const raw of entries) {
		if (raw.type === "message") {
			const m = raw.message;
			if (!m) continue;
			if (m.role === "user") {
				out.push({ seq: seq++, kind: "user", ts: tsOf(m.timestamp, raw.timestamp), detail: textOf(m.content) });
			} else if (m.role === "assistant") {
				const thinking = textOf((m.content ?? []).filter((c: any) => c.type === "thinking"));
				const text = textOf((m.content ?? []).filter((c: any) => c.type === "text"));
				const durationMs = storedDuration(m.durationMs);
				const ts = tsOf(m.timestamp, raw.timestamp);
				out.push({
					seq: seq++,
					kind: "message",
					ts,
					title: m.stopReason === "error" ? "error" : "assistant",
					detail: text,
					thinking: thinking || undefined,
					tokens: toTrajTokens(m.usage),
					...(durationMs === undefined ? {} : { timing: { durationMs } }),
					isError: m.stopReason === "error" || undefined,
				});
				for (const c of m.content ?? []) {
					if (c.type === "toolCall") {
						out.push({
							seq: seq++,
							kind: "tool",
							ts,
							toolName: c.name,
							toolCallId: c.id,
							title: c.name,
							detail: argsToDetail(c.arguments),
							argSummary: summarizeArgs(c.arguments),
						});
					}
				}
			} else if (m.role === "toolResult") {
				const target = out.findLast?.(
					(e) => e.kind === "tool" && (m.toolCallId ? e.toolCallId === m.toolCallId : e.toolName === m.toolName),
				);
				if (target) {
					const result = sanitizeToolOutput(textOf(m.content));
					target.detail = [target.detail, result.text].filter(Boolean).join("\n\n---\n\n");
					target.encodingLoss = result.encodingLoss || target.encodingLoss;
					target.isError = m.isError === true || undefined;
					target.tokens = toTrajTokens(m.usage) ?? target.tokens;
					const durationMs = storedDuration(m.durationMs);
					if (durationMs !== undefined) target.timing = { durationMs };
				}
			}
		} else if (raw.type === "compaction") {
			out.push({
				seq: seq++,
				kind: "compacted",
				ts: tsOf(raw.timestamp),
				title: "compact",
				tokens: raw.tokensBefore != null ? { input: raw.tokensBefore } : toTrajTokens(raw.usage),
			});
		} else if (raw.type === "branch_summary") {
			out.push({
				seq: seq++,
				kind: "compacted",
				ts: tsOf(raw.timestamp),
				title: "branch summary",
				tokens: toTrajTokens(raw.usage),
				detail: raw.summary,
			});
		}
	}
	return out;
}
