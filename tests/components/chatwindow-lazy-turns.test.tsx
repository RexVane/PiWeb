// @vitest-environment jsdom
/**
 * 回合懒渲染（PR #22）：远离视口的回合先出纯文本占位（TurnLite），滚到附近再完整渲染。
 *
 * - 占位回合的 DOM 骨架要和完整渲染对齐：只有最终回答带 data-role="assistant"，
 *   而且里面要有 .md 标题——大纲（OutlineRail）只从这里收目录项。改前占位回合一个标题都没有，
 *   154 回合的会话打开时大纲只剩最近几轮。
 * - 首屏之后追加的回合直接完整渲染，不等视口判定。
 *
 * 把所有元素的位置都放到视口下方很远处，视口判定就不会升级任何回合，占位/完整的分界只由尾部决定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

beforeEach(() => {
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
		() => ({ top: 100_000, bottom: 100_100, left: 0, right: 0, width: 0, height: 100, x: 0, y: 100_000, toJSON: () => ({}) }) as DOMRect,
	);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function turn(i: number): WebMessage[] {
	const t = i * 10_000;
	return [
		{ role: "user", id: `u${i}`, content: [{ type: "text", text: `问题 ${i}` }], timestamp: t },
		{ role: "assistant", id: `a${i}`, content: [{ type: "text", text: "## 先看看目录" }, { type: "toolCall", id: `call${i}`, name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse", timestamp: t + 1 },
		{ role: "toolResult", toolCallId: `call${i}`, toolName: "bash", content: [{ type: "text", text: "a.ts" }], timestamp: t + 2 },
		{
			role: "assistant",
			id: `f${i}`,
			content: [{ type: "text", text: `## 标题 ${i}\n\n正文第一段\n\n\`\`\`sh\n# 代码里的注释不是标题\nls\n\`\`\`\n\n### 小节 ${i}\n\n收尾` }],
			stopReason: "stop",
			timestamp: t + 3,
		},
	] as unknown as WebMessage[];
}

const conversation = (turns: number) => Array.from({ length: turns }, (_, i) => turn(i + 1)).flat();
const slot = (index: number) => document.querySelector<HTMLElement>(`[data-turn-slot="${index}"]`)!;
// 完整渲染的回合有过程容器 .pw-turn；占位回合只有一行摘要
const isFull = (index: number) => slot(index).querySelector(".pw-turn") !== null;

describe("lazy turn rendering", () => {
	it("renders older turns as placeholders that still carry the outline headings", () => {
		render(<ChatWindow messages={conversation(12)} tools={{}} isStreaming={false} />);

		// 最近 8 回合完整渲染，更早的 4 回合是占位
		expect([0, 1, 2, 3].map(isFull)).toEqual([false, false, false, false]);
		expect(isFull(4)).toBe(true);

		const lite = slot(0);
		const answers = lite.querySelectorAll('[data-role="assistant"]');
		// 只有最终回答进大纲；过程里那句「## 先看看目录」在完整渲染里也不进
		expect(answers).toHaveLength(1);
		const headings = [...answers[0].querySelectorAll(".md h1, .md h2, .md h3, .md h4")].map((h) => `${h.tagName}:${h.textContent}`);
		expect(headings).toEqual(["H2:标题 1", "H3:小节 1"]);
		// 围栏代码块里的 # 行原样留在正文里
		expect(answers[0].textContent).toContain("# 代码里的注释不是标题");
		// 用户消息的跳转锚点还在
		expect(lite.querySelector('[data-role="user"][data-message-id="u1"]')).not.toBeNull();
	});

	it("renders turns appended after the first snapshot in full right away", () => {
		const { rerender } = render(<ChatWindow messages={conversation(12)} tools={{}} isStreaming={false} />);
		rerender(<ChatWindow messages={conversation(14)} tools={{}} isStreaming={false} />);

		expect(isFull(12)).toBe(true);
		expect(isFull(13)).toBe(true);
		// 首屏的占位不受影响
		expect(isFull(0)).toBe(false);
	});
});
