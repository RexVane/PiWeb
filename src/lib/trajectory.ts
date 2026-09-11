/**
 * 轨迹账本：对齐 dsh ui-trajectory 的 cell 模型（system/user/message/tool/compacted）。
 * 活跃会话由 pi 事件实时驱动；冷会话从 JSONL 条目离线重建。
 * pi 无耗时字段——TTFT/decode 由服务端自测，仅活跃会话有值。
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TrajEntry, TrajTokens } from "./types";
import { sanitizeToolOutput } from "./text-sanitize";

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

/** 活跃会话的账本：消费 pi 事件流，维护 cell 列表与计时 */
export class TrajLedger {
	entries: TrajEntry[];
	private nextSeq: number;
	private streamingStart: { seq: number; t0: number; firstToken?: number } | null = null;
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
			case "message_start": {
				const m: any = evt.message;
				if (m?.role === "user") {
					this.push({ kind: "user", ts: m.timestamp ?? now, detail: textOf(m.content) });
				} else if (m?.role === "assistant") {
					this.streamingStart = { seq: this.nextSeq, t0: now };
					this.push({ kind: "message", ts: now, title: "assistant" });
				} else if (m?.role === "toolResult") {
					const idx = m.toolCallId ? this.toolIndex.get(m.toolCallId) : undefined;
					if (idx !== undefined) {
						const e = this.entries[idx];
						const result = sanitizeToolOutput(textOf(m.content));
						e.detail = result.text || e.detail;
						e.encodingLoss = result.encodingLoss || e.encodingLoss;
						e.isError = m.isError === true;
						e.tokens = toTrajTokens(m.usage) ?? e.tokens;
						this.touch(e);
					}
				}
				break;
			}
			case "message_update": {
				const e: any = evt.assistantMessageEvent;
				if (!e) break;
				if ((e.type === "text_delta" || e.type === "thinking_delta") && this.streamingStart) {
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
					e.tokens = toTrajTokens(m.usage);
					e.thinking = textOf(
						(m.content ?? []).filter((c: any) => c.type === "thinking").map((c: any) => c.thinking),
					);
					e.detail = textOf((m.content ?? []).filter((c: any) => c.type === "text"));
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
								detail: JSON.stringify(c.arguments ?? {}, null, 2),
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
						detail: JSON.stringify(evt.args ?? {}, null, 2),
					});
				} else {
					const e = this.entries[idx];
					e.detail = JSON.stringify(evt.args ?? {}, null, 2);
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
					e.detail = [e.detail, result.text].filter(Boolean).join("\n\n---\n\n");
					e.encodingLoss = result.encodingLoss || e.encodingLoss;
					e.isError = evt.isError === true;
					const startedAt = this.toolStart.get(evt.toolCallId);
					if (startedAt !== undefined) e.timing = { ...(e.timing ?? {}), durationMs: now - startedAt };
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
	const tsOf = (e: any) => (typeof e?.timestamp === "number" ? e.timestamp : Date.now());

	for (const raw of entries) {
		if (raw.type === "message") {
			const m = raw.message;
			if (!m) continue;
			if (m.role === "user") {
				out.push({ seq: seq++, kind: "user", ts: tsOf(m), detail: textOf(m.content) });
			} else if (m.role === "assistant") {
				const thinking = textOf((m.content ?? []).filter((c: any) => c.type === "thinking"));
				const text = textOf((m.content ?? []).filter((c: any) => c.type === "text"));
				out.push({
					seq: seq++,
					kind: "message",
					ts: tsOf(m),
					title: m.stopReason === "error" ? "error" : "assistant",
					detail: text,
					thinking: thinking || undefined,
					tokens: toTrajTokens(m.usage),
					isError: m.stopReason === "error" || undefined,
				});
				for (const c of m.content ?? []) {
					if (c.type === "toolCall") {
						out.push({
							seq: seq++,
							kind: "tool",
							ts: tsOf(m),
							toolName: c.name,
							toolCallId: c.id,
							title: c.name,
							detail: JSON.stringify(c.arguments ?? {}, null, 2),
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
				}
			}
		} else if (raw.type === "compaction") {
			out.push({
				seq: seq++,
				kind: "compacted",
				ts: tsOf(raw),
				title: "compact",
				tokens: raw.tokensBefore != null ? { input: raw.tokensBefore } : toTrajTokens(raw.usage),
			});
		} else if (raw.type === "branch_summary") {
			out.push({
				seq: seq++,
				kind: "compacted",
				ts: tsOf(raw),
				title: "branch summary",
				tokens: toTrajTokens(raw.usage),
				detail: raw.summary,
			});
		}
	}
	return out;
}
