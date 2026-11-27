"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";
import { sortArchivedSessions } from "@/lib/archived-sessions-sort";
import { savedSessionLocation, storeSessionLocation } from "@/lib/chat/session-location";
import { MAX_VISIBLE_TOOLS, previewMessage, recentTrajectory } from "@/lib/chat/web-history";


/**
 * 中央状态：会话列表轮询、当前会话 SSE 订阅、事件折叠（快照→增量）、命令发送。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pollEventStream, usesEventPolling } from "@/lib/chat/event-stream";
import { createEventBatcher, type EventBatcher } from "@/lib/event-batcher";
import { notifySessionsChanged } from "@/lib/session-change-events";
import { clampThinkingLevelTo } from "@/lib/thinking-level";
import { useI18n } from "@/i18n";
import type {
	GrowthRound,
	SessionSummary,
	WebContent,
	WebEvent,
	WebExtensionWidget,
	WebUiNode,
	WebMessage,
	WebNestedCall,
	WebSnapshot,
} from "@/lib/types";

export interface ToolCardState {
	name: string;
	args: unknown;
	state: "running" | "done";
	partialResult?: string;
	result?: string;
	/** 工具返回的图片；已持久化时仅保存懒加载 URL，不把 base64 常驻在浏览器。 */
	images?: Array<Extract<WebContent, { type: "image" }>>;
	isError?: boolean;
	encodingLoss?: boolean;
	/** edit/write 的 unified patch，用于渲染红绿 diff */
	patch?: string;
	/** 服务端事件时间戳：运行中显示已用时长，完成后显示耗时 */
	startedAt?: number;
	endedAt?: number;
	/** 嵌套调用：发起它的那次工具调用（codemode 脚本、扩展的 ctx.executeTool） */
	parentId?: string;
	/** Nested calls can persist their outcome without storing the response body. */
	recordedStatus?: WebNestedCall["status"];
	/** 这次调用自己发起的嵌套调用，按出现顺序 */
	children?: string[];
}

/**
 * 需要浏览器应答的对话框：扩展发来的 select/confirm/input/editor（对应 pi RPC 的 extension_ui_request），

 */
export interface ExtensionDialog {
	id: string;
	method: "select" | "confirm" | "input" | "editor" | "web";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	/** editor：编辑框的初始内容 */
	prefill?: string;
	/** web：扩展给的界面树；webText 是终端组件的纯文本兜底 */
	tree?: WebUiNode;
	webText?: string;
	timeout?: number;
	ts: number;
}

/** 右下角的短通知：扩展 notify，或 PiWeb 自己的提示（带 code，渲染时按语言取文案） */
export interface PiWebNotice {
	id: string;
	message: string;
	type: "info" | "warning" | "error";
	ts: number;
	/** external_reload：终端写了这个会话，已从磁盘重载；external_write：正在跑时终端也在写 */
	code?: "external_reload" | "external_write";
	count?: number;
}

export interface PiWebState {
	snapshot: WebSnapshot | null;
	messages: WebMessage[];
	tools: Record<string, ToolCardState>;
	connected: boolean;
	error: string | null;
	compaction: { phase: "start" | "end"; errorMessage?: string; ts: number } | null;
	/** 自动重试通知（随消息流显示的折叠行，流结束清除） */
	retryNotice: string | null;
	/** 扩展对话框队列（按到达顺序，一次显示一个） */
	extensionDialogs: ExtensionDialog[];
	/** 扩展通知（notify），显示几秒后消失 */
	extensionNotices: PiWebNotice[];
	/** 扩展设的页脚状态文本（setStatus） */
	extensionStatuses: Record<string, string>;
	/** 扩展设的文字块（setWidget）：输入框上方 / 下方 */
	extensionWidgets: Record<string, WebExtensionWidget>;
	/** 扩展设的窗口标题（setTitle）；null = 用会话名 */
	extensionTitle: string | null;
	/** 扩展要放进输入框的文字（setEditorText）；id 每次不同，同样的文字连发两次也会再放一次 */
	editorText: { id: string; text: string } | null;
	/** 扩展覆盖的「工作中」文案（setWorkingMessage） */
	workingMessage: string | null;
	/** 项目生长：本次连接期间收到的 commit（完整时间轴由 useGrowth 拉取后按 commit 去重合并） */
	growth: { rounds: GrowthRound[]; error: string | null };
}

export interface SessionListItem extends SessionSummary {
	streaming: boolean;
	/** 正在运行的会话最后一个工具步骤（侧栏副标题） */
	lastStep?: string;
}

const OPTIMISTIC_STREAM_PREFIX = "__optimistic__:";

interface PendingOptimisticPrompt {
	streamId: string;
	message: WebMessage;
	anchorId: string | null;
	rawText: string;
	signature: string;
	settled: boolean;
}

interface PendingThinkingSelection {
	id: number;
	level: string;
	previousLevel?: string;
	settled: boolean;
	settledAt?: number;
	seqAtDispatch?: number;
}

function isOptimisticUserMessage(message: WebMessage | undefined): boolean {
	return Boolean(message && message.role === "user" && !message.id && message.streamId?.startsWith(OPTIMISTIC_STREAM_PREFIX));
}

function userMessageSignature(message: WebMessage): string {
	const parts: string[] = [];
	for (const part of message.content ?? []) {
		if (part.type === "text") parts.push(`t:${part.text.trim()}`);
		else if (part.type === "image") parts.push(`i:${part.mimeType}:${part.data.length}:${part.data.slice(0, 24)}`);
	}
	return parts.join("|");
}

function buildOptimisticUserMessage(text: string, images: unknown, streamId: string): WebMessage {
	const content: WebMessage["content"] = [];
	const trimmed = text.trim();
	if (trimmed) content.push({ type: "text", text: trimmed });
	if (Array.isArray(images)) {
		for (const item of images) {
			if (
				item
				&& typeof item === "object"
				&& typeof (item as { data?: unknown }).data === "string"
				&& typeof (item as { mimeType?: unknown }).mimeType === "string"
			) {
				content.push({
					type: "image",
					data: (item as { data: string }).data,
					mimeType: (item as { mimeType: string }).mimeType,
				});
			}
		}
	}
	return { role: "user", content, streamId, timestamp: Date.now() };
}

function snapshotContainsOptimisticPrompt(messages: WebMessage[], pending: PendingOptimisticPrompt): boolean {
	if (pending.anchorId) {
		const idx = messages.findIndex((m) => (m.id ?? m.streamId) === pending.anchorId);
		if (idx >= 0) {
			return messages.slice(idx + 1).some((m) => m.role === "user" && !isOptimisticUserMessage(m));
		}
		return messages.slice(-4).some((m) => m.role === "user" && !isOptimisticUserMessage(m) && userMessageSignature(m) === pending.signature);
	}
	return messages.some((m) => m.role === "user" && !isOptimisticUserMessage(m));
}

function clearCompletedCompaction(s: PiWebState): void {
	if (s.compaction?.phase === "end" && !s.compaction.errorMessage) s.compaction = null;
}

