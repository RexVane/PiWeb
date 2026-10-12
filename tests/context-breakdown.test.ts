/**
 * 上下文 13 类分段的纯函数口径：字符/4 估算（与 SDK estimateTokens 一致）与
 * 消息内容五分类（User / Agent Text / Thinking / Tool Call / Tool Output）。
 */
import { describe, expect, it } from "vitest";
import { classifyMessageChars, estimateTokensOf } from "../src/lib/process-format";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectedContextUsage } from "../src/lib/session/metrics";

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

	it("counts raw SDK tool-result text as tool output and includes tool names", () => {
		const chars = classifyMessageChars([
			{ role: "toolResult", content: [{ type: "text", text: "result" }] },
			{ role: "system", content: [{ type: "text", text: "handled on server" }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a" } } as any] },
		]);
		expect(chars.toolOutput).toBe(6);
		expect(chars.agentText).toBe(0);
		expect(chars.agentToolCall).toBe(4 + JSON.stringify({ path: "a" }).length);
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

describe("cold context projection", () => {
	const assistant = (input: number) => ({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "anthropic-messages", provider: "anthropic", model: "test", timestamp: 1000, stopReason: "stop",
		usage: { input, output: 10, cacheRead: 50, cacheWrite: 0, totalTokens: input + 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);
	const read = (sm: SessionManager) => projectedContextUsage(sm.buildSessionProjection(), sm.getBranch(), 1000);
	it("includes trailing tool output, uses native totalTokens and skips error usage", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(assistant(100));
		sm.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "x".repeat(40) }], timestamp: 1100, isError: false });
		sm.appendMessage({ ...assistant(999), stopReason: "error" });
		expect(read(sm)).toEqual({ tokens: 171, contextWindow: 1000, percent: 17.1 });
	});
	it("does not reuse pre-compaction usage or an abandoned branch", () => {
		const sm = SessionManager.inMemory();
		const user = sm.appendMessage({ role: "user", content: "hello", timestamp: 100 });
		sm.appendMessage(assistant(100));
		sm.appendCompaction("summary", user, 160);
		expect(read(sm)).toEqual({ tokens: null, contextWindow: 1000, percent: null });
		sm.appendMessage(assistant(20));
		expect(read(sm)?.tokens).toBe(80);
		sm.branch(user);
		sm.appendMessage(assistant(40));
		expect(read(sm)?.tokens).toBe(100);
	});
	it("invalidates old usage when context is edited after a reply", () => {
		const sm = SessionManager.inMemory();
		const user = sm.appendMessage({ role: "user", content: "long original text", timestamp: 100 });
		sm.appendMessage(assistant(100));
		sm.appendContextEdit(user, { content: "tiny" });
		expect(read(sm)?.tokens).toBe(2);
	});
});
