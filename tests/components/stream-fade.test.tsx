// @vitest-environment jsdom
/**
 * 流式淡入：只给刚到达的文字加淡入，不改变内容、不重播、不破坏 Markdown 结构。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StreamingMarkdownBlock } from "@/components/MarkdownBlock";
import { MarkdownActionsProvider } from "@/components/chat/markdown-actions";
import { STREAM_FADE_MS, createStreamFadeTracker, freshUnitsFrom } from "@/lib/chat/stream-fade";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("freshUnitsFrom", () => {
	it("marks only the units that arrived within the fade window as fresh", () => {
		const tracker = createStreamFadeTracker();
		expect(freshUnitsFrom(tracker, 3, 1000)).toBe(0);
		expect(freshUnitsFrom(tracker, 8, 1050)).toBe(0);
		// 第一批已经过了淡入期：前 3 个稳定，后到的 5 个仍然算新
		expect(freshUnitsFrom(tracker, 8, 1000 + STREAM_FADE_MS)).toBe(3);
		expect(freshUnitsFrom(tracker, 12, 1050 + STREAM_FADE_MS)).toBe(8);
		expect(freshUnitsFrom(tracker, 12, 5000)).toBe(12);
	});

	it("is idempotent for a repeated render at the same moment", () => {
		const tracker = createStreamFadeTracker();
		freshUnitsFrom(tracker, 4, 1000);
		const first = freshUnitsFrom(tracker, 9, 1300);
		expect(freshUnitsFrom(tracker, 9, 1300)).toBe(first);
		expect(tracker.marks.filter((mark) => mark.count === 9)).toHaveLength(1);
	});

	it("does not fade a long text that is already there on first render", () => {
		const tracker = createStreamFadeTracker();
		expect(freshUnitsFrom(tracker, 400, 1000)).toBe(400);
		expect(freshUnitsFrom(tracker, 405, 1016)).toBe(400);
	});

	it("survives the unit count shrinking when open syntax closes", () => {
		const tracker = createStreamFadeTracker();
		freshUnitsFrom(tracker, 10, 1000);
		expect(freshUnitsFrom(tracker, 7, 1016)).toBeLessThanOrEqual(7);
		expect(freshUnitsFrom(tracker, 9, 2000)).toBe(7);
	});
});

describe("StreamingMarkdownBlock fade", () => {
	const fresh = (container: HTMLElement) => [...container.querySelectorAll("[data-stream-fresh]")].map((el) => el.textContent);

	it("fades only the newly arrived words and keeps the existing spans mounted", () => {
		const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
		const { container, rerender } = render(<StreamingMarkdownBlock text="Hello world" />);
		expect(container.textContent).toBe("Hello world");
		expect(fresh(container)).toEqual(["Hello ", "world"]);
		const helloSpan = container.querySelector("[data-stream-fresh]");

		clock.mockReturnValue(1000 + STREAM_FADE_MS + 20);
		rerender(<StreamingMarkdownBlock text="Hello world again 丝滑输出" />);

		expect(container.textContent).toBe("Hello world again 丝滑输出");
		// 词间空格归前一个词：「world」变成「world 」，仍是同一个单元
		expect(fresh(container)).toEqual(["again ", "丝滑", "输出"]);
		// 同一个 DOM 节点：已经淡入过的字不会因为重渲染重播动画
		expect(container.querySelector("p span")).toBe(helloSpan);
	});

	it("keeps Markdown structure valid and leaves code blocks alone", () => {
		vi.spyOn(performance, "now").mockReturnValue(1000);
		const { container } = render(<StreamingMarkdownBlock text={"- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\ntail **bold** `inline`"} />);

		for (const parent of container.querySelectorAll("ul, ol, table, thead, tbody, tr")) {
			expect([...parent.children].some((child) => child.tagName === "SPAN"), `${parent.tagName} 里不能直接放 span`).toBe(false);
		}
		expect(container.querySelector("pre span[data-stream-fresh]")).toBeNull();
		expect(container.querySelector("strong")?.textContent).toBe("bold");
	});

	it("still recognises file paths in inline code while streaming", () => {
		vi.spyOn(performance, "now").mockReturnValue(1000);
		const openFile = vi.fn();
		const { container } = render(
			<MarkdownActionsProvider value={{ openFile }}>
				<StreamingMarkdownBlock text={"see `src/lib/pi.ts` here"} />
			</MarkdownActionsProvider>,
		);
		expect(container.querySelector("button.md-file-path")).not.toBeNull();
	});

	it("drops the fade wrappers once the answer has finished", () => {
		vi.spyOn(performance, "now").mockReturnValue(1000);
		const { container, rerender } = render(<StreamingMarkdownBlock text="done text" />);
		expect(container.querySelector("[data-stream-fresh]")).not.toBeNull();
		rerender(<StreamingMarkdownBlock text="done text" live={false} />);
		expect(container.querySelector("[data-stream-fresh]")).toBeNull();
		expect(container.querySelector("p span")).toBeNull();
		expect(container.textContent).toBe("done text");
	});
});
