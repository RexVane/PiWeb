import type { Message } from "@earendil-works/pi-ai";
import { BoundaryError } from "../path-security";
import { byteSlice } from "./context";

const OMITTED = "\n[Read-only tool output omitted to fit the model's context window; request a narrower range if needed.]";
export const sideContextBytes = (messages: Message[]) => Buffer.byteLength(JSON.stringify(messages, (_key, value) => value?.type === "image" && typeof value.data === "string" ? { ...value, data: "x".repeat(4096) } : value), "utf8");
const sizeOf = sideContextBytes;
const hasCalls = (message: Message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall");

/** Trim complete older tool exchanges first, keeping tool-call/result pairs and the latest question. */
export function boundSideChatToolContext(source: Message[], budget: number): { messages: Message[]; truncated: boolean } {
	if (sizeOf(source) <= budget) return { messages: source, truncated: false };
	const messages = source.map((message) => message.role === "toolResult" ? { ...message, content: message.content.map((part) => ({ ...part })) } : message);
	let size = sizeOf(messages);
	while (size > budget) {
		const first = messages.findIndex(hasCalls);
		const next = first < 0 ? -1 : messages.findIndex((message, index) => index > first && hasCalls(message));
		if (next < 0) break;
		messages.splice(first, next - first, ...messages.slice(first, next).filter((message) => message.role === "system"));
		size = sizeOf(messages);
	}
	while (size > budget) {
		let largest: { type: "text"; text: string } | undefined;
		for (const message of messages) {
			if (message.role !== "toolResult") continue;
			for (const part of message.content) {
				if (part.type === "text" && Buffer.byteLength(part.text) > Buffer.byteLength(OMITTED) + 32 && (!largest || Buffer.byteLength(part.text) > Buffer.byteLength(largest.text))) largest = part;
			}
		}
		if (largest) {
			largest.text = byteSlice(largest.text, Math.max(0, Buffer.byteLength(largest.text) - (size - budget) - Buffer.byteLength(OMITTED) - 64)) + OMITTED;
		} else {
			// Base64 image data must not exhaust a text model's window either.
			const imageMessage = messages.find((message) => message.role === "toolResult" && message.content.some((part) => part.type === "image"));
			if (imageMessage?.role !== "toolResult") throw new BoundaryError("side-chat tool context is too large; narrow the question and try again");
			imageMessage.content = imageMessage.content.map((part) => part.type === "image" ? { type: "text", text: "[Tool image omitted to fit this model's context window.]" } : part);
		}
		size = sizeOf(messages);
	}
	return { messages, truncated: true };
}
