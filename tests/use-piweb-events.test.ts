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

	it("retains retry notice while busy and clears it only on the settled idle status", () => {
		const initial = { snapshot: { isStreaming: true }, retryNotice: "自动重试 1/3", workingMessage: "working" } as PiWebState;
		const busy = foldPiWebEvent(initial, { type: "status", isStreaming: true, state: "compacting", ts: 2 });
		expect(busy.retryNotice).toBe("自动重试 1/3");
		const settled = foldPiWebEvent(busy, { type: "status", isStreaming: false, state: "idle", ts: 3 });
		expect(settled.retryNotice).toBeNull();
		expect(settled.snapshot?.isStreaming).toBe(false);
	});
});
