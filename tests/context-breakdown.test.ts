/**
 * 上下文 13 类分段的纯函数口径：字符/4 估算（与 SDK estimateTokens 一致）与
 * 消息内容五分类（User / Agent Text / Thinking / Tool Call / Tool Output）。
 */
import { describe, expect, it } from "vitest";
import { classifyMessageChars, estimateTokensOf } from "../src/lib/process-format";

describe("context breakdown estimation", () => {
	it("estimates tokens at 4 chars per token (SDK口径)", () => {
		expect(estimateTokensOf("")).toBe(0);
		expect(estimateTokensOf("abcd")).toBe(1);
		expect(estimateTokensOf("abcde")).toBe(2);
		expect(estimateTokensOf("a".repeat(400))).toBe(100);
	});

	it("classifies message content into the five message buckets", () => {
		const chars = classifyMessageChars([
			{ role: "user", content: [{ type: "text", text: "hello world!" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "answer" },
					{ type: "thinking", thinking: "reasoning" },
					{ type: "toolCall", arguments: { command: "ls -la" } },
				],
			},
			{ role: "toolResult", content: [{ type: "toolResult", text: "file.txt" }] },
		]);
		expect(chars.user).toBe(12);
		expect(chars.agentText).toBe(6);
		expect(chars.agentThinking).toBe(9);
		expect(chars.agentToolCall).toBe(JSON.stringify({ command: "ls -la" }).length);
		expect(chars.toolOutput).toBe(8);
	});

	it("counts assistant-role text as agent text and ignores images", () => {
		const chars = classifyMessageChars([
			{ role: "user", content: [{ type: "image", data: "xxxx", mimeType: "image/png" } as never, { type: "text", text: "look" }] },
			{ role: "other", content: [{ type: "text", text: "note" }] },
		]);
		expect(chars.user).toBe(4);
		expect(chars.agentText).toBe(4); // 非 user 角色的 text 都算 agent 侧
		expect(chars.toolOutput).toBe(0);
	});
});
