import { describe, expect, it, vi } from "vitest";
import { execute } from "../src/lib/agent-manager";
import { sessionQueueState } from "../src/lib/session-queue";

type Managed = Parameters<typeof execute>[0];
function fixture() {
	const image = { type: "image", data: "YQ==", mimeType: "image/png" };
	const message = { role: "user", content: [{ type: "text", text: "original" }, image], timestamp: 1 };
	const session = {
		_steeringMessages: ["original"], _followUpMessages: [] as string[], _emitQueueUpdate: vi.fn(),
		agent: { steeringQueue: { messages: [message] }, followUpQueue: { messages: [] } },
		getSteeringMessages() { return this._steeringMessages; }, getFollowUpMessages() { return this._followUpMessages; },
		abort: vi.fn(), clearQueue: vi.fn(), prompt: vi.fn(),
	};
	const m = { session, creating: null, disposed: false, promptSubmitting: true, runActive: true, cwd: "/queue-test", sessionPath: "/queue-test/session.jsonl",
		seq: 0, buffer: [] as { json: string }[], subscribers: new Set(), lastActive: 0 } as unknown as Managed;
	const command = { cmd: "editQueue" as const, queueKind: "steering" as const, queueIndex: 0, queueRevision: sessionQueueState(session as any).editTokens!.steering[0], text: "edited" };
	return { session, message, image, m, command };
}
describe("managed queue edit command", () => {
	it("edits during an active run without stopping, claiming submission, clearing or re-prompting", async () => {
		const { session, message, image, m, command } = fixture();
		const result = await execute(m, command);
		expect(result).toMatchObject({ ok: true, data: { queue: { steering: ["edited"], followUp: [] } } });
		expect(message.content[1]).toBe(image); expect(session.abort).not.toHaveBeenCalled(); expect(session.clearQueue).not.toHaveBeenCalled(); expect(session.prompt).not.toHaveBeenCalled();
		expect(m.promptSubmitting).toBe(true); expect(m.runActive).toBe(true);
		const frame = JSON.parse(m.buffer[0].json); expect(frame).toMatchObject({ type: "queue", steering: ["edited"] });
		expect(frame.editTokens.steering[0]).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(frame)).not.toContain(image.data);
	});
	it("returns a localized error code for a stale edit, without changing any pending message", async () => {
		const { session, m, command } = fixture();
		expect(await execute(m, { ...command, queueRevision: "0".repeat(64) })).toMatchObject({ ok: false, errorCode: "QUEUE_CHANGED" });
		expect(session._steeringMessages).toEqual(["original"]); expect(session._emitQueueUpdate).not.toHaveBeenCalled();
	});
	it("does not initialize a cold or disposed session to edit a message which no longer exists", async () => {
		const { m, command } = fixture(); m.session = null;
		expect(await execute(m, command)).toMatchObject({ ok: false, errorCode: "QUEUE_CHANGED" });
		const other = fixture(); other.m.disposed = true;
		expect(await execute(other.m, other.command)).toMatchObject({ ok: false, errorCode: "QUEUE_CHANGED" });
	});
});
