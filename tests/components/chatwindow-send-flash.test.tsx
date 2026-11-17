// @vitest-environment jsdom
/**
 * 发送新消息时，上一回合已经折叠的过程不能先展开再收起。
 *
 * 复现路径：上一回合已经完成（过程折叠、最终回答在外面）→ 用户点发送 → isStreaming 变 true，
 * 但新回合的助手消息还没到。之前 finalIdx 只看 isStreaming，于是上一回合的最终回答被当成
 * 「正在流式的那条」重新塞回过程里，折叠过程展开一下；等新助手消息到了才恢复，视觉上就是
 * 发消息前闪一下（Linux 上更明显）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

/** 一个带过程（工具调用）的完整回合：用户 → 工具调用 → 工具结果 → 最终回答 */
function turn(question: string, t: number): WebMessage[] {
	return [
		{ role: "user", id: `u${t}`, content: [{ type: "text", text: question }], timestamp: t },
		{ role: "assistant", id: `a-tool${t}`, content: [{ type: "toolCall", id: `call${t}`, name: "read", arguments: { path: "a.ts" } }], stopReason: "toolUse", timestamp: t + 1 },
		{ role: "toolResult", toolCallId: `call${t}`, toolName: "read", content: [{ type: "text", text: "file content" }], timestamp: t + 2 },
		{ role: "assistant", id: `a-final${t}`, content: [{ type: "text", text: "改好了。" }], stopReason: "stop", timestamp: t + 3, endedAt: t + 3 },
	] as unknown as WebMessage[];
}

const turns = () => [...document.querySelectorAll<HTMLElement>(".pw-turn")];
const answers = () => [...document.querySelectorAll('[data-role="assistant"]')];

describe("sending a message keeps finished turns collapsed", () => {
	it("does not expand the previous turn's collapsed process while the new reply has not started", () => {
		const finished = [...turn("第一个问题", 1_000), ...turn("第二个问题", 20_000)];
		const { rerender } = render(<ChatWindow messages={finished} tools={{}} isStreaming={false} />);
		expect(turns()).toHaveLength(2);
		expect(turns().every((node) => node.hasAttribute("data-collapsed"))).toBe(true);
		expect(answers()).toHaveLength(2);

		// 点了发送：乐观用户消息已经挂上，但助手还没开始回
		const sending = [...finished, { role: "user", id: "pending", content: [{ type: "text", text: "第三个问题" }], timestamp: 40_000 } as unknown as WebMessage];
		rerender(<ChatWindow messages={sending} tools={{}} isStreaming={true} />);

		// 前两回合都还是折叠状态，最终回答也还在外面（不会钻进过程里）
		const blocks = turns();
		expect(blocks[0].hasAttribute("data-collapsed")).toBe(true);
		expect(blocks[1].hasAttribute("data-collapsed")).toBe(true);
		expect(answers()).toHaveLength(2);
	});

	it("still keeps the live turn's streaming answer inside the process", () => {
		const first = turn("第一个问题", 1_000);
		const live = [
			...first,
			{ role: "user", id: "u-live", content: [{ type: "text", text: "第二个问题" }], timestamp: 20_000 },
			{
				role: "assistant",
				id: "a-live",
				content: [{ type: "toolCall", id: "call-live", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
				timestamp: 20_001,
			},
			// 最终回答正在流式写入：还没有 endedAt
			{ role: "assistant", id: "a-live-final", content: [{ type: "text", text: "正在写" }], timestamp: 20_002 },
		] as unknown as WebMessage[];
		render(<ChatWindow messages={live} tools={{}} isStreaming={true} />);

		const blocks = turns();
		// 上一回合仍然折叠
		expect(blocks[0].hasAttribute("data-collapsed")).toBe(true);
		// 本回合（最后一个 pw-turn）还在流式：过程不能折叠
		const last = blocks[blocks.length - 1];
		expect(last.hasAttribute("data-collapsed")).toBe(false);
	});
});
