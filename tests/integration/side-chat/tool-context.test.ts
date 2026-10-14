import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { boundSideChatToolContext } from "@/lib/side-chat/tool-context";

const batch = (id: string, text: string): Message[] => [
	fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }, { id }), { stopReason: "toolUse" }),
	{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 },
];
const head: Message[] = [{ role: "system", content: "read-only instructions", timestamp: 0 }, { role: "user", content: "current question", timestamp: 0 }];

describe("side-chat tool context bounds", () => {
	it("keeps ordinary results untouched", () => {
		const messages = [...head, ...batch("recent", "small answer")];
		expect(boundSideChatToolContext(messages, 10_000)).toEqual({ messages, truncated: false });
	});
	it("drops whole older tool exchanges and preserves the latest call/result pair", () => {
		const messages = [...head, ...batch("old", "old output".repeat(2000)), ...batch("recent", "keep this output")];
		const before = JSON.stringify(messages);
		const result = boundSideChatToolContext(messages, 2000);
		expect(result.truncated).toBe(true);
		expect(result.messages).toEqual([...head, ...messages.slice(-2)]);
		expect(JSON.stringify(messages)).toBe(before);
	});
	it("bounds a large Unicode result while preserving its tool identity and newest question", () => {
		const messages = [...head, ...batch("recent", "读取结果🙂\n".repeat(10_000))];
		const before = JSON.stringify(messages);
		const result = boundSideChatToolContext(messages, 2400);
		const text = JSON.stringify(result.messages);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2400);
		expect(text).toContain("current question");
		expect(text).toContain("omitted");
		expect(text).not.toContain("�");
		expect(result.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "recent", toolName: "read" });
		expect(JSON.stringify(messages)).toBe(before);
	});
	it("reports an omitted image instead of overflowing the model window", () => {
		const messages = [...head, ...batch("image", "image result")];
		const resultMessage = messages.at(-1)!;
		if (resultMessage.role !== "toolResult") throw new Error("expected tool result");
		resultMessage.content.push({ type: "image", data: "a".repeat(50_000), mimeType: "image/png" });
		const result = boundSideChatToolContext(messages, 2000);
		expect(result.truncated).toBe(true);
		expect(JSON.stringify(result.messages)).toContain("Tool image omitted");
		expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThanOrEqual(2000);
	});
});
