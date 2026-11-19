import { createHash, randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { WebQueue } from "./types";
import { MAX_MESSAGE_CHARS } from "./chat/image-attachment";

type QueueSession = Pick<AgentSession, "agent" | "getSteeringMessages" | "getFollowUpMessages">;
const ids = new WeakMap<object, string>();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
function physicalQueues(session: QueueSession): { steering: Record<string, unknown>[]; followUp: Record<string, unknown>[] } | null {
	const agent = session.agent as unknown as { steeringQueue?: { messages?: unknown }; followUpQueue?: { messages?: unknown } };
	const steering = agent?.steeringQueue?.messages;
	const followUp = agent?.followUpQueue?.messages;
	if (!Array.isArray(steering) || !Array.isArray(followUp) || ![...steering, ...followUp].every(record)) return null;
	return { steering, followUp };
}

/** Token covers both display state and real queued objects, including duplicate text/custom messages.
 * Queue objects retain identity while edited, so image-normalization tracking is not lost.
 */
export function sessionQueueState(session: QueueSession): WebQueue {
	const steering = [...session.getSteeringMessages()];
	const followUp = [...session.getFollowUpMessages()];
	const queues = physicalQueues(session);
	if (!queues) return { steering, followUp };
	const identity = (message: object) => { let id = ids.get(message); if (!id) { id = randomUUID(); ids.set(message, id); } return id; };
	const identities = (messages: object[]) => messages.map(identity);
	const revision = createHash("sha256").update(JSON.stringify([steering, followUp, identities(queues.steering), identities(queues.followUp)])).digest("hex");
	const tokens = (kind: "steering" | "followUp", display: string[]) => {
		const users = queues[kind].filter((message) => message.role === "user");
		if (users.length !== display.length) return display.map(() => "");
		const values = users.map((message, index) => createHash("sha256").update(JSON.stringify([identity(session), kind, identity(message), display[index]])).digest("hex"));
		const counts = new Map<string, number>(); values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
		return values.map((value) => counts.get(value) === 1 ? value : "");
	};
	return { steering, followUp, revision, editTokens: { steering: tokens("steering", steering), followUp: tokens("followUp", followUp) } };
}
export class QueueEditError extends Error {
	constructor(readonly code: "QUEUE_CHANGED" | "QUEUE_EDIT_UNSUPPORTED", message: string) { super(message); }
}

/** Checked SDK 1.5.2 seam: queues and UI text must agree before any mutation. No clear/requeue,
 * hooks, command execution or network request is performed while editing an accepted message.
 */
export function editSessionQueue(session: QueueSession, kind: "steering" | "followUp", index: number, revision: string, text: string): WebQueue {
	if (typeof text !== "string" || !text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error("待发消息不能为空或超过长度上限。");
	if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid queue index");
	if (kind !== "steering" && kind !== "followUp") throw new Error("Invalid queue kind");
	const state = sessionQueueState(session);
	if (!state.editTokens) throw new QueueEditError("QUEUE_EDIT_UNSUPPORTED", "当前 SDK 不支持安全地编辑队列，请更新 PiWeb。");
	const actualIndex = state.editTokens[kind].indexOf(revision);
	if (actualIndex < 0) throw new QueueEditError("QUEUE_CHANGED", "待发消息已被处理或队列已改变，请重新编辑。");
	index = actualIndex; // Earlier queued messages may have been delivered while this one was being edited.
	const internals = session as unknown as { _steeringMessages?: unknown; _followUpMessages?: unknown; _emitQueueUpdate?: () => void };
	const display = kind === "steering" ? session.getSteeringMessages() : session.getFollowUpMessages();
	const actualDisplay = kind === "steering" ? internals._steeringMessages : internals._followUpMessages;
	const queues = physicalQueues(session);
	if (!queues || actualDisplay !== display || !Array.isArray(actualDisplay) || Object.isFrozen(actualDisplay) || typeof internals._emitQueueUpdate !== "function") {
		throw new QueueEditError("QUEUE_EDIT_UNSUPPORTED", "当前 SDK 不支持安全地编辑队列，请更新 PiWeb。");
	}
	const users = queues[kind].filter((message) => message.role === "user");
	const message = users[index];
	if (!message || users.length !== display.length) throw new QueueEditError("QUEUE_CHANGED", "待发消息已被处理或队列已改变，请重新编辑。");
	const content = message.content;
	const currentText = typeof content === "string" ? content : Array.isArray(content)
		? content.filter((block) => record(block) && block.type === "text").map((block) => String(block.text ?? "")).join("") : undefined;
	if (currentText !== display[index] || Object.isFrozen(message)) throw new QueueEditError("QUEUE_CHANGED", "待发消息已被处理或队列已改变，请重新编辑。");
	const descriptor = Object.getOwnPropertyDescriptor(message, "content");
	const displayDescriptor = Object.getOwnPropertyDescriptor(actualDisplay, String(index));
	if ((descriptor && !descriptor.writable) || (displayDescriptor && !displayDescriptor.writable)) throw new QueueEditError("QUEUE_EDIT_UNSUPPORTED", "当前 SDK 不支持安全地编辑队列，请更新 PiWeb。");
	message.content = typeof content === "string" ? text : [{ type: "text", text }, ...(content as unknown[]).filter((block) => !record(block) || block.type !== "text")];
	actualDisplay[index] = text;
	try { internals._emitQueueUpdate(); }
	catch (error) { message.content = content; actualDisplay[index] = currentText; throw error; }
	return sessionQueueState(session);
}
