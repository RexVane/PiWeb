import { describe, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { editSessionQueue, sessionQueueState } from "../src/lib/session-queue";

/** Exercise the installed SDK's native queue writers/getters with real Agent queues.
 * No resource discovery, credential loading, model requests, filesystem or running instance is involved.
 */
async function queued(steering = ["same", "same"], followUp = ["follow"]) {
	const session = Object.assign(Object.create(AgentSession.prototype), {
		agent: new Agent({ streamFn: () => { throw new Error("Unexpected model request in queue-only test"); } }), _steeringMessages: [] as string[], _followUpMessages: [] as string[],
		_queuedMessagesWithImages: new WeakSet<object>(), _emit: vi.fn(),
	});
	for (const text of steering) await session._queueSteer(text, [{ type: "image", data: "YQ==", mimeType: "image/png" }]);
	for (const text of followUp) await session._queueFollowUp(text);
	return session as AgentSession;
}
const raw = (session: AgentSession) => session as unknown as { agent: { steeringQueue: { messages: Array<{ role: string; content: unknown[] }> }; followUpQueue: { messages: Array<{ role: string; content: unknown[] }> } }; _steeringMessages: string[]; _queuedMessagesWithImages: WeakSet<object> };
const token = (session: AgentSession, index = 0, kind: "steering" | "followUp" = "steering") => sessionQueueState(session).editTokens![kind][index];

describe("SDK queue editing seam", () => {
	it("edits one duplicate-text message in place, preserving order, images and SDK image tracking", async () => {
		const session = await queued(); const internal = raw(session);
		const messages = internal.agent.steeringQueue.messages; const original = messages[1]; const image = original.content[1];
		const state = editSessionQueue(session, "steering", 1, token(session, 1), "changed\n@src/file.ts");
		expect(state.steering).toEqual(["same", "changed\n@src/file.ts"]); expect(state.followUp).toEqual(["follow"]);
		expect(internal.agent.steeringQueue.messages).toBe(messages); expect(messages[1]).toBe(original);
		expect(original.content).toEqual([{ type: "text", text: "changed\n@src/file.ts" }, image]); expect(original.content[1]).toBe(image);
		expect(internal._queuedMessagesWithImages.has(original)).toBe(true);
		expect(session.getSteeringMessages()).toEqual(state.steering);
	});
	it("edits follow-ups without touching steering/custom messages", async () => {
		const session = await queued(); const internal = raw(session);
		const custom = { role: "custom", content: [{ type: "text", text: "extension context" }] };
		internal.agent.followUpQueue.messages.unshift(custom);
		editSessionQueue(session, "followUp", 0, token(session, 0, "followUp"), "new follow");
		expect(internal.agent.followUpQueue.messages[0]).toBe(custom); expect(session.getSteeringMessages()).toEqual(["same", "same"]);
		expect(session.getFollowUpMessages()).toEqual(["new follow"]);
	});
	it("allows a still-pending target to move when an earlier message is consumed and another is added", async () => {
		const session = await queued(["first", "target"]); const revision = token(session, 1); const internal = raw(session);
		internal.agent.steeringQueue.messages.shift(); internal._steeringMessages.shift();
		await (session as any)._queueSteer("later");
		editSessionQueue(session, "steering", 1, revision, "edited target");
		expect(session.getSteeringMessages()).toEqual(["edited target", "later"]);
	});
	it("rejects a consumed message even when another has identical text", async () => {
		const session = await queued(); const revision = token(session); const internal = raw(session);
		internal.agent.steeringQueue.messages.shift(); internal._steeringMessages.shift();
		expect(() => editSessionQueue(session, "steering", 0, revision, "wrong target")).toThrow(/队列已改变/);
		expect(session.getSteeringMessages()).toEqual(["same"]);
	});
	it("rejects concurrent edits and tokens belonging to another session", async () => {
		const session = await queued(); const revision = token(session);
		editSessionQueue(session, "steering", 0, revision, "new");
		expect(() => editSessionQueue(session, "steering", 0, revision, "stale")).toThrow(/队列已改变/);
		const other = await queued(); expect(() => editSessionQueue(other, "steering", 0, token(session), "wrong session")).toThrow(/队列已改变/);
	});
	it("fails closed if future SDK getters return copies or queue/display state diverges", async () => {
		const session = await queued(); const revision = token(session); const internal = raw(session);
		(session as any).getSteeringMessages = () => [...internal._steeringMessages];
		expect(() => editSessionQueue(session, "steering", 0, revision, "bad")).toThrow(/当前 SDK/);
		expect(internal._steeringMessages).toEqual(["same", "same"]);
	});
	it("does not erase an image-only message; a new caption preserves its image", async () => {
		const session = await queued([""]); const image = raw(session).agent.steeringQueue.messages[0].content[1];
		expect(() => editSessionQueue(session, "steering", 0, token(session), " ")).toThrow(/不能为空/);
		editSessionQueue(session, "steering", 0, token(session), "caption");
		expect(raw(session).agent.steeringQueue.messages[0].content[1]).toBe(image);
	});
});
