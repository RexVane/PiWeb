import { describe, expect, it } from "vitest";
import { TrajLedger } from "../src/lib/trajectory";

describe("trajectory timing", () => {
	it("continues sequence numbers after restored history", () => {
		const ledger = new TrajLedger([
			{ seq: 7, kind: "user", ts: 1_000, detail: "restored" },
		]);
		ledger.onEvent({ type: "message_start", message: { role: "user", content: "live" } } as any, 2_000);

		expect(ledger.entries.map((entry) => entry.seq)).toEqual([7, 8]);
	});

	it("records model duration, TTFT, and decoding time from Pi events", () => {
		const ledger = new TrajLedger();
		ledger.onEvent({ type: "message_start", message: { role: "assistant" } } as any, 1_000);
		ledger.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } } as any, 1_035);
		ledger.onEvent(
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: {} } } as any,
			1_120,
		);

		expect(ledger.entries[0]?.timing).toEqual({ ttftMs: 35, decodeMs: 85, durationMs: 120 });
	});

	it("records tool execution duration without inventing cold-session timing", () => {
		const ledger = new TrajLedger();
		ledger.onEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a.ts" } } as any, 2_000);
		ledger.onEvent({ type: "tool_execution_end", toolCallId: "call-1", result: "content", isError: false } as any, 2_275);

		expect(ledger.entries[0]).toMatchObject({
			kind: "tool",
			toolName: "read",
			toolCallId: "call-1",
			timing: { durationMs: 275 },
		});
	});
});