const foldEvent = (state: PiWebState, evt: WebEvent): PiWebState => {
	const s = { ...state };
	switch (evt.type) {
		case "delta": {
			// 又开始出 token 了：不管有没有收到重试结束事件，重试行都收掉。
			// 只靠 retry_end 不够——SDK 换了事件名、某条路径没发结束事件、旧服务端压根不发，
			// 界面就会挂着「重试 1/5」而模型其实早在正常输出了（用户已反馈两次）。
			s.retryNotice = null;
			clearCompletedCompaction(s);
			// 新服务端按稳定流 ID 定位；旧协议仍按最近 pending 消息兼容。
			const msgs = [...s.messages];
			// 从尾部找：增量几乎总是落在最后一条消息上，长会话里从头扫每个 token 都是一次全表遍历
			let i = msgs.length - 1;
			if (evt.messageId) while (i >= 0 && msgs[i].streamId !== evt.messageId && msgs[i].id !== evt.messageId) i -= 1;
			else while (i >= 0 && msgs[i].role !== "assistant" && msgs[i].role !== "user") i -= 1;
			if (evt.messageId && i >= 0 && msgs[i].stopReason && msgs[i].stopReason !== "pending") return s;
			if (i < 0 || msgs[i].role !== "assistant" || (msgs[i].stopReason ?? "pending") !== "pending") {
				msgs.push({ role: "assistant", content: [], streamId: evt.messageId, stopReason: "pending", timestamp: evt.ts });
				i = msgs.length - 1;
			}
			{
				const m = { ...msgs[i] };
				const content = [...m.content];
				while (content.length <= evt.contentIndex) content.push({ type: "text", text: "" });
				const c: any = { ...content[evt.contentIndex] };
				if (evt.kind === "text" && c.type !== "text") {
					content[evt.contentIndex] = { type: "text", text: evt.delta };
				} else if (evt.kind === "thinking") {
					if (c.type !== "thinking") content[evt.contentIndex] = { type: "thinking", thinking: evt.delta };
					else c.thinking = (c.thinking ?? "") + evt.delta, content[evt.contentIndex] = c;
				} else if (c.type === "text") {
					c.text = (c.text ?? "") + evt.delta;
					content[evt.contentIndex] = c;
				}
				m.content = content;
				msgs[i] = m;
			}
			msgs[i] = previewMessage(msgs[i]);
			s.messages = msgs;
			return s;
		}
		case "toolcall": {
			clearCompletedCompaction(s);
			// 参数还在生成：先把这一行立起来（args 是截短过的部分参数，完整参数随 message end 到达）
			const msgs = [...s.messages];
			let i = msgs.length - 1;
			if (evt.messageId) while (i >= 0 && msgs[i].streamId !== evt.messageId && msgs[i].id !== evt.messageId) i -= 1;
			if (i < 0 || msgs[i].role !== "assistant") return s;
			const content = [...msgs[i].content];
			const existing = content[evt.contentIndex];
			// 已经拿到完整参数（message end 先到）时不要用截短版本覆盖
			if (existing?.type === "toolCall" && existing.id === evt.id && msgs[i].stopReason !== "pending") return s;
			while (content.length < evt.contentIndex) content.push({ type: "text", text: "" });
			content[evt.contentIndex] = { type: "toolCall", id: evt.id, name: evt.name, arguments: evt.args };
			msgs[i] = { ...msgs[i], content };
			s.messages = msgs;
			return s;
		}
		case "bash_output": {
			// `!` 命令的输出增量：接在服务端推的那条 bashExecution 消息后面
			const msgs = [...s.messages];
			let i = msgs.length - 1;
			while (i >= 0 && msgs[i].streamId !== evt.messageId && msgs[i].id !== evt.messageId) i -= 1;
			if (i < 0 || !msgs[i].bash) return s;
			const message = msgs[i];
			if (!message.bash) return s;
			const bash = message.bash;
			msgs[i] = { ...message, bash: { ...bash, output: `${bash.output}${evt.delta}` } };
			s.messages = msgs;
			return s;
		}
		case "message": {
			if (evt.message.role !== "summary") clearCompletedCompaction(s);
			if (evt.phase === "end" && evt.message.role === "toolResult") {
				const images = evt.message.content.filter((part) => part.type === "image");
				if (images.length || evt.message.content.some((part) => part.type === "toolResult" && part.toolCallId && s.tools[part.toolCallId]?.images?.length)) {
					const tools = { ...s.tools };
					for (const part of evt.message.content) {
						if (part.type !== "toolResult" || !part.toolCallId || (!images.length && !tools[part.toolCallId]?.images?.length)) continue;
						// 长会话的工具缓存可能已淘汰这次调用，仍可用消息里的参数关联权威结果。
						const call = !tools[part.toolCallId]
							? s.messages.findLast((message) => message.content.some((content) => content.type === "toolCall" && content.id === part.toolCallId))?.content.find((content): content is Extract<WebContent, { type: "toolCall" }> => content.type === "toolCall" && content.id === part.toolCallId)
							: undefined;
						const tool: ToolCardState | undefined = tools[part.toolCallId] ?? (call ? { name: call.name, args: call.arguments, state: "done" } : undefined);
						if (!tool) continue;
						tools[part.toolCallId] = { ...tool, state: "done", result: tool.result ?? part.text, isError: part.isError ?? tool.isError, images, endedAt: tool.endedAt ?? evt.ts };
					}
					s.tools = tools;
				}
			}
			const msgs = [...s.messages];
			const same = msgs.findIndex((message) =>
				(!!evt.message.id && message.id === evt.message.id) ||
				(!!evt.message.streamId && message.streamId === evt.message.streamId));
			if (same >= 0) {
				// snapshot 可能已包含 final，但 SDK 的扩展 message_end 还没返回；不能丢掉权威 end。
				if (evt.phase === "end") msgs[same] = { ...msgs[same], ...evt.message };
				s.messages = msgs;
				return s;
			}
			if (evt.message.role === "user") {
				for (let i = msgs.length - 1; i >= 0; i -= 1) {
					if (isOptimisticUserMessage(msgs[i])) {
						msgs[i] = evt.message;
						s.messages = msgs;
						return s;
					}
				}
			}
			if (evt.phase === "start") {
				// custom：扩展注入并声明要显示的消息；bashExecution：用户 `!` 命令
				if (evt.message.role === "user" || evt.message.role === "assistant" || evt.message.role === "custom" || evt.message.role === "bashExecution")
					msgs.push(evt.message);
			} else if (evt.message.role !== "toolResult" || evt.message.content.some((part) => part.type === "image")) {
				// 图片结果保留其懒加载引用；工具缓存淘汰后、或加载早期历史页时仍能还原图集。
				// 无稳定流 ID 的旧服务端：只在本轮末尾匹配 pending，不按时间戳覆盖历史消息。
				let index = -1;
				if (!evt.message.streamId) {
					const last = msgs[msgs.length - 1];
					if (evt.message.role === "assistant" && last?.role === "assistant" && (last.stopReason ?? "pending") === "pending") index = msgs.length - 1;
					if (evt.message.role === "user" && last?.role === "user" && !last.id && !last.streamId) index = msgs.length - 1;
				}
				if (index >= 0) msgs[index] = evt.message;
				else msgs.push(evt.message);
			}
			s.messages = msgs;
			return s;
		}
		case "tool": {
			clearCompletedCompaction(s);
			const tools = { ...s.tools };
			const prev = tools[evt.id];
			tools[evt.id] = {
				name: evt.name,
				args: evt.args ?? prev?.args,
				state: evt.state,
				partialResult: evt.partialResult ?? (evt.state === "done" ? undefined : prev?.partialResult),
				result: evt.result ?? prev?.result,
				images: evt.images ?? prev?.images,
				isError: evt.isError ?? prev?.isError,
				encodingLoss: evt.encodingLoss ?? prev?.encodingLoss,
				patch: evt.patch ?? prev?.patch,
				startedAt: prev?.startedAt ?? evt.ts,
				endedAt: evt.state === "done" ? evt.ts : prev?.endedAt,
				parentId: evt.parentId ?? prev?.parentId,
				children: prev?.children,
			};
			// 嵌套调用（codemode 脚本里发起的工具调用）：挂到父调用下面，聊天里不再是一片平铺
			const parentId = evt.parentId;
			if (parentId && tools[parentId]) {
				const ids = tools[parentId].children ?? [];
				if (!ids.includes(evt.id)) tools[parentId] = { ...tools[parentId], children: [...ids, evt.id] };
			}
			s.tools = tools;
			return s;
		}
		case "queue":
			if (s.snapshot)
				s.snapshot = { ...s.snapshot, queue: { steering: evt.steering, followUp: evt.followUp, ...(evt.revision ? { revision: evt.revision } : {}), ...(evt.editTokens ? { editTokens: evt.editTokens } : {}) } };
			return s;
		case "model": {
			if (s.snapshot) {
				const snap = { ...s.snapshot };
				if (evt.model) {
					const sameModel = snap.model?.id === evt.model && (!evt.provider || snap.model?.provider === evt.provider);
					snap.model = sameModel && snap.model
						? snap.model
						: { ...(snap.model ?? { provider: "", id: "", name: "" }), id: evt.model, name: evt.model };
				}
				if (evt.provider && snap.model) snap.model = { ...snap.model, provider: evt.provider };
				if (evt.thinkingLevel) snap.thinkingLevel = evt.thinkingLevel;
				if (evt.thinkingLevels) snap.thinkingLevels = evt.thinkingLevels;
				// 省略 = 不变；null = 不是虚拟模型
				if (evt.routedModel !== undefined) snap.routedModel = evt.routedModel;
				s.snapshot = snap;
			}
			return s;
		}
		case "usage":
			if (s.snapshot) s.snapshot = { ...s.snapshot, stats: evt.stats, contextUsage: evt.contextUsage };
			return s;
		case "compaction":
			if (evt.marker) {
				// 当前服务端按完成顺序追加；仍兼容带插入锚点的旧服务端。
				const marker = evt.marker;
				const msgs = s.messages.filter((message) => !(marker.id && message.id === marker.id));
				const at = msgs.findIndex((message) =>
					(!!evt.beforeId && message.id === evt.beforeId) ||
					(!!evt.beforeStreamId && message.streamId === evt.beforeStreamId));
				if (at >= 0) msgs.splice(at, 0, marker);
				else msgs.push(marker);
				s.messages = msgs;
			}
			// 已有消息流分隔卡时直接清掉底部状态条，避免与历史分隔卡重复及持续粘在回复末尾；
			// 仅在压缩中、压缩失败或未带分隔卡降级时保留底部提示
			s.compaction = evt.phase === "end" && !evt.errorMessage && evt.marker
				? null
				: { phase: evt.phase, errorMessage: evt.errorMessage, ts: evt.ts };
			return s;
		case "traj": {
			if (s.snapshot) {
				const traj = [...s.snapshot.trajectory];
				const idx = traj.findIndex((e) => e.seq === evt.entry.seq);
				if (idx >= 0) traj[idx] = evt.entry;
				else traj.push(evt.entry);
				s.snapshot = { ...s.snapshot, trajectory: traj };
			}
			return s;
		}
		case "name":
			if (s.snapshot) s.snapshot = { ...s.snapshot, name: evt.name };
			return s;
		case "tools":
			if (s.snapshot) s.snapshot = {
				...s.snapshot,
				tools: { active: evt.active, all: evt.all.map((n) => ({ name: n })) },
			};
			return s;
		case "context_breakdown":
			if (s.snapshot) s.snapshot = { ...s.snapshot, contextBreakdown: evt.breakdown };
			return s;
		case "resources":
			if (s.snapshot) {
				s.snapshot = {
					...s.snapshot,
					skills: evt.skills,
					promptTemplates: evt.promptTemplates,
					extensionCommands: evt.extensionCommands,
					projectTrust: evt.projectTrust,
					resourceDiagnostics: evt.resourceDiagnostics,
				};
			}
			return s;
		case "extension_ui": {
			if (isDialogMethod(evt.method)) {
				if (s.extensionDialogs.some((dialog) => dialog.id === evt.id)) return s;
				s.extensionDialogs = [
					...s.extensionDialogs,
					{ id: evt.id, method: evt.method, title: evt.title ?? "", message: evt.message, options: evt.options, placeholder: evt.placeholder, prefill: evt.prefill, tree: evt.tree, webText: evt.webText, timeout: evt.timeout, ts: evt.ts },
				];
			} else if (evt.method === "notify") {
				s.extensionNotices = [...s.extensionNotices.slice(-4), { id: evt.id, message: evt.message ?? "", type: evt.notifyType ?? "info", ts: evt.ts }];
			} else if (evt.method === "setStatus" && evt.statusKey) {
				const next = { ...s.extensionStatuses };
				if (evt.statusText === undefined || evt.statusText === "") delete next[evt.statusKey];
				else next[evt.statusKey] = evt.statusText;
				s.extensionStatuses = next;
			} else if (evt.method === "setWidget" && evt.widgetKey) {
				const next = { ...s.extensionWidgets };
				if (evt.widgetLines === undefined || evt.widgetLines.length === 0) delete next[evt.widgetKey];
				else next[evt.widgetKey] = { lines: evt.widgetLines, placement: evt.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor" };
				s.extensionWidgets = next;
			} else if (evt.method === "setTitle") {
				s.extensionTitle = evt.title?.trim() ? evt.title : null;
			} else if (evt.method === "setEditorText") {
				s.editorText = { id: evt.id, text: evt.text ?? "" };
			} else if (evt.method === "setWorkingMessage") {
				s.workingMessage = evt.message ?? null;
			}
			return s;
		}
		case "extension_ui_resolved":
			s.extensionDialogs = s.extensionDialogs.filter((dialog) => dialog.id !== evt.id);
			return s;
		case "external_write":
			s.extensionNotices = [
				...s.extensionNotices.filter((notice) => notice.code !== "external_write").slice(-4),
				{ id: `external-write-${evt.ts}`, message: "", type: "warning", ts: evt.ts, code: "external_write", count: evt.entries },
			];
			return s;
		case "status":
			if (s.snapshot) s.snapshot = { ...s.snapshot, isStreaming: evt.isStreaming };
			if (!evt.isStreaming) {
				s.retryNotice = null;
				s.workingMessage = null;
			}
			return s;
		case "growth": {
			const rounds = s.growth.rounds.some((x) => x.commit === evt.round.commit) ? s.growth.rounds : [...s.growth.rounds, evt.round];
			s.growth = { ...s.growth, rounds, error: null };
			return s;
		}
		case "growth_error":
			s.growth = { ...s.growth, error: evt.message };
			return s;
		case "retry":
			// 只保留最后一次尝试:重试过程在界面上是「重试 3/5」这一条,而不是五行报错
			s.retryNotice = evt.maxAttempts
				? `重试 ${evt.attempt}/${evt.maxAttempts}${evt.message ? `：${evt.message}` : ""}`
				: `重试 ${evt.attempt}${evt.message ? `：${evt.message}` : ""}`;
			return s;
		case "retry_end":
			// 重试区间结束(SDK auto_retry_end):立刻收掉重试行。
			// 重试常发生在下一轮 agent 开始之前,而那段间隙不会发 status:isStreaming=false,
			// 所以不能只等 agent_settled —— 否则用户会一直看到「重试 1/5 terminated」。
			s.retryNotice = null;
			return s;
		case "error":
			// 旧服务端把自动重试塞在 error 里：同样按通知处理，不占错误条
			if (/^(自动重试|重试)/.test(evt.message)) s.retryNotice = evt.message;
			else s.error = evt.message;
			return s;
		default:
			return s;
	}
};

export const foldPiWebEvent = (state: PiWebState, event: WebEvent): PiWebState => {
	const evt = event.type === "message" ? { ...event, message: previewMessage(event.message) }
		: event.type === "tool" && event.images ? { ...event, images: previewMessage({ role: "toolResult", content: event.images }).content.filter((part) => part.type === "image") }
		: event;
	const next = foldEvent(state, evt);
	if (next.tools !== state.tools && Object.keys(next.tools).length > MAX_VISIBLE_TOOLS) {
		const entries = Object.entries(next.tools);
		const keep = new Set(entries.slice(-MAX_VISIBLE_TOOLS).map(([id]) => id));
		next.tools = Object.fromEntries(entries.filter(([id]) => keep.has(id)));
	}
	if (evt.type === "traj" && next.snapshot) next.snapshot = { ...next.snapshot, trajectory: recentTrajectory(next.snapshot.trajectory) };
	return next;
};

/**
 * 按帧折叠一批事件。同一消息、同一内容块、同类内容的连续 delta 先拼成一个字符串，
 * 再交给 foldPiWebEvent。否则 400 条批量上限下，每条 token 都会复制一次 messages
 * 和 content 数组，长会话里一帧内就是几百次 O(n) 拷贝。
 *
 * 只合并相邻事件：中间夹了 message / tool 等事件时保持原顺序，语义与逐条折叠一致。
 */
export function foldPiWebEvents(state: PiWebState, events: readonly WebEvent[]): PiWebState {
	let next = state;
	for (let i = 0; i < events.length; i += 1) {
		const event = events[i];
		if (event.type !== "delta") {
			next = foldPiWebEvent(next, event);
			continue;
		}
		let delta = event.delta;
		while (i + 1 < events.length) {
			const candidate = events[i + 1];
			if (
				candidate.type !== "delta" ||
				candidate.messageId !== event.messageId ||
				candidate.contentIndex !== event.contentIndex ||
				candidate.kind !== event.kind
			) break;
			delta += candidate.delta;
			i += 1;
		}
		next = foldPiWebEvent(next, delta === event.delta ? event : { ...event, delta });
	}
	return next;
}

function isDialogMethod(method: Extract<WebEvent, { type: "extension_ui" }>["method"]): method is ExtensionDialog["method"] {
	return method === "select" || method === "confirm" || method === "input" || method === "editor" || method === "web";
}

export function extensionDialogsFromSnapshot(snapshot: WebSnapshot, previous: ExtensionDialog[] = []): ExtensionDialog[] {
	// undefined 仅用于兼容旧服务端；新快照的空数组必须清除已答/取消的旧对话框。
	if (snapshot.extensionUiRequests === undefined) return previous;
	if (!Array.isArray(snapshot.extensionUiRequests)) return [];
	const dialogs = new Map<string, ExtensionDialog>();
	for (const request of snapshot.extensionUiRequests) {
		if (isDialogMethod(request.method)) {
			dialogs.set(request.id, { ...request, method: request.method, title: request.title ?? "" });
		}
	}
	return [...dialogs.values()];
}

function toolsFromMessages(messages: WebMessage[], streaming = false): Record<string, ToolCardState> {
	const tools: Record<string, ToolCardState> = {};
	const resolved = new Set<string>();
	for (const message of Array.isArray(messages) ? messages : []) {
		for (const content of Array.isArray(message?.content) ? message.content : []) {
			if (content.type === "toolCall") {
				tools[content.id] = { name: content.name, args: content.arguments, state: "done" };
			} else if (content.type === "toolResult" && content.toolCallId && tools[content.toolCallId]) {
				resolved.add(content.toolCallId);
				tools[content.toolCallId] = {
					...tools[content.toolCallId],
					result: content.text,
					images: message.content.filter((part) => part.type === "image"),
					isError: content.isError,
					encodingLoss: content.encodingLoss,
					patch: content.patch,
				};
				// 嵌套调用（codemode 脚本等）记在父调用的结果上：冷会话/重连后靠它把层级还原出来
				if (content.nestedCalls?.length) linkNestedCalls(tools, content.toolCallId, content.nestedCalls);
			}
		}
	}
	// 正在流式时还没有结果的调用就是正在执行（中途打开页面拿到的快照），别显示成"已完成 · 无输出"
	if (streaming) {
		for (const [id, tool] of Object.entries(tools)) {
			if (!resolved.has(id) && !tool.recordedStatus) tools[id] = { ...tool, state: "running", startedAt: Date.now() };
		}
	}
	return tools;
}

/**
 * 把嵌套调用挂到父调用下面。SDK 给的 id 是 `<父id>/<序号>`（父也可能是嵌套调用），
 * 所以先按 id 前缀找最近的已知父，找不到才用结果所属的那次调用。
 */
function linkNestedCalls(tools: Record<string, ToolCardState>, parentId: string, calls: WebNestedCall[]): void {
	for (const call of calls) {
		if (tools[call.id]) continue;
		const trimmed = call.id.slice(0, call.id.lastIndexOf("/"));
		const owner = trimmed && tools[trimmed] ? trimmed : parentId;
		tools[call.id] = {
			name: call.name,
			args: call.args,
			state: "done",
			result: call.error,
			recordedStatus: call.status,
			isError: call.status === "error",
			parentId: owner,
		};
		const ids = tools[owner].children ?? [];
		if (!ids.includes(call.id)) tools[owner] = { ...tools[owner], children: [...ids, call.id] };
	}
}

const emptyState = (): PiWebState => ({
	snapshot: null,
	messages: [],
	tools: {},
	connected: false,
	error: null,
	compaction: null,
	retryNotice: null,
	extensionDialogs: [],
	extensionNotices: [],
	extensionStatuses: {},
	extensionWidgets: {},
	extensionTitle: null,
	editorText: null,
	workingMessage: null,
	growth: { rounds: [], error: null },
});

function pathKey(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
		? normalized.toLowerCase()
		: normalized;
}

export function usePiWeb() {
	const { t } = useI18n();
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	const [sessionListError, setSessionListError] = useState<string | null>(null);
	const [workspaceRegistryWarning, setWorkspaceRegistryWarning] = useState<string | null>(null);
	/** Unlike chat errors, a partially completed deletion survives changing sessions. */
	const [sessionDeletionWarning, setSessionDeletionWarning] = useState<{ message: string; code?: string } | null>(null);
	const [sessionListRetryNonce, setSessionListRetryNonce] = useState(0);
	const [sessionSearch, setSessionSearch] = useState("");
	const [sessionPageLimit, setSessionPageLimit] = useState(200);
	const [hasMoreSessions, setHasMoreSessions] = useState(false);
	const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
	const searchSessions = useCallback((query: string) => { setSessionSearch(query); setSessionPageLimit(200); }, []);
	const loadMoreSessions = useCallback(() => { setSessionsLoadingMore(true); setSessionPageLimit((limit) => limit + 200); }, []);
	const [currentId, setCurrentId] = useState<string | null>(null);
	const [currentPath, setCurrentPath] = useState<string | null>(null);
	const [state, setState] = useState<PiWebState>(emptyState);
	/** 无限滚动加载更早消息时读取最新快照，避免把过期闭包里的 omitted 当成游标。 */
	const stateRef = useRef(state);
	stateRef.current = state;
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const loadingEarlierRef = useRef(false);
	/** 当前 SSE 连接的增量批量器：按帧合并事件，避免每个 token 一次整树渲染 */
	const batcherRef = useRef<EventBatcher<WebEvent> | null>(null);
	const [models, setModels] = useState<{ providers: any[]; models: any[] } | null>(null);
	const [modelCwd, setModelCwd] = useState("");
	const [addedWorkspaces, setAddedWorkspaces] = useState<string[]>([]);
	const [removedWorkspaces, setRemovedWorkspaces] = useState<string[]>([]);
	/** 应用内目录浏览器：是否打开，以及等待用户选择的那次调用 */
	const [dirPickerOpen, setDirPickerOpen] = useState(false);
	const dirPickResolve = useRef<((path: string | null) => void) | null>(null);
	const [groupBy, setGroupByState] = useState<"workspace" | "flat">("workspace");
	const [orderBy, setOrderByState] = useState<"updated" | "manual">("updated");
	const [resyncNonce, setResyncNonce] = useState(0);
	const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0);
	const esRef = useRef<{ close(): void } | null>(null);
	const promptRequestsRef = useRef(new Set<string>());
	const pendingOptimisticRef = useRef(new Map<string, PendingOptimisticPrompt>());
	const pendingModelOpsRef = useRef(new Map<string, Promise<unknown>>());
	const pendingThinkingRef = useRef(new Map<string, PendingThinkingSelection>());
	const thinkingSeqRef = useRef(0);
	const lastSessionSeqRef = useRef(new Map<string, { epoch?: string; seq: number }>());
	const optimisticSeqRef = useRef(0);
	const shownReloadsRef = useRef(new Set<string>());
	const liveStateRef = useRef(state);
	liveStateRef.current = state;
	const activeSessionRef = useRef(currentId);
	activeSessionRef.current = currentId;
	const currentPathRef = useRef(currentPath);
	currentPathRef.current = currentPath;
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;
	const sessionCwdByPathRef = useRef(new Map<string, string>());
	const deletedPathsRef = useRef(new Set<string>());
	const [pendingSession, setPendingSession] = useState<{ path: string; cwd: string } | null>(null);
	/** 扩展命令换会话（session_navigate 事件）时打开目标会话；SSE 处理器定义在 openSession 之前 */
	const openSessionRef = useRef<((path: string) => void) | null>(null);
	const subscribedSessionRef = useRef<string | null>(null);
	const idleMismatchRef = useRef(0);
	const lastReconcileRef = useRef(0);
	const retrySessionList = useCallback(() => setSessionListRetryNonce((value) => value + 1), []);
	const clearCompaction = useCallback(() => setState((current) => ({ ...current, compaction: null })), []);
	useEffect(() => {
		const notice = state.compaction;
		if (!notice || notice.phase !== "end") return;
		const timer = setTimeout(() => {
			setState((current) => current.compaction?.ts === notice.ts ? { ...current, compaction: null } : current);
		}, 5_000);
		return () => clearTimeout(timer);
	}, [state.compaction]);

	const idOf = useCallback((path: string) => {
		const bytes = new TextEncoder().encode(path);
		let bin = "";
		for (const b of bytes) bin += String.fromCharCode(b);
		return encodeURIComponent(btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
	}, []);

	// 视图偏好持久化
	useEffect(() => {
		let g: string | null = null, o: string | null = null;
		try { g = localStorage.getItem("piweb.groupBy"); o = localStorage.getItem("piweb.orderBy"); } catch { /* storage may be disabled */ }
		if (g === "flat" || g === "workspace") setGroupByState(g);
		if (o === "updated" || o === "manual") setOrderByState(o);
	}, []);
	const setGroupBy = useCallback((v: "workspace" | "flat") => {
		setGroupByState(v);
		try { localStorage.setItem("piweb.groupBy", v); } catch { /* preference remains in memory */ }
	}, []);
	const setOrderBy = useCallback((v: "updated" | "manual") => {
		setOrderByState(v);
		try { localStorage.setItem("piweb.orderBy", v); } catch { /* preference remains in memory */ }
	}, []);

	const [workspaceAliases, setWorkspaceAliases] = useState<Record<string, string>>({});
	const [archivedSessionPaths, setArchivedSessionPaths] = useState<string[]>([]);
	const [archivedAt, setArchivedAt] = useState<Record<string, number>>({});
	const [pinnedSessionPaths, setPinnedSessionPaths] = useState<string[]>([]);

	// 手动添加的工作区与别名、归档、置顶
	const refreshWorkspaces = useCallback(async () => {
		try {
			const r = await fetch("/api/workspaces");
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (j.success) {
				setWorkspaceRegistryWarning(typeof j.data.error === "string" ? j.data.error : typeof j.data.warning === "string" ? j.data.warning : null);
				if (Array.isArray(j.data.workspaces)) setAddedWorkspaces(j.data.workspaces);
				if (Array.isArray(j.data.removedWorkspaces)) setRemovedWorkspaces(j.data.removedWorkspaces);
				if (j.data.aliases && typeof j.data.aliases === "object") setWorkspaceAliases(j.data.aliases);
				if (Array.isArray(j.data.archivedSessions)) setArchivedSessionPaths(j.data.archivedSessions);
				setArchivedAt(j.data.archivedAt ?? {});
				if (Array.isArray(j.data.pinnedSessions)) setPinnedSessionPaths(j.data.pinnedSessions);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load workspaces";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, []);
	// 挂载时不再单独拉一次 /api/workspaces：首个 /api/sessions 响应里带着同一份 registry，
	// 少一次请求也少一次服务端读盘；只有会话列表拉不到时才用它兜底（见轮询的 catch）。
	const workspaceRegistryLoaded = useRef(false);
	const refreshWorkspacesFallback = useCallback(async () => {
		if (workspaceRegistryLoaded.current) return;
		await refreshWorkspaces().catch(() => undefined);
	}, [refreshWorkspaces]);

	/** 会话改名成功后先把列表里的名字改掉，不等下一次轮询（轮询 3 秒 + 服务端 1.2 秒列表缓存） */
	const patchSessionName = useCallback((sessionPath: string, name: string) => {
		const key = pathKey(sessionPath);
		setSessions((prev) => prev.map((s) => (pathKey(s.path) === key ? { ...s, name } : s)));
	}, []);

	const renameWorkspace = useCallback(async (dir: string, name: string) => {
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "rename", path: dir, name }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (typeof j.data?.warning === "string") setWorkspaceRegistryWarning(j.data.warning);
			if (j.data?.aliases) setWorkspaceAliases(j.data.aliases);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to rename workspace";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, []);

	const archiveSession = useCallback(async (sessionPath: string) => {
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "archiveSession", path: sessionPath }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (typeof j.data?.warning === "string") setWorkspaceRegistryWarning(j.data.warning);
			if (Array.isArray(j.data?.archivedSessions)) setArchivedSessionPaths(j.data.archivedSessions);
			setArchivedAt(j.data?.archivedAt ?? {});
			const key = pathKey(sessionPath);
			setPinnedSessionPaths((prev) => prev.filter((p) => pathKey(p) !== key));
			notifySessionsChanged();
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to archive session";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, []);

	const unarchiveSession = useCallback(async (sessionPath: string) => {
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "forgetSession", path: sessionPath }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (typeof j.data?.warning === "string") setWorkspaceRegistryWarning(j.data.warning);
			if (Array.isArray(j.data?.archivedSessions)) setArchivedSessionPaths(j.data.archivedSessions);
			setArchivedAt(j.data?.archivedAt ?? {});
			notifySessionsChanged();
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to unarchive session";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, []);

	const pinSession = useCallback(async (sessionPath: string) => {
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "pinSession", path: sessionPath }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (typeof j.data?.warning === "string") setWorkspaceRegistryWarning(j.data.warning);
			if (Array.isArray(j.data?.pinnedSessions)) setPinnedSessionPaths(j.data.pinnedSessions);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to pin session";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, []);

	const unpinSession = useCallback(async (sessionPath: string) => {
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "unpinSession", path: sessionPath }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			if (typeof j.data?.warning === "string") setWorkspaceRegistryWarning(j.data.warning);
			if (Array.isArray(j.data?.pinnedSessions)) setPinnedSessionPaths(j.data.pinnedSessions);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to unpin session";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, []);

	/** Recycle the session file after stopping it; remove it from the list only on success. */
	const deleteSession = useCallback(async (sessionPath: string) => {
		setSessionDeletionWarning(null);
		try {
			const r = await fetch(`/api/sessions/${idOf(sessionPath)}`, { method: "DELETE" });
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.errorCode === "TRASH_UNAVAILABLE" ? t.apiErrorTrashUnavailable : j.error || `request failed (${r.status})`);
			if (typeof j.data?.warning === "string") setSessionDeletionWarning({ message: j.data.warning, ...(typeof j.data.warningCode === "string" ? { code: j.data.warningCode } : {}) });
			const key = pathKey(sessionPath);
			sessionCwdByPathRef.current.delete(key);
			deletedPathsRef.current.add(key);
			setPendingSession((prev) => (prev && pathKey(prev.path) === key ? null : prev));
			setSessions((prev) => prev.filter((s) => pathKey(s.path) !== key));
			setArchivedSessionPaths((prev) => prev.filter((p) => pathKey(p) !== key));
			setArchivedAt((prev) => Object.fromEntries(Object.entries(prev).filter(([p]) => pathKey(p) !== key)));
			setPinnedSessionPaths((prev) => prev.filter((p) => pathKey(p) !== key));
			notifySessionsChanged();
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to delete session";
			setState((current) => ({ ...current, error: message }));
			throw error;
		}
	}, [idOf, t.apiErrorTrashUnavailable]);

	const getWorkspaceName = useCallback(
		(dir: string): string => {
			if (!dir) return "";
			const norm = pathKey(dir);
			for (const [k, v] of Object.entries(workspaceAliases)) {
				if (pathKey(k) === norm && v.trim()) {
					return v;
				}
			}
			return dir.split(/[\\/]/).filter(Boolean).pop() || dir;
		},
		[workspaceAliases],
	);



	/** 选择文件夹并加入工作区；远程设备或原生选择器不可用时在页面内选择。 */
	const addWorkspaceByPicker = useCallback(async (): Promise<string | null> => {
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "pick" }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			// 远程请求和原生选择器失败共用目录浏览器，等选完再返回路径。
			if (j.data?.remote || j.data?.browse) {
				setDirPickerOpen(true);
				return await new Promise<string | null>((resolve) => {
					dirPickResolve.current = resolve;
				});
			}
			if (j.success && j.data?.path) {
				setAddedWorkspaces(j.data.workspaces ?? []);
				await refreshWorkspaces();
				return j.data.path as string;
			}
			return null;
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to add workspace";
			setState((current) => ({ ...current, error: message }));
			return null;
		}
	}, [refreshWorkspaces]);

	/** 应用内目录浏览器：用户选定了某个文件夹 */
	const confirmDirPicker = useCallback(async (path: string) => {
		setDirPickerOpen(false);
		const settle = dirPickResolve.current;
		dirPickResolve.current = null;
		try {
			const r = await fetch("/api/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "add", path }),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
			setAddedWorkspaces(j.data?.workspaces ?? []);
			await refreshWorkspaces();
			settle?.(path);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to add workspace";
			setState((current) => ({ ...current, error: message }));
			settle?.(null);
		}
	}, [refreshWorkspaces]);

	/** 应用内目录浏览器：取消 */
	const cancelDirPicker = useCallback(() => {
		setDirPickerOpen(false);
		const settle = dirPickResolve.current;
		dirPickResolve.current = null;
		settle?.(null);
	}, []);


	const removeWorkspace = useCallback(
		async (dir: string) => {
			try {
				const r = await fetch("/api/workspaces", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: "remove", path: dir }),
				});
				const j = await r.json();
				if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
				if (j.data) {
					if (Array.isArray(j.data.workspaces)) setAddedWorkspaces(j.data.workspaces);
					if (Array.isArray(j.data.removedWorkspaces)) setRemovedWorkspaces(j.data.removedWorkspaces);
					if (j.data.aliases && typeof j.data.aliases === "object") setWorkspaceAliases(j.data.aliases);
				}
				await refreshWorkspaces();
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to remove workspace";
				setState((current) => ({ ...current, error: message }));
				throw error;
			}
		},
		[refreshWorkspaces],
	);

	// 会话列表轮询（3 秒，多标签同步）；隐藏标签页暂停，单个标签内不会重叠请求。
	useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let controller: AbortController | undefined;
		// 上一次列表的 ETag：内容没变服务端答 304，跳过解析与 setState（侧栏不会每 3 秒白白重渲染一次）
		let lastEtag: string | null = null;
		let lastRunning: Record<string, { streaming: boolean; lastStep?: string }> = {};
		const reconcile = () => {
			const current = liveStateRef.current.snapshot;
			if (current?.isStreaming && lastRunning[current.sessionPath]?.streaming !== true) {
				idleMismatchRef.current += 1;
				if (idleMismatchRef.current >= 2 && Date.now() - lastReconcileRef.current > 30_000) {
					lastReconcileRef.current = Date.now(); idleMismatchRef.current = 0; setResyncNonce((n) => n + 1);
				}
			} else idleMismatchRef.current = 0;
		};
		const schedule = () => {
			if (!alive || document.visibilityState !== "visible") return;
			timer = setTimeout(() => void load(false), 3000);
		};
		const load = async (force: boolean) => {
			if (!alive || (!force && document.visibilityState !== "visible")) return;
			controller = new AbortController();
			try {
				const r = await fetch(`/api/sessions?limit=${Math.min(sessionPageLimit, 500)}${sessionSearch ? `&q=${encodeURIComponent(sessionSearch)}` : ""}`, { signal: controller.signal, headers: lastEtag ? { "If-None-Match": lastEtag } : undefined });
				if (r.status === 304) {
					if (alive) { setSessionListError(null); reconcile(); }
					return;
				}
				const j = await r.json();
				if (!alive) return;
				if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
				setSessionListError(null);
				let page: SessionSummary[] = Array.isArray(j.data.sessions) ? j.data.sessions : [];
				let nextOffset = j.data.nextOffset;
				while (typeof nextOffset === "number" && page.length < sessionPageLimit) {
					const more = await fetch(`/api/sessions?limit=${Math.min(500, sessionPageLimit - page.length)}&offset=${nextOffset}${sessionSearch ? `&q=${encodeURIComponent(sessionSearch)}` : ""}`, { signal: controller.signal });
					const result = await more.json();
					if (!more.ok || !result.success) throw new Error(result.error || "session list request failed");
					page = [...page, ...result.data.sessions]; nextOffset = result.data.nextOffset;
				}
				if (!alive) return;
				setHasMoreSessions(nextOffset !== null && nextOffset !== undefined);
				setSessionsLoadingMore(false);
				lastEtag = sessionPageLimit <= 500 ? r.headers.get("etag") : null;
				const running: Record<string, { streaming: boolean; lastStep?: string }> = j.data.running ?? {};
				lastRunning = running;
				reconcile();
				const registry = j.data.workspaceRegistry;
				if (registry) {
					workspaceRegistryLoaded.current = true;
					setWorkspaceRegistryWarning(typeof registry.error === "string" ? registry.error : typeof registry.warning === "string" ? registry.warning : null);
					if (Array.isArray(registry.workspaces)) setAddedWorkspaces(registry.workspaces);
					if (Array.isArray(registry.removedWorkspaces)) setRemovedWorkspaces(registry.removedWorkspaces);
					if (registry.aliases && typeof registry.aliases === "object") setWorkspaceAliases(registry.aliases);
					if (Array.isArray(registry.archivedSessions)) setArchivedSessionPaths(registry.archivedSessions);
					setArchivedAt(registry.archivedAt ?? {});
					if (Array.isArray(registry.pinnedSessions)) setPinnedSessionPaths(registry.pinnedSessions);
				}
				setSessions(
					page.map((s) => ({ ...s, streaming: running[s.path]?.streaming === true, lastStep: running[s.path]?.lastStep })),
				);
			} catch (error) {
				if (alive && !(error instanceof DOMException && error.name === "AbortError")) {
					setSessionListError(error instanceof Error ? error.message : "session list request failed");
					// 会话列表没拿到（也就没拿到 registry）：单独兜底拉一次工作区，侧栏不至于空着
					void refreshWorkspacesFallback();
				}
			} finally {
				if (alive) setSessionsLoadingMore(false);
				controller = undefined;
				schedule();
			}
		};
		const onVisibilityChange = () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			controller?.abort();
			if (document.visibilityState === "visible") void load(false);
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		void load(true);
		return () => {
			alive = false;
			if (timer) clearTimeout(timer);
			controller?.abort();
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [sessionListRetryNonce, refreshWorkspacesFallback, sessionSearch, sessionPageLimit]);

	// 模型目录
	const modelRequestRef = useRef(0);
	const pendingModelRequest = useRef<{
		key: string;
		controller: AbortController;
		promise: Promise<{ success: boolean; error?: string }>;
	} | null>(null);
	const modelCwdRef = useRef(modelCwd);
	modelCwdRef.current = modelCwd;
	const resolveModelCwd = useCallback(() => {
		const path = currentPathRef.current;
		if (!path) return modelCwdRef.current;
		const key = pathKey(path);
		if (deletedPathsRef.current.has(key)) return "";
		return sessionsRef.current.find((s) => pathKey(s.path) === key)?.cwd
			|| sessionCwdByPathRef.current.get(key)
			|| modelCwdRef.current
			|| "";
	}, []);
	const refreshModels = useCallback(async ({ reusePending = false }: { reusePending?: boolean } = {}) => {
		if (activeSessionRef.current !== currentId) return { success: false, error: "会话已切换，请重新刷新模型目录。" };
		const cwd = resolveModelCwd();
		const key = JSON.stringify([currentId, cwd]);
		const previous = pendingModelRequest.current;
		// Initial selection and its SSE snapshot need the same catalog. Explicit
		// saves/resources changes still replace a request that may predate them.
		if (reusePending && previous?.key === key && !previous.controller.signal.aborted) return previous.promise;
		pendingModelRequest.current = null;
		previous?.controller.abort();
		const controller = new AbortController();
		const request = ++modelRequestRef.current;
		const promise = (async () => {
			try {
				const r = await fetch(`/api/models${currentId ? `?session=${encodeURIComponent(currentId)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}` : cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, { signal: controller.signal });
				const j = await r.json();
				if (controller.signal.aborted || activeSessionRef.current !== currentId || request !== modelRequestRef.current) return { success: false, error: "模型目录已重新刷新，请使用当前列表。" };
				if (!r.ok || !j.success) throw new Error(j.error || `Model catalog request failed (${r.status})`);
				setModels({ providers: j.data.providers, models: j.data.models });
				return { success: true };
			} catch (error) {
				if (controller.signal.aborted) return { success: false, error: "模型目录已重新刷新，请使用当前列表。" };
				const message = error instanceof Error ? error.message : "模型目录刷新失败，请重试。";
				if (activeSessionRef.current === currentId && request === modelRequestRef.current) setState((current) => ({ ...current, error: message }));
				return { success: false, error: message };
			} finally {
				if (pendingModelRequest.current?.controller === controller) pendingModelRequest.current = null;
			}
		})();
		pendingModelRequest.current = { key, controller, promise };
		return promise;
	}, [currentId, resolveModelCwd]);
	useEffect(() => {
		setModels(null);
		void refreshModels({ reusePending: true });
		return () => {
			modelRequestRef.current += 1;
			const pending = pendingModelRequest.current;
			pendingModelRequest.current = null;
			pending?.controller.abort();
		};
	}, [refreshModels, modelCwd]);

	// SSE 订阅当前会话（resyncNonce 变化时强制重连取新快照）
	useEffect(() => {
		esRef.current?.close();
		esRef.current = null;
		if (!currentId) {
			subscribedSessionRef.current = null;
			setState(emptyState());
			return;
		}
		const reconnectingCurrentSession = subscribedSessionRef.current === currentId;
		subscribedSessionRef.current = currentId;
		const pendingOpt = reconnectingCurrentSession ? undefined : pendingOptimisticRef.current.get(currentId);
		setState((current) => reconnectingCurrentSession
			? { ...current, connected: false }
			: {
				...emptyState(),
				...(pendingOpt ? { messages: [pendingOpt.message] } : {}),
				connected: false,
			});
		let retryDelayMs = 2000;
		let lastFrameAt = Date.now();
		let disposed = false;
		const eventsUrl = `/api/agent/${currentId}/events`;
		// 同一次重载既有 external_reload 事件、又会出现在随后若干快照里：按重载时间只提示一次
		const reloadNotice = (reload?: { entries: number; at: number }): PiWebNotice | null => {
			if (!reload) return null;
			const key = `${currentId}:${reload.at}`;
			if (shownReloadsRef.current.has(key)) return null;
			shownReloadsRef.current.add(key);
			return { id: `external-reload-${reload.at}`, message: "", type: "info", ts: Date.now(), code: "external_reload", count: reload.entries };
		};
		const connect = () => {
			if (disposed) return;
			lastFrameAt = Date.now();
			// 流式事件按帧合并：token 速率再高也只每 16ms 渲染一次（见 event-batcher）
			const batcher = createEventBatcher<WebEvent>({
				flush: (events) => setState((s) => {
					const next = foldPiWebEvents(s, events);
					const pendingThinking = pendingThinkingRef.current.get(currentId);
					if (pendingThinking && !pendingThinking.settled && next.snapshot) {
						const preserved = next.snapshot.thinkingLevels?.length
							? clampThinkingLevelTo(next.snapshot.thinkingLevels, pendingThinking.level)
							: pendingThinking.level;
						if (next.snapshot.thinkingLevel !== preserved) {
							return { ...next, snapshot: { ...next.snapshot, thinkingLevel: preserved } };
						}
					}
					return next;
				}),
			});
			batcherRef.current = batcher;
			const onOpen = () => {
				if (disposed) return;
				lastFrameAt = Date.now();
				retryDelayMs = 2000;
				setState((s) => ({ ...s, connected: true }));
			};
			const onMessage = (data: string, eventId?: string) => {
				if (disposed || activeSessionRef.current !== currentId) return;
				lastFrameAt = Date.now();
				let eventEpoch: string | undefined;
				let eventSeq: number | undefined;
				if (typeof eventId === "string" && eventId) {
					const dot = eventId.lastIndexOf(".");
					if (dot > 0) {
						const parsedSeq = Number(eventId.slice(dot + 1));
						if (Number.isSafeInteger(parsedSeq)) {
							eventEpoch = eventId.slice(0, dot);
							eventSeq = parsedSeq;
						}
					}
				}
				if (eventSeq !== undefined) {
					const prevSeq = lastSessionSeqRef.current.get(currentId);
					if (!prevSeq || prevSeq.epoch !== eventEpoch || eventSeq > prevSeq.seq) {
						lastSessionSeqRef.current.set(currentId, { epoch: eventEpoch, seq: eventSeq });
					}
				}
				let parsed: any;
				try {
					parsed = JSON.parse(data);
				} catch {
					// 单帧损坏（代理截断等）只丢弃该帧，不能让 EventSource 回调抛异常
					return;
				}
				if (parsed.type === "external_reload") {
					// 服务端发现终端写过这个会话、已从磁盘重载，旧流随即关闭：不等 EventSource 2 秒后自己重连，马上换新连接拿快照
					const notice = reloadNotice(parsed);
					if (notice) setState((s) => ({ ...s, extensionNotices: [...s.extensionNotices.slice(-4), notice] }));
					setResyncNonce((n) => n + 1);
					return;
				}
				if (parsed.type === "resync") {
					// 扩展换了会话分支（ctx.navigateTree）：眼前的消息列表已过时，重连拿新快照
					setResyncNonce((n) => n + 1);
					return;
				}
				if (parsed.type === "session_navigate") {
					// 扩展命令换了会话（ctx.newSession / fork / switchSession）：浏览器跟着打开目标会话
					const target = typeof parsed.sessionPath === "string" ? parsed.sessionPath : "";
					if (target) openSessionRef.current?.(target);
					return;
				}
				if (parsed.type === "snapshot" && parsed.snapshot) {
					void refreshModels({ reusePending: true });
					// 快照是权威状态：之前缓冲的增量已经过时，直接丢弃
					batcher.cancel();
					retryDelayMs = 2000;
					const receivedMessages = Array.isArray(parsed.snapshot.messages) ? parsed.snapshot.messages.map((message: WebMessage) => previewMessage(message)) : [];
					// 聊天窗口保留完整历史（不再按窗口截断）；单条体积仍受 previewMessage 限制。
					let snap = { ...parsed.snapshot, sessionPath: parsed.snapshot.sessionPath ?? currentPath, messages: receivedMessages, trajectory: recentTrajectory(Array.isArray(parsed.snapshot.trajectory) ? parsed.snapshot.trajectory : []) } as WebSnapshot;
					if (typeof snap.seq === "number") {
						const prevSeq = lastSessionSeqRef.current.get(currentId);
						if (!prevSeq || (eventEpoch && prevSeq.epoch !== eventEpoch) || snap.seq > prevSeq.seq) {
							lastSessionSeqRef.current.set(currentId, { epoch: eventEpoch ?? prevSeq?.epoch, seq: snap.seq });
						}
					}
					const pendingThinking = pendingThinkingRef.current.get(currentId);
					if (pendingThinking) {
						const snapSeqNum = typeof snap.seq === "number" ? snap.seq : undefined;
						const staleSnapshot = !pendingThinking.settled
							|| (snapSeqNum !== undefined && pendingThinking.seqAtDispatch !== undefined && snapSeqNum <= pendingThinking.seqAtDispatch)
							|| (pendingThinking.settled && snap.thinkingLevel !== pendingThinking.level && typeof pendingThinking.settledAt === "number" && Date.now() - pendingThinking.settledAt < 2000);
						if (staleSnapshot) {
							pendingThinking.previousLevel = snap.thinkingLevel;
							const preservedLevel = snap.thinkingLevels?.length ? clampThinkingLevelTo(snap.thinkingLevels, pendingThinking.level) : pendingThinking.level;
							snap = { ...snap, thinkingLevel: preservedLevel };
						} else {
							pendingThinkingRef.current.delete(currentId);
						}
					}
					const pendingOpt = pendingOptimisticRef.current.get(currentId);
					let nextMessages = snap.messages;
					if (pendingOpt) {
						if (snapshotContainsOptimisticPrompt(snap.messages, pendingOpt)) {
							pendingOptimisticRef.current.delete(currentId);
						} else {
							nextMessages = [...snap.messages, pendingOpt.message];
						}
					}
					const notice = reloadNotice(snap.externalReload);
					setState((prev) => ({
						snapshot: snap,
						messages: nextMessages,
						tools: toolsFromMessages(nextMessages, snap.isStreaming),
						connected: true,
						error: null,
						compaction: typeof snap.compactionStartedAt === "number" ? { phase: "start", ts: snap.compactionStartedAt } : null,
						retryNotice: null,
						// 服务器当前 pending 集合是权威来源，刷新可恢复、已答请求不能复活。
						extensionDialogs: extensionDialogsFromSnapshot(snap, prev.extensionDialogs),
						extensionNotices: notice ? [...prev.extensionNotices.slice(-4), notice] : prev.extensionNotices,
						extensionStatuses: snap.extensionStatuses ?? {},
						extensionWidgets: snap.extensionWidgets ?? {},
						extensionTitle: snap.extensionTitle?.trim() ? snap.extensionTitle : null,
						// 输入框内容属于浏览器：快照不重置它，setEditorText 按 id 只放一次
						editorText: prev.editorText,
						workingMessage: null,
						// 重连的快照不带生长账本；连接期间已收到的步保留，useGrowth 会按 seq 与拉取结果去重
						growth: { ...prev.growth, error: snap.growthError ?? null },
					}));
				} else {
					if (parsed.type === "message" && parsed.message?.role === "user") {
						pendingOptimisticRef.current.delete(currentId);
					}
					let eventForBatch = parsed as WebEvent;
					if (parsed.type === "resources" || parsed.type === "model") void refreshModels();
					if (parsed.type === "model") {
						const pendingThinking = pendingThinkingRef.current.get(currentId);
						if (pendingThinking) {
							const levels = Array.isArray(parsed.thinkingLevels) ? parsed.thinkingLevels : liveStateRef.current.snapshot?.thinkingLevels;
							const preserved = levels?.length ? clampThinkingLevelTo(levels, pendingThinking.level) : pendingThinking.level;
							if (!pendingThinking.settled) {
								if (typeof parsed.thinkingLevel === "string") pendingThinking.previousLevel = parsed.thinkingLevel;
								eventForBatch = { ...parsed, thinkingLevel: preserved } as WebEvent;
							} else if (parsed.thinkingLevel === pendingThinking.level) {
								pendingThinkingRef.current.delete(currentId);
							} else if (eventSeq !== undefined && pendingThinking.seqAtDispatch !== undefined && eventSeq <= pendingThinking.seqAtDispatch) {
								eventForBatch = { ...parsed, thinkingLevel: preserved } as WebEvent;
							} else {
								pendingThinkingRef.current.delete(currentId);
							}
						}
					}
					batcher.push(eventForBatch);
				}
			};
			// Cloudflare 快速隧道不支持 SSE（流被攒成 128KB 一块，快照永远收不全）：改用长轮询，
			// 失败退避、Last-Event-ID 续传都在 pollEventStream 里
			if (usesEventPolling(window.location.hostname)) {
				esRef.current = pollEventStream(eventsUrl, {
					onOpen,
					onMessage,
					onError: () => setState((s) => ({ ...s, connected: false })),
					// 空闲时每次轮询 25 秒后空着返回：也算活着，否则看门狗会反复整份重连
					onPoll: () => { lastFrameAt = Date.now(); },
				});
				return;
			}
			const es = new EventSource(eventsUrl);
			esRef.current = es;
			es.onopen = onOpen;
			es.addEventListener?.("ping", () => { lastFrameAt = Date.now(); });
			es.onerror = () => {
				setState((s) => ({ ...s, connected: false }));
				if (esRef.current !== es) return;
				// 网络断开时浏览器自己会重连，并带上 Last-Event-ID 让服务端从环形缓冲续放
				// （只补漏掉的几条事件）。这时手动重建就等于丢掉续传、每次都拉一份全量快照。
				if (es.readyState !== EventSource.CLOSED) return;
				// 浏览器对非 200 响应会永久放弃自动重连：这里手动兜底，关掉后延迟重建，
				// 重建时会拿到全新快照。
				es.close();
				esRef.current = null;
				const delay = retryDelayMs;
				retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
				retryTimer = setTimeout(() => {
					if (esRef.current === null) connect();
				}, delay);
			};
			es.onmessage = (e) => onMessage(e.data, e.lastEventId);
		};
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		connect();
		const reconnect = () => {
			if (disposed) return;
			setState((s) => ({ ...s, connected: false }));
			batcherRef.current?.cancel();
			esRef.current?.close();
			esRef.current = null;
			clearTimeout(retryTimer);
			connect();
		};
		const watchdog = setInterval(() => { if (Date.now() - lastFrameAt > 45_000) reconnect(); }, 5_000);
		const offline = () => setState((s) => ({ ...s, connected: false }));
		window.addEventListener("online", reconnect);
		window.addEventListener("offline", offline);
		return () => {
			disposed = true;
			clearInterval(watchdog);
			window.removeEventListener("online", reconnect);
			window.removeEventListener("offline", offline);
			batcherRef.current?.cancel();
			batcherRef.current = null;
			if (retryTimer) clearTimeout(retryTimer);
			esRef.current?.close();
			esRef.current = null;
		};
	}, [currentId, resyncNonce, refreshModels]);

	// Hero / 新会话草稿页没有会话 SSE：订阅工作区资源与设置变更流，外部改 .pi/settings.json 等立即同步
	useEffect(() => {
		if (currentId || !modelCwd || typeof window === "undefined") return;
		const polling = usesEventPolling(window.location.hostname);
		if (!polling && typeof EventSource === "undefined") return;
		const url = `/api/agent/resources?cwd=${encodeURIComponent(modelCwd)}&stream=1`;
		let disposed = false;
		let retryDelayMs = 2000;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let stream: { close(): void } | null = null;
		const onMessage = (data: string) => {
			if (disposed || activeSessionRef.current) return;
			let parsed: { type?: string } | null = null;
			try {
				parsed = JSON.parse(data) as { type?: string };
			} catch {
				return;
			}
			if (parsed?.type === "workspace_changed" || parsed?.type === "resources") {
				setWorkspaceRefreshNonce((n) => n + 1);
				void refreshModels();
			}
		};
		const connect = () => {
			if (disposed) return;
			if (polling) {
				stream = pollEventStream(url, {
					onOpen: () => { retryDelayMs = 2000; },
					onMessage,
					onError: () => {},
				});
				return;
			}
			const es = new EventSource(url);
			stream = es;
			es.onopen = () => { retryDelayMs = 2000; };
			es.onmessage = (e) => onMessage(e.data);
			es.onerror = () => {
				if (stream !== es || es.readyState !== EventSource.CLOSED) return;
				es.close();
				stream = null;
				const delay = retryDelayMs;
				retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
				retryTimer = setTimeout(() => {
					if (!disposed && stream === null) connect();
				}, delay);
			};
		};
		connect();
		return () => {
			disposed = true;
			if (retryTimer) clearTimeout(retryTimer);
			stream?.close();
			stream = null;
		};
	}, [currentId, modelCwd, refreshModels]);

	const sendCommand = useCallback(async (cmd: Record<string, unknown>, id?: string, options?: { shouldReportError?: () => boolean }): Promise<any> => {
		const target = id ?? currentId;
		if (!target) {
			setState((s) => ({ ...s, error: "no session" }));
			return { success: false, error: "no session" };
		}
		const isPrompt = cmd.cmd === "prompt" || cmd.cmd === "sendQueueNow";
		const isModelOp = cmd.cmd === "setThinkingLevel" || cmd.cmd === "setModel" || cmd.cmd === "cycleModel";
		const needsModelOrder = isModelOp || isPrompt || cmd.cmd === "steer" || cmd.cmd === "followUp" || cmd.cmd === "editAndResend";
		// Active-session composer sends show acceptance errors inline in ChatInput; keep state.error for Hero (explicit id) and other commands.
		const reportError = () => options?.shouldReportError ? options.shouldReportError() : !(id === undefined && isPrompt);
		if (isPrompt && promptRequestsRef.current.has(target)) return { success: false, error: "prompt acceptance pending" };
		if (isPrompt) promptRequestsRef.current.add(target);
		let thinkingOp: PendingThinkingSelection | null = null;
		if (cmd.cmd === "setThinkingLevel") {
			if (activeSessionRef.current === target) batcherRef.current?.flush();
			const requested = String(cmd.level ?? "medium");
			const activeSnap = activeSessionRef.current === target ? liveStateRef.current.snapshot : null;
			const previousLevel = pendingThinkingRef.current.get(target)?.previousLevel ?? activeSnap?.thinkingLevel;
			const optimisticLevel = activeSnap?.thinkingLevels?.length ? clampThinkingLevelTo(activeSnap.thinkingLevels, requested) : requested;
			const seqAtDispatch = lastSessionSeqRef.current.get(target)?.seq ?? (typeof activeSnap?.seq === "number" ? activeSnap.seq : undefined);
			thinkingOp = { id: ++thinkingSeqRef.current, level: optimisticLevel, previousLevel, settled: false, seqAtDispatch };
			pendingThinkingRef.current.set(target, thinkingOp);
			if (activeSessionRef.current === target) {
				setState((s) => s.snapshot ? { ...s, snapshot: { ...s.snapshot, thinkingLevel: optimisticLevel } } : s);
			}
		}
		let optimisticId: string | null = null;
		if (cmd.cmd === "prompt" && !cmd.behavior) {
			const rawText = typeof cmd.text === "string" ? cmd.text : "";
			const hasImages = Array.isArray(cmd.images) && cmd.images.length > 0;
			if (rawText.trim() || hasImages) {
				const optId = `${OPTIMISTIC_STREAM_PREFIX}${++optimisticSeqRef.current}`;
				optimisticId = optId;
				const optMsg = buildOptimisticUserMessage(rawText, cmd.images, optId);
				const existingMsgs = activeSessionRef.current === target ? liveStateRef.current.messages : [];
				let anchorId: string | null = null;
				for (let i = existingMsgs.length - 1; i >= 0; i -= 1) {
					const entry = existingMsgs[i];
					if (!isOptimisticUserMessage(entry) && (entry.id || entry.streamId)) {
						anchorId = entry.id ?? entry.streamId ?? null;
						break;
					}
				}
				pendingOptimisticRef.current.set(target, {
					streamId: optId,
					message: optMsg,
					anchorId,
					rawText,
					signature: userMessageSignature(optMsg),
					settled: false,
				});
				if (activeSessionRef.current === target) {
					setState((s) => ({ ...s, messages: [...s.messages, optMsg] }));
				}
			}
		}
		const clearOptimistic = () => {
			if (!optimisticId) return;
			if (pendingOptimisticRef.current.get(target)?.streamId === optimisticId) {
				pendingOptimisticRef.current.delete(target);
			}
			const removedId = optimisticId;
			setState((s) =>
				s.messages.some((m) => m.streamId === removedId)
					? { ...s, messages: s.messages.filter((m) => m.streamId !== removedId) }
					: s,
			);
		};
		const priorModelOp = needsModelOrder ? pendingModelOpsRef.current.get(target) : undefined;
		const requestPromise = (async () => {
			try {
				if (priorModelOp) await priorModelOp.catch(() => undefined);
				const r = await fetch(`/api/agent/${target}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(cmd),
				});
				const result = await r.json();
				if (!r.ok || !result.success) {
					clearOptimistic();
					if (thinkingOp && pendingThinkingRef.current.get(target)?.id === thinkingOp.id) {
						pendingThinkingRef.current.delete(target);
						if (activeSessionRef.current === target) {
							const rollback = thinkingOp.previousLevel;
							setState((s) => s.snapshot ? { ...s, snapshot: { ...s.snapshot, thinkingLevel: rollback } } : s);
						}
					}
					if (reportError()) setState((s) => ({ ...s, error: result.error || `request failed (${r.status})` }));
				} else if (result.data?.command === true) {
					clearOptimistic();
				} else {
					if (optimisticId) {
						const pending = pendingOptimisticRef.current.get(target);
						if (pending?.streamId === optimisticId) pending.settled = true;
					}
					if (thinkingOp && pendingThinkingRef.current.get(target)?.id === thinkingOp.id) {
						const confirmed = typeof result.data?.thinkingLevel === "string" ? result.data.thinkingLevel : thinkingOp.level;
						thinkingOp.level = confirmed;
						thinkingOp.settled = true;
						thinkingOp.settledAt = Date.now();
						if (activeSessionRef.current === target) {
							setState((s) => s.snapshot ? { ...s, snapshot: { ...s.snapshot, thinkingLevel: confirmed } } : s);
						}
					} else if ((cmd.cmd === "setModel" || cmd.cmd === "cycleModel") && typeof result.data?.thinkingLevel === "string") {
						const pending = pendingThinkingRef.current.get(target);
						if (pending && pending.settled) pending.level = result.data.thinkingLevel;
						if (activeSessionRef.current === target) {
							setState((s) => s.snapshot ? { ...s, snapshot: { ...s.snapshot, thinkingLevel: result.data.thinkingLevel } } : s);
						}
					}
				}
				return result;
			} catch (error) {
				clearOptimistic();
				if (thinkingOp && pendingThinkingRef.current.get(target)?.id === thinkingOp.id) {
					pendingThinkingRef.current.delete(target);
					if (activeSessionRef.current === target) {
						const rollback = thinkingOp.previousLevel;
						setState((s) => s.snapshot ? { ...s, snapshot: { ...s.snapshot, thinkingLevel: rollback } } : s);
					}
				}
				const message = error instanceof Error ? error.message : "request failed";
				if (reportError()) setState((s) => ({ ...s, error: message }));
				return { success: false, error: message };
			} finally {
				if (isPrompt) promptRequestsRef.current.delete(target);
			}
		})();
		if (isModelOp) {
			const tracked = requestPromise.finally(() => {
				if (pendingModelOpsRef.current.get(target) === tracked) pendingModelOpsRef.current.delete(target);
			});
			pendingModelOpsRef.current.set(target, tracked);
		}
		return requestPromise;
	}, [currentId]);

	const newSession = useCallback(async (
		cwd: string,
		overrides: { provider?: string; modelId?: string; thinking?: string } = {},
	): Promise<string | null> => {
		try {
			const r = await fetch("/api/agent/new", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd, ...overrides }),
			});
			const j = await r.json();
			if (j.success) {
				const p = j.data.sessionPath as string;
				const id = idOf(p);
				// 新服务在创建时一次应用预设；旧服务没有确认字段时仍走逐条配置。
				const setup: Record<string, unknown>[] = [];
				if (j.data.setupApplied !== true && overrides.provider && overrides.modelId) setup.push({ cmd: "setModel", provider: overrides.provider, modelId: overrides.modelId, fresh: true });
				if (j.data.setupApplied !== true && overrides.thinking) setup.push({ cmd: "setThinkingLevel", level: overrides.thinking });
				for (const command of setup) {
					const configured = await sendCommand(command, id);
					if (!configured.success) {
						// 思考级别与模型不兼容（如非推理模型只支持 off）时降级跳过，
						// 不能因此删掉整个会话让用户毫无提示。
						if (command.cmd === "setThinkingLevel") continue;
						await fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
						return null;
					}
				}
				const key = pathKey(p);
				deletedPathsRef.current.delete(key);
				sessionCwdByPathRef.current.set(key, cwd);
				setPendingSession({ path: p, cwd });
				modelCwdRef.current = cwd;
				setModelCwd(cwd);
				setCurrentPath(p);
				setCurrentId(id);
				try {
					storeSessionLocation(p);
				} catch {
					/* ignore */
				}
				return p;
			}
			setState((s) => ({ ...s, error: j.error || "failed to create session" }));
			return null;
		} catch (error) {
			setState((s) => ({ ...s, error: error instanceof Error ? error.message : "failed to create session" }));
			return null;
		}
	}, [idOf, sendCommand]);

	const openSession = useCallback(
		(path: string, cwd?: string) => {
			const key = pathKey(path);
			deletedPathsRef.current.delete(key);
			if (cwd) sessionCwdByPathRef.current.set(key, cwd);
			const resolvedCwd = cwd || sessionsRef.current.find((s) => pathKey(s.path) === key)?.cwd || sessionCwdByPathRef.current.get(key) || "";
			modelCwdRef.current = resolvedCwd;
			setModelCwd(resolvedCwd);
			setCurrentPath(path);
			setCurrentId(idOf(path));
			// 持久化当前会话：刷新页面时恢复到这里，而不是回到新会话草稿
			try {
				storeSessionLocation(path);
			} catch {
				/* ignore */
			}
		},
		[idOf],
	);
	// 扩展命令换会话时由 SSE 处理器调用：它在这个 useCallback 之前定义，只能经 ref 拿
	openSessionRef.current = openSession;

	const closeSession = useCallback(() => {
		setCurrentId(null);
		setCurrentPath(null);
		try {
			storeSessionLocation(null);
		} catch {
			/* ignore */
		}
	}, []);

	// 直接恢复地址中的会话；服务端校验路径，不能以侧栏第一页决定是否存在。
	const restoredRef = useRef(false);
	useEffect(() => {
		if (restoredRef.current) return;
		restoredRef.current = true;
		try {
			const saved = savedSessionLocation();
			if (saved) {
				try { sessionStorage.setItem("piweb.sessionRestored", "1"); } catch { /* optional UI preference */ }
				openSession(saved);
			}
		} catch {
			/* ignore */
		}
	}, [openSession]);
	useEffect(() => {
		const navigate = () => {
			const path = savedSessionLocation(false);
			storeSessionLocation(path, false);
			setCurrentPath(path); setCurrentId(path ? idOf(path) : null);
		};
		window.addEventListener("popstate", navigate);
		return () => window.removeEventListener("popstate", navigate);
	}, [idOf]);

	// ---------- 模型与思考级别由 Hero 页显式下发 ----------

	/** 强制重连 SSE 拿新快照（navigate 等场景） */
	const resync = useCallback(() => setResyncNonce((n) => n + 1), []);
	/** 应答扩展对话框（select/confirm/input）或选择窗口（questions）；cancelled=true 表示用户关掉了 / 跳过 */
	const answerExtensionDialog = useCallback(
		async (id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
			setState((s) => ({ ...s, extensionDialogs: s.extensionDialogs.filter((d) => d.id !== id) }));
			const target = currentId;
			const result = await sendCommand({ cmd: "extensionUiResponse", requestId: id, ...response });
			if (!result?.success && activeSessionRef.current === target) resync();
		},
		[currentId, resync, sendCommand],
	);
	const dismissExtensionNotice = useCallback((id: string) => setState((s) => ({ ...s, extensionNotices: s.extensionNotices.filter((n) => n.id !== id) })), []);
	const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);
	/** 供 AppShell 直接展示行内提示（如未选工作区就发送） */
	const setError = useCallback((message: string) => setState((s) => ({ ...s, error: message })), []);

	// 会话可见性规则：归档即离开工作区列表——包括当前会话（归档后切到相邻会话或空态），
	// 归档区显示全部已归档会话。
	const visibleSessions = useMemo(() => {
		const set = new Set(archivedSessionPaths.map(pathKey));
		return sessions.filter((s) => !set.has(pathKey(s.path)));
	}, [sessions, archivedSessionPaths]);
	const archivedSessions = useMemo(() => {
		const set = new Set(archivedSessionPaths.map(pathKey));
		return sortArchivedSessions(
			sessions.filter((s) => set.has(pathKey(s.path))),
			archivedAt,
			archivedSessionPaths,
		);
	}, [sessions, archivedSessionPaths, archivedAt]);

	// 无限滚动：滚到聊天顶部时自动加载上一页更早的记录（替代原来的“查看更早的聊天记录”按钮）。
	const loadEarlierMessages = useCallback(async () => {
		const sessionId = currentId;
		const omitted = stateRef.current.snapshot?.history?.omitted ?? 0;
		if (!sessionId || omitted <= 0 || loadingEarlierRef.current) return;
		loadingEarlierRef.current = true;
		setLoadingEarlier(true);
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/history?before=${omitted}`);
			if (!response.ok) return;
			const body = (await response.json()) as { success?: boolean; data?: { messages?: WebMessage[]; total?: number; olderBefore?: number } };
			const page = body.success ? body.data : undefined;
			if (!page || !Array.isArray(page.messages)) return;
			setState((previous) => {
				if (activeSessionRef.current !== sessionId || !previous.snapshot) return previous;
				const seen = new Set(previous.messages.map((message) => message.id).filter((id): id is string => typeof id === "string"));
				const older = page.messages!.filter((message) => !message.id || !seen.has(message.id));
				const history = { total: page.total ?? previous.snapshot.history?.total ?? 0, omitted: page.olderBefore ?? 0 };
				if (!older.length) return { ...previous, snapshot: { ...previous.snapshot, history } };
				const messages = [...older, ...previous.messages];
				// 历史页同样恢复工具图片；跨分页边界的调用/结果一起关联，当前实时状态优先。
				const tools = { ...toolsFromMessages(messages, previous.snapshot.isStreaming), ...previous.tools };
				return { ...previous, messages, tools, snapshot: { ...previous.snapshot, history } };
			});
		} catch {
			// 加载失败保留当前视图；下一次滚到顶部会重试。
		} finally {
			loadingEarlierRef.current = false;
			setLoadingEarlier(false);
		}
	}, [currentId]);
	useEffect(() => {
		loadingEarlierRef.current = false;
		setLoadingEarlier(false);
	}, [currentId]);

	return {
		sessions: sessionSearch ? sessions : visibleSessions,
		searchSessions,
		loadMoreSessions,
		hasMoreSessions,
		sessionsLoadingMore,
		sessionListError,
		workspaceRegistryWarning: [
			workspaceRegistryWarning,
			sessionDeletionWarning && (sessionDeletionWarning.code === "SESSION_DELETE_PARTIAL" ? t.deleteSessionPartialWarning : sessionDeletionWarning.message),
		].filter(Boolean).join("\n") || null,
		retrySessionList,
		archivedSessions,
		/** 原始归档路径列表（含被豁免的当前会话，供菜单显示真实归档态） */
		archivedSessionPaths,
		archivedAt,
		pinnedSessionPaths,
		currentId,
		currentPath,
		state,
		hasEarlier: (state.snapshot?.history?.omitted ?? 0) > 0,
		loadingEarlier,
		loadEarlierMessages,
		models,
		addedWorkspaces,
		removedWorkspaces,
		workspaceAliases,
		getWorkspaceName,
		renameWorkspace,
		patchSessionName,
		archiveSession,
		unarchiveSession,
		pinSession,
		unpinSession,
		deleteSession,
		resync,
		groupBy,
		orderBy,
		setGroupBy,
		setOrderBy,
		addWorkspaceByPicker,
		dirPickerOpen,
		confirmDirPicker,
		cancelDirPicker,
		removeWorkspace,
		refreshModels,
		setModelCwd,
		workspaceRefreshNonce,
		pendingSessionCwd: pendingSession && currentPath && pathKey(pendingSession.path) === pathKey(currentPath) ? pendingSession.cwd : "",
		sendCommand,
		newSession,
		openSession,
		closeSession,
		clearError,
		clearCompaction,
		setError,
		answerExtensionDialog,
		dismissExtensionNotice,
	};
}
