import { describe, expect, it } from "vitest";
import { TrajLedger, buildTrajectoryFromEntries } from "../src/lib/trajectory";

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

	it("flags irreversibly damaged historical output without rendering replacement characters", () => {
		const entries = buildTrajectoryFromEntries([
			{
				type: "message",
				message: {
					role: "assistant",
					timestamp: 1_000,
					content: [{ type: "toolCall", id: "call-1", name: "powershell", arguments: { command: "Get-ChildItem" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					isError: true,
					timestamp: 1_050,
					content: [{ type: "text", text: "��� damaged line\r\nFullyQualifiedErrorId: Example\r\nCommand exited with code 1" }],
				},
			},
		]);

		const tool = entries.find((entry) => entry.kind === "tool");
		expect(tool).toMatchObject({ encodingLoss: true, isError: true });
		expect(tool?.detail).toContain("FullyQualifiedErrorId: Example");
		expect(tool?.detail).toContain("Command exited with code 1");
		expect(tool?.detail).not.toContain("�");
	});
});
