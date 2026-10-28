import { describe, expect, it } from "vitest";
import { toWebMessage } from "@/lib/agent-manager";
import { buildTrajectoryFromEntries, TrajLedger } from "@/lib/trajectory";

const cancelled = { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted", timestamp: 1000 };

describe("SDK cancellation presentation", () => {
	it("restores an SDK AbortError as a stopped message, including persisted history", () => {
		expect(toWebMessage(cancelled).stopReason).toBe("aborted");
		expect(toWebMessage({ ...cancelled, errorMessage: "429 rate limit exceeded" }).stopReason).toBe("error");
		expect(toWebMessage({ ...cancelled, errorMessage: "The operation was aborted due to timeout" }).stopReason).toBe("error");
	});

	it("preserves the model generation duration without estimating user waiting time", () => {
		expect(toWebMessage({ ...cancelled, durationMs: 1250 }).durationMs).toBe(1250);
		for (const durationMs of [-1, Infinity, NaN, "1250"]) expect(toWebMessage({ ...cancelled, durationMs }).durationMs).toBeUndefined();
	});

	it("does not turn stopped model/tool entries red in live or reconstructed trajectories", () => {
		const call = { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "sleep 30" } }] };
		const result = { role: "toolResult", timestamp: 2, toolCallId: "c", toolName: "bash", isError: true, content: [{ type: "text", text: "started\n\nCommand aborted" }] };
		const cold = buildTrajectoryFromEntries([call, result, cancelled].map(message => ({ type: "message", message })));
		expect(cold.some(entry => entry.isError)).toBe(false);
		const live = new TrajLedger();
		live.onEvent({ type: "message_end", message: call } as never, 1);
		live.onEvent({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} } as never, 2);
		live.onEvent({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", isError: true, result: { content: result.content } } as never, 3);
		expect(live.entries.some(entry => entry.isError)).toBe(false);
		expect(live.entries.find(entry => entry.kind === "tool")?.detail).toContain("Command aborted");
		live.onEvent({ type: "message_start", message: result } as never, 3);
		live.onEvent({ type: "message_end", message: cancelled } as never, 4);
		expect(live.entries.some(entry => entry.isError)).toBe(false);
	});
});
