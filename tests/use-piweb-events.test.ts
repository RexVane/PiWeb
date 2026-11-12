import { describe, expect, it } from "vitest";
import { extensionDialogsFromSnapshot, foldPiWebEvent, type PiWebState } from "../src/hooks/usePiWeb";
import type { WebMessage, WebSnapshot } from "../src/lib/types";

describe("PiWeb SSE event folding", () => {
	it("keeps compaction progress and failure visible in session state", () => {
		const initial = { compaction: null } as PiWebState;
		const started = foldPiWebEvent(initial, { type: "compaction", phase: "start", ts: 1 });
		expect(started.compaction).toEqual({ phase: "start", errorMessage: undefined, ts: 1 });
		expect(initial.compaction).toBeNull();
		const ended = foldPiWebEvent(started, { type: "compaction", phase: "end", errorMessage: "context limit", ts: 2 });
		expect(ended.compaction).toEqual({ phase: "end", errorMessage: "context limit", ts: 2 });
	});

	it("inserts the compaction divider before the first kept message and keeps everything above", () => {
		// 压缩后被压缩的上下文不能消失：已显示的消息全保留，卡片插在保留的第一条前面，和刷新后的快照一致
		const text = (value: string) => [{ type: "text" as const, text: value }];
		const messages: WebMessage[] = [
			{ role: "user", id: "u1", content: text("q1") },
			{ role: "assistant", id: "a1", content: text("a1"), stopReason: "stop" },
			{ role: "user", id: "u2", streamId: "stream-u2", content: text("q2") },
			{ role: "assistant", id: "a2", content: text("a2"), stopReason: "stop" },
		];
		const marker: WebMessage = { role: "summary", id: "c1", summaryKind: "compaction", summary: "摘要", tokensBefore: 100, content: [] };
		const initial = { messages, compaction: null } as unknown as PiWebState;
		const ids = (state: PiWebState) => state.messages.map((message) => message.id);

		const next = foldPiWebEvent(initial, { type: "compaction", phase: "end", marker, beforeId: "u2", ts: 5 });
		expect(ids(next)).toEqual(["u1", "a1", "c1", "u2", "a2"]);
		expect(next.compaction).toEqual({ phase: "end", errorMessage: undefined, ts: 5 });
		expect(initial.messages).toBe(messages);
		// 重复收到同一事件（重连补发）不重复插卡
		expect(ids(foldPiWebEvent(next, { type: "compaction", phase: "end", marker, beforeId: "u2", ts: 6 }))).toEqual(["u1", "a1", "c1", "u2", "a2"]);
		// 持久 ID 还没回来时按流 ID 定位
		expect(ids(foldPiWebEvent(initial, { type: "compaction", phase: "end", marker, beforeStreamId: "stream-u2", ts: 5 }))).toEqual(["u1", "a1", "c1", "u2", "a2"]);
		// 找不到保留消息就追加到末尾，不丢卡片
		expect(ids(foldPiWebEvent(initial, { type: "compaction", phase: "end", marker, beforeId: "missing", ts: 5 }))).toEqual(["u1", "a1", "u2", "a2", "c1"]);
	});

	it("updates a final already in the snapshot without duplicating it or losing the delayed end", () => {
		const before: WebMessage = { role: "assistant", streamId: "run-1", content: [{ type: "text", text: "before hook" }], stopReason: "stop" };
		const initial = { messages: [before] } as PiWebState;
		const end: WebMessage = { ...before, id: "entry-1", content: [{ type: "text", text: "after hook" }], endedAt: 8 };
		const next = foldPiWebEvent(initial, { type: "message", phase: "end", message: end, ts: 8 });
		expect(next.messages).toEqual([end]);
		expect(initial.messages).toEqual([before]);
		expect(foldPiWebEvent(next, { type: "message", phase: "end", message: end, ts: 8 }).messages).toEqual([end]);
	});

	it("retains distinct same-timestamp users and handles old end events without replacing new messages", () => {
		const first: WebMessage = { role: "user", streamId: "user-a", timestamp: 1, content: [{ type: "text", text: "a" }] };
		const second: WebMessage = { role: "user", streamId: "user-b", timestamp: 1, content: [{ type: "text", text: "b" }] };
		let state = { messages: [] } as unknown as PiWebState;
		for (const message of [first, second]) state = foldPiWebEvent(state, { type: "message", phase: "start", message, ts: 1 });
		state = foldPiWebEvent(state, { type: "message", phase: "end", message: { ...first, id: "entry-a" }, ts: 2 });
		expect(state.messages).toEqual([{ ...first, id: "entry-a" }, second]);
	});

	it("targets deltas by stream ID and does not append a duplicate partial after final", () => {
		let state = { messages: [{ role: "assistant", streamId: "a", stopReason: "pending", content: [] }] } as unknown as PiWebState;
		state = foldPiWebEvent(state, { type: "delta", messageId: "a", kind: "text", contentIndex: 0, delta: "hello", ts: 1 });
		expect(state.messages[0].content).toEqual([{ type: "text", text: "hello" }]);
		state = foldPiWebEvent(state, { type: "message", phase: "end", message: { ...state.messages[0], stopReason: "stop" }, ts: 2 });
		expect(foldPiWebEvent(state, { type: "delta", messageId: "a", kind: "text", contentIndex: 0, delta: "late", ts: 3 }).messages).toEqual(state.messages);
	});

	it("preserves completed history when a new end arrives without a start on the legacy protocol", () => {
		const old: WebMessage = { role: "assistant", id: "old", stopReason: "stop", content: [{ type: "text", text: "old" }] };
		const fresh: WebMessage = { role: "assistant", id: "new", stopReason: "stop", content: [{ type: "text", text: "new" }] };
		const state = { messages: [old] } as PiWebState;
		expect(foldPiWebEvent(state, { type: "message", phase: "end", message: fresh, ts: 3 }).messages).toEqual([old, fresh]);
	});

	it("uses the authoritative pending snapshot and deduplicates/resolves UI events", () => {
		const request = { type: "extension_ui", id: "ask", method: "confirm", title: "Confirm", ts: 1 } as const;
		const dialogs = extensionDialogsFromSnapshot({ extensionUiRequests: [request] } as WebSnapshot);
		expect(dialogs).toHaveLength(1);
		let state = { extensionDialogs: dialogs } as PiWebState;
		state = foldPiWebEvent(state, request);
		expect(state.extensionDialogs).toHaveLength(1);
		state = foldPiWebEvent(state, { type: "extension_ui_resolved", id: "ask", ts: 2 });
		expect(state.extensionDialogs).toEqual([]);
		expect(extensionDialogsFromSnapshot({ extensionUiRequests: [] } as unknown as WebSnapshot, dialogs)).toEqual([]);
	});

	it("keeps pi's question window from events and snapshots, questions included", () => {
		// 选择窗口和扩展对话框走同一条桥：实时事件和刷新后的快照都要带出题目
		const questions = [{ question: "Which DB?", header: "DB", options: [{ label: "Postgres", description: "solid" }, { label: "SQLite" }] }];
		const request = { type: "extension_ui", id: "q1", method: "questions", title: "", questions, ts: 1 } as const;
		let state = { extensionDialogs: [] } as unknown as PiWebState;
		state = foldPiWebEvent(state, request);
		expect(state.extensionDialogs).toEqual([expect.objectContaining({ id: "q1", method: "questions", questions })]);
		expect(extensionDialogsFromSnapshot({ extensionUiRequests: [request] } as unknown as WebSnapshot)).toEqual([expect.objectContaining({ id: "q1", method: "questions", questions })]);
		state = foldPiWebEvent(state, { type: "extension_ui_resolved", id: "q1", ts: 2 });
		expect(state.extensionDialogs).toEqual([]);
	});

	it("终端在回合中途写会话：提示一条警告，重复发现只留最新一条", () => {
		let state = { extensionNotices: [{ id: "ext", message: "扩展通知", type: "info", ts: 1 }] } as PiWebState;
		state = foldPiWebEvent(state, { type: "external_write", entries: 1, ts: 2 });
		state = foldPiWebEvent(state, { type: "external_write", entries: 3, ts: 3 });
		expect(state.extensionNotices).toEqual([
			{ id: "ext", message: "扩展通知", type: "info", ts: 1 },
			{ id: "external-write-3", message: "", type: "warning", ts: 3, code: "external_write", count: 3 },
		]);
	});

	it("retains retry notice while busy and clears it only on the settled idle status", () => {
		const initial = { snapshot: { isStreaming: true }, retryNotice: "自动重试 1/3", workingMessage: "working" } as PiWebState;
		const busy = foldPiWebEvent(initial, { type: "status", isStreaming: true, state: "compacting", ts: 2 });
		expect(busy.retryNotice).toBe("自动重试 1/3");
		const settled = foldPiWebEvent(busy, { type: "status", isStreaming: false, state: "idle", ts: 3 });
		expect(settled.retryNotice).toBeNull();
		expect(settled.snapshot?.isStreaming).toBe(false);
	});

	it("aggregates auto-retries into one counter row instead of one error per attempt", () => {
		const initial = { snapshot: { isStreaming: true }, retryNotice: null, error: null } as unknown as PiWebState;
		const first = foldPiWebEvent(initial, { type: "retry", attempt: 1, maxAttempts: 5, message: "429 rate limit", ts: 1 });
		expect(first.retryNotice).toBe("重试 1/5：429 rate limit");
		// 每条重试都替换上一条：界面上始终只有一行，且不会落到 6 秒错误条
		const third = foldPiWebEvent(first, { type: "retry", attempt: 3, maxAttempts: 5, message: "429 rate limit", ts: 2 });
		expect(third.retryNotice).toBe("重试 3/5：429 rate limit");
		expect(third.error).toBeNull();
		// 旧服务端把重试塞在 error 里：同样按通知处理
		const legacy = foldPiWebEvent(initial, { type: "error", message: "自动重试 2/5：boom", ts: 3 });
		expect(legacy.retryNotice).toBe("自动重试 2/5：boom");
		expect(legacy.error).toBeNull();
		const real = foldPiWebEvent(initial, { type: "error", message: "No API key for X", ts: 4 });
		expect(real.error).toBe("No API key for X");
	});

	it("clears the retry notice when the retry interval ends, without waiting for the next idle status", () => {
		// 回归:重试成功后 SDK 发 auto_retry_end(success:true),而下一轮 agent 开始前
		// 不会再发一条 isStreaming:false 的 status —— 只等 agent_settled 会让
		// 「重试 1/5 terminated」一直挂在对话末尾(用户看到的"已经恢复了,但是还显示错误")。
		const initial = { snapshot: { isStreaming: true }, retryNotice: null, error: null } as unknown as PiWebState;
		const retrying = foldPiWebEvent(initial, { type: "retry", attempt: 1, maxAttempts: 5, message: "terminated", ts: 1 });
		expect(retrying.retryNotice).toMatch(/^重试 1\/5.terminated$/);
		const ended = foldPiWebEvent(retrying, { type: "retry_end", attempt: 1, ts: 2 });
		expect(ended.retryNotice).toBeNull();
		// 收掉重试行不能顺手抹掉真正的错误
		const withError = foldPiWebEvent({ ...retrying, error: "boom" } as PiWebState, { type: "retry_end", attempt: 1, ts: 3 });
		expect(withError.error).toBe("boom");
	});

	it("also clears the retry notice as soon as tokens stream again (no retry_end needed)", () => {
		// 保险丝：旧版 PiWeb 不发 retry_end，SDK 也可能换事件名。只要模型又开始出 token，
		// 重试行就必须收掉——用户已经两次看到「模型正常输出了，界面还挂着重试 1/5」。
		const initial = { snapshot: { isStreaming: true }, messages: [], retryNotice: null, error: null } as unknown as PiWebState;
		const retrying = foldPiWebEvent(initial, { type: "retry", attempt: 1, maxAttempts: 5, message: "ECONNRESET", ts: 1 });
		expect(retrying.retryNotice).toMatch(/^重试 1\/5/);
		const streaming = foldPiWebEvent(retrying, { type: "delta", kind: "text", delta: "接着写", ts: 2 } as never);
		expect(streaming.retryNotice).toBeNull();
	});
});

