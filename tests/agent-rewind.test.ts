import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, dispose: () => {} }),
}));
import { execute } from "../src/lib/agent-manager";

type Managed = Parameters<typeof execute>[0];

/** 会话树：u1 → a1 → u2 → a2（当前叶子）；x1 是另一条分支上的用户消息，t1 是工具结果 */
const entries: Record<string, { id: string; type: string; message?: { role: string } }> = {
	u1: { id: "u1", type: "message", message: { role: "user" } },
	a1: { id: "a1", type: "message", message: { role: "assistant" } },
	u2: { id: "u2", type: "message", message: { role: "user" } },
	a2: { id: "a2", type: "message", message: { role: "assistant" } },
	x1: { id: "x1", type: "message", message: { role: "user" } },
};
const branch = ["u1", "a1", "u2", "a2"].map((id) => entries[id]);

function fixture({ running = false, queued = { steering: ["queued steer"], followUp: ["queued follow-up"] } } = {}) {
	const calls: string[] = [];
	const session = {
		isStreaming: running,
		isIdle: !running,
		clearQueue: vi.fn(() => { calls.push("clearQueue"); return structuredClone(queued); }),
		abort: vi.fn(async () => {
			calls.push("abort");
			session.isStreaming = false;
			session.isIdle = true;
			m.runActive = false;
		}),
		navigateTree: vi.fn(async (id: string) => {
			calls.push(`navigate:${id}`);
			if (session.isStreaming) throw new Error("Wait for the current response to finish before navigating the session tree.");
			return { cancelled: false, editorText: `text of ${id}` };
		}),
		prompt: vi.fn(async (text: string, options: { preflightResult: (ok: boolean) => void }) => {
			calls.push(`prompt:${text}`);
			options.preflightResult(true);
		}),
	};
	const m = {
		session, creating: null, disposed: false, promptSubmitting: false, runActive: running,
		resourceReloading: false, resourceReloadPending: false, cwd: "test", sessionPath: "test",
		seq: 0, buffer: [], subscribers: new Set(), lastActive: 0,
		sm: { getEntry: (id: string) => entries[id], getBranch: () => branch },
		growth: { version: 1, prepare: vi.fn(async () => {}), onEvent: () => {} },
	} as unknown as Managed;
	const events = () => m.buffer.map((frame) => JSON.parse(frame.json) as { type: string; state?: string });
	return { m, session, calls, events };
}

afterEach(() => vi.restoreAllMocks());

describe("rewind to before a user message (recall / edit and resend)", () => {
	it("recalls a message while the agent is running: clears the queue, aborts, then rewinds", async () => {
		const { m, calls, events } = fixture({ running: true });
		const result = await execute(m, { cmd: "rewind", entryId: "u2" });
		expect(result).toEqual({ ok: true, data: { editorText: "text of u2", cleared: { steering: ["queued steer"], followUp: ["queued follow-up"] } } });
		expect(calls).toEqual(["clearQueue", "abort", "navigate:u2"]);
		expect(events().map((event) => event.type === "status" ? `status:${event.state}` : event.type)).toEqual(["queue", "status:aborted", "history", "status:idle"]);
		expect(m.promptSubmitting).toBe(false);
	});

	it("does not abort an idle session and resends edited content in the same command", async () => {
		const { m, session, calls } = fixture();
		const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
		const result = await execute(m, { cmd: "rewind", entryId: "u1", text: "  edited question  ", images });
		expect(result).toEqual({ ok: true, data: { accepted: true, cleared: { steering: ["queued steer"], followUp: ["queued follow-up"] }, rewound: true } });
		expect(calls).toEqual(["clearQueue", "navigate:u1", "prompt:edited question"]);
		expect(session.prompt).toHaveBeenCalledWith("edited question", expect.objectContaining({ images }));
		expect(m.growth!.prepare).toHaveBeenCalled();
	});

	it("refuses entries that are not user messages on the current branch without touching the session", async () => {
		const { m, calls } = fixture({ running: true });
		expect(await execute(m, { cmd: "rewind", entryId: "a1" })).toEqual({ ok: false, error: "only a user message can be rewound" });
		expect(await execute(m, { cmd: "rewind", entryId: "x1" })).toEqual({ ok: false, error: "the message is not in the current conversation" });
		expect(await execute(m, { cmd: "rewind", entryId: "missing" })).toMatchObject({ ok: false });
		expect(calls).toEqual([]);
		expect(m.promptSubmitting).toBe(false);
	});

	it("refuses while another command holds the submit slot and rejects an empty resend", async () => {
		const { m, calls } = fixture();
		m.promptSubmitting = true;
		expect(await execute(m, { cmd: "rewind", entryId: "u2" })).toEqual({ ok: false, error: "session is busy accepting another command" });
		m.promptSubmitting = false;
		expect(await execute(m, { cmd: "rewind", entryId: "u2", text: "   " })).toEqual({ ok: false, error: "empty prompt" });
		expect(calls).toEqual([]);
	});

	it("hands back the cleared queue when an extension cancels the rewind", async () => {
		const { m, session, events } = fixture();
		session.navigateTree.mockResolvedValueOnce({ cancelled: true } as never);
		expect(await execute(m, { cmd: "rewind", entryId: "u2" })).toEqual({
			ok: false, error: "an extension cancelled the rewind", data: { cleared: { steering: ["queued steer"], followUp: ["queued follow-up"] } },
		});
		expect(events().some((event) => event.type === "history")).toBe(false);
	});

	it("marks a failed resend as rewound so the browser can restore the edited text", async () => {
		const { m, session, events } = fixture({ queued: { steering: [], followUp: [] } });
		session.prompt.mockImplementationOnce(async (_text: string, options: { preflightResult: (ok: boolean) => void }) => {
			options.preflightResult(false);
			throw new Error("missing credentials");
		});
		expect(await execute(m, { cmd: "rewind", entryId: "u2", text: "edited" })).toEqual({
			ok: false, error: "missing credentials", data: { cleared: { steering: [], followUp: [] }, rewound: true },
		});
		expect(events().some((event) => event.type === "history")).toBe(true);
		expect(m.promptSubmitting).toBe(false);
	});
});
