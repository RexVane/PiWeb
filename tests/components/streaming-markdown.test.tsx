// @vitest-environment jsdom
/**
 * 流式平滑渲染：块切分 + 逐帧推进。
 * - 切分只在围栏外空行处发生，围栏内 / 松散列表内部不切，保证流式期间 Markdown 结构正确；
 * - 推进保证「显示内容始终是目标前缀、单调增长、最终追平」，即文字是平滑长出来的，不会倒退或卡住。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { StreamingMarkdownBlock, splitStreamingMarkdown } from "@/components/MarkdownBlock";

afterEach(cleanup);

describe("splitStreamingMarkdown", () => {
	it("在围栏外空行处切出稳定块，尾巴保留最后一段", () => {
		const { blocks, tail, tailInFence } = splitStreamingMarkdown("第一段。\n\n第二段\n\n第三段在写");
		expect(blocks).toEqual(["第一段。\n\n", "第二段\n\n"]);
		expect(tail).toBe("第三段在写");
		expect(tailInFence).toBe(false);
	});

	it("代码围栏内的空行不切块，并标记 tailInFence", () => {
		const text = "说明：\n\n```python\ndef f():\n\n    return 1\n";
		const { blocks, tail, tailInFence } = splitStreamingMarkdown(text);
		expect(blocks).toEqual(["说明：\n\n"]);
		expect(tail).toBe("```python\ndef f():\n\n    return 1\n");
		expect(tailInFence).toBe(true);
	});

	it("围栏闭合后不再是 tailInFence", () => {
		const text = "```js\nlet a = 1;\n```\n\n后面";
		const { blocks, tail, tailInFence } = splitStreamingMarkdown(text);
		expect(blocks).toEqual(["```js\nlet a = 1;\n```\n\n"]);
		expect(tail).toBe("后面");
		expect(tailInFence).toBe(false);
	});

	it("松散有序列表内部的空行不切块（序号不重排）", () => {
		const { blocks, tail } = splitStreamingMarkdown("1. 甲\n\n2. 乙\n");
		expect(blocks).toEqual([]);
		expect(tail).toBe("1. 甲\n\n2. 乙\n");
	});

	it("段落 -> 列表 的边界照常切块", () => {
		const { blocks, tail } = splitStreamingMarkdown("前言。\n\n- 甲\n- 乙\n");
		expect(blocks).toEqual(["前言。\n\n"]);
		expect(tail).toBe("- 甲\n- 乙\n");
	});
});

describe("StreamingMarkdownBlock 平滑推进", () => {
	it("显示内容是目标前缀、单调增长、最终追平", () => {
		vi.useFakeTimers();
		try {
			const target = "abcdefghij".repeat(20); // 200 字符
			const { container, rerender } = render(<StreamingMarkdownBlock text={target.slice(0, 20)} />);
			rerender(<StreamingMarkdownBlock text={target} />);
			let prev = container.textContent ?? "";
			for (let i = 0; i < 60; i += 1) {
				act(() => { vi.advanceTimersByTime(16); });
				const now = container.textContent ?? "";
				expect(target.startsWith(now)).toBe(true);
				expect(now.length).toBeGreaterThanOrEqual(prev.length);
				prev = now;
			}
			expect(prev).toBe(target);
		} finally {
			vi.useRealTimers();
		}
	});
});