describe("扩展面与 ! 命令的事件折叠", () => {
	const base = (overrides: Partial<PiWebState> = {}): PiWebState => ({
		snapshot: null, messages: [], tools: {}, toolPreset: "standard", connected: true, error: null, compaction: null, retryNotice: null,
		extensionDialogs: [], extensionNotices: [], extensionStatuses: {}, extensionWidgets: {}, extensionTitle: null, editorText: null,
		workingMessage: null, growth: { rounds: [], error: null, consent: null },
		...overrides,
	});
	const pending: WebMessage = { role: "assistant", streamId: "run-1", content: [{ type: "text", text: "我来写文件" }], stopReason: "pending" };

	it("puts a streaming tool call into its message before the arguments finish", () => {
		const started = foldPiWebEvent(base({ messages: [pending] }), { type: "toolcall", messageId: "run-1", contentIndex: 1, id: "call-1", name: "write", args: {}, ts: 1 });
		expect(started.messages[0].content).toEqual([{ type: "text", text: "我来写文件" }, { type: "toolCall", id: "call-1", name: "write", arguments: {} }]);
		const grown = foldPiWebEvent(started, { type: "toolcall", messageId: "run-1", contentIndex: 1, id: "call-1", name: "write", args: { path: "src/a.ts" }, ts: 2 });
		expect(grown.messages[0].content[1]).toEqual({ type: "toolCall", id: "call-1", name: "write", arguments: { path: "src/a.ts" } });
		// 原消息对象不被就地修改
		expect(pending.content).toHaveLength(1);
	});

	it("never replaces complete arguments with a clipped preview that arrives late", () => {
		const complete: WebMessage = { role: "assistant", streamId: "run-1", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "src/a.ts", content: "完整内容" } }] };
		const next = foldPiWebEvent(base({ messages: [complete] }), { type: "toolcall", messageId: "run-1", contentIndex: 0, id: "call-1", name: "write", args: { path: "src/a.ts", content: "完…" }, ts: 3 });
		expect(next.messages[0]).toBe(complete);
		// 找不到对应的消息就什么都不做
		expect(foldPiWebEvent(base(), { type: "toolcall", messageId: "missing", contentIndex: 0, id: "c", name: "read", args: {}, ts: 1 }).messages).toEqual([]);
	});

	it("shows a ! command as soon as it starts and appends its output as it arrives", () => {
		const start: WebMessage = { role: "bashExecution", streamId: "bash-1", content: [], bash: { command: "npm test", output: "", running: true } };
		let state = foldPiWebEvent(base({ messages: [pending] }), { type: "message", phase: "start", message: start, ts: 1 });
		expect(state.messages.map((message) => message.role)).toEqual(["assistant", "bashExecution"]);
		state = foldPiWebEvent(state, { type: "bash_output", messageId: "bash-1", delta: "PASS a\n", ts: 2 });
		state = foldPiWebEvent(state, { type: "bash_output", messageId: "bash-1", delta: "PASS b\n", ts: 3 });
		expect(state.messages[1].bash).toMatchObject({ command: "npm test", output: "PASS a\nPASS b\n", running: true });
		// 结束帧按流 ID 合并进同一条，并带回持久化的条目 ID
		const end: WebMessage = { role: "bashExecution", id: "entry-9", streamId: "bash-1", content: [], bash: { command: "npm test", output: "PASS a\nPASS b\n", exitCode: 0 } };
		state = foldPiWebEvent(state, { type: "message", phase: "end", message: end, ts: 4 });
		expect(state.messages).toHaveLength(2);
		expect(state.messages[1]).toMatchObject({ id: "entry-9", bash: { exitCode: 0 } });
		expect(state.messages[1].bash?.running).toBeUndefined();
	});

	it("shows an extension's injected message when it starts", () => {
		const custom: WebMessage = { role: "custom", streamId: "c-1", customType: "plan-mode", content: [{ type: "text", text: "已进入计划模式" }] };
		const state = foldPiWebEvent(base(), { type: "message", phase: "start", message: custom, ts: 1 });
		expect(state.messages).toEqual([custom]);
	});

	it("hangs nested tool calls under the call that made them", () => {
		let state = foldPiWebEvent(base(), { type: "tool", id: "call-1", name: "codemode", args: { script: "…" }, state: "running", ts: 1 });
		const parentBefore = state.tools["call-1"];
		state = foldPiWebEvent(state, { type: "tool", id: "call-1/1", name: "read", parentId: "call-1", args: { path: "a.ts" }, state: "running", ts: 2 });
		expect(state.tools["call-1"].children).toEqual(["call-1/1"]);
		// 父条目换了身份：回合级 memo 靠它发现「多了一个子调用」
		expect(state.tools["call-1"]).not.toBe(parentBefore);
		expect(state.tools["call-1/1"]).toMatchObject({ name: "read", parentId: "call-1", state: "running" });
		// 子调用结束：不带 args 也沿用开始时的参数，不重复登记
		state = foldPiWebEvent(state, { type: "tool", id: "call-1/1", name: "read", parentId: "call-1", state: "done", result: "内容", ts: 3 });
		expect(state.tools["call-1"].children).toEqual(["call-1/1"]);
		expect(state.tools["call-1/1"]).toMatchObject({ args: { path: "a.ts" }, state: "done", result: "内容", parentId: "call-1" });
		// 父调用自己的进度事件不丢子调用
		state = foldPiWebEvent(state, { type: "tool", id: "call-1", name: "codemode", state: "done", result: "ok", ts: 4 });
		expect(state.tools["call-1"].children).toEqual(["call-1/1"]);
	});

	it("queues an editor request as a dialog, and applies widget, title and editor-text notices", () => {
		let state = foldPiWebEvent(base(), { type: "extension_ui", id: "e1", method: "editor", title: "编辑说明", prefill: "草稿", ts: 1 });
		expect(state.extensionDialogs).toEqual([{ id: "e1", method: "editor", title: "编辑说明", message: undefined, options: undefined, questions: undefined, placeholder: undefined, prefill: "草稿", timeout: undefined, ts: 1 }]);

		state = foldPiWebEvent(state, { type: "extension_ui", id: "w1", method: "setWidget", widgetKey: "todo", widgetLines: ["☐ a"], widgetPlacement: "belowEditor", ts: 2 });
		state = foldPiWebEvent(state, { type: "extension_ui", id: "w2", method: "setWidget", widgetKey: "plan", widgetLines: ["1/3"], ts: 3 });
		expect(state.extensionWidgets).toEqual({ todo: { lines: ["☐ a"], placement: "belowEditor" }, plan: { lines: ["1/3"], placement: "aboveEditor" } });
		state = foldPiWebEvent(state, { type: "extension_ui", id: "w3", method: "setWidget", widgetKey: "todo", ts: 4 });
		expect(Object.keys(state.extensionWidgets)).toEqual(["plan"]);

		state = foldPiWebEvent(state, { type: "extension_ui", id: "t1", method: "setTitle", title: "pi · 重构", ts: 5 });
		expect(state.extensionTitle).toBe("pi · 重构");
		expect(foldPiWebEvent(state, { type: "extension_ui", id: "t2", method: "setTitle", title: "", ts: 6 }).extensionTitle).toBeNull();

		state = foldPiWebEvent(state, { type: "extension_ui", id: "x1", method: "setEditorText", text: "/review", ts: 7 });
		expect(state.editorText).toEqual({ id: "x1", text: "/review" });
		// 同样的文字再发一次也是一次新的请求（id 不同）
		expect(foldPiWebEvent(state, { type: "extension_ui", id: "x2", method: "setEditorText", text: "/review", ts: 8 }).editorText).toEqual({ id: "x2", text: "/review" });
	});

	it("restores a pending editor request from a snapshot", () => {
		const snapshot = { extensionUiRequests: [{ type: "extension_ui", id: "e1", method: "editor", title: "编辑", prefill: "内容", ts: 1 }] } as unknown as WebSnapshot;
		expect(extensionDialogsFromSnapshot(snapshot)).toMatchObject([{ id: "e1", method: "editor", title: "编辑", prefill: "内容" }]);
	});

	it("tracks which physical model a virtual model was routed to", () => {
		const snapshot = { model: { provider: "router", id: "auto", name: "Auto" }, thinkingLevels: [] } as unknown as WebSnapshot;
		let state = foldPiWebEvent(base({ snapshot }), { type: "model", provider: "router", model: "auto", routedModel: { provider: "anthropic", id: "claude-sonnet-5-5" }, ts: 1 });
		expect(state.snapshot?.routedModel).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
		// 没带这个字段的 model 事件（只换了思考档位）不动它
		state = foldPiWebEvent(state, { type: "model", thinkingLevel: "high", ts: 2 });
		expect(state.snapshot?.routedModel).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
		// 换回普通模型：显式 null 清掉
		state = foldPiWebEvent(state, { type: "model", provider: "openai", model: "gpt-6", routedModel: null, ts: 3 });
		expect(state.snapshot?.routedModel).toBeNull();
	});
});
