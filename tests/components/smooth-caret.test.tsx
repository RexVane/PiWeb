// @vitest-environment jsdom
/**
 * 滑行光标的兜底：量不出光标位置时必须保留原生光标，不能让用户看不到光标。
 *
 * jsdom 没有排版引擎，正好是「量不出位置」的环境；真实排版下的位置精度要在浏览器里验证。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { SmoothCaret } from "@/components/composer/SmoothCaret";

function Harness() {
	const ref = useRef<HTMLTextAreaElement>(null);
	return (
		<div style={{ position: "relative" }}>
			<textarea ref={ref} defaultValue="hello" />
			<SmoothCaret target={ref} />
		</div>
	);
}

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

function stubPointer(fine: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.includes("fine") ? fine : !fine,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
}

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

afterEach(() => {
	cleanup();
	if (originalRangeRects) Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
	else delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("SmoothCaret", () => {
	it("keeps the native caret when the caret position cannot be measured", async () => {
		stubPointer(true);
		const { container } = render(<Harness />);
		const textarea = container.querySelector("textarea")!;
		const caret = container.querySelector("[data-smooth-caret]")!;

		act(() => textarea.focus());
		await nextFrame();

		expect(textarea.style.caretColor).toBe("");
		expect(caret.hasAttribute("data-visible")).toBe(false);
	});

	it("takes over the caret once a position is measured and hands it back on blur", async () => {
		stubPointer(true);
		const rect = { left: 12, top: 4, right: 12, bottom: 22, width: 0, height: 18, x: 12, y: 4, toJSON: () => ({}) };
		vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([rect] as unknown as DOMRectList);
		Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
		const { container } = render(<Harness />);
		const textarea = container.querySelector("textarea")!;
		const caret = container.querySelector<HTMLElement>("[data-smooth-caret]")!;
		// jsdom 里元素没有尺寸；给输入框一个可视高度，否则光标会被判定为滚出了视野
		Object.defineProperty(textarea, "clientHeight", { value: 100, configurable: true });

		act(() => textarea.focus());
		await nextFrame();
		expect(textarea.style.caretColor).toBe("transparent");
		expect(caret.hasAttribute("data-visible")).toBe(true);
		expect(caret.style.transform).toContain("translate3d(");

		// 选中一段文字时浏览器本来就不画光标：交还原生，自绘光标隐藏
		act(() => {
			textarea.setSelectionRange(0, 3);
			document.dispatchEvent(new Event("selectionchange"));
		});
		await nextFrame();
		expect(textarea.style.caretColor).toBe("");
		expect(caret.hasAttribute("data-visible")).toBe(false);

		act(() => {
			textarea.setSelectionRange(2, 2);
			document.dispatchEvent(new Event("selectionchange"));
		});
		await nextFrame();
		expect(caret.hasAttribute("data-visible")).toBe(true);

		act(() => textarea.blur());
		expect(textarea.style.caretColor).toBe("");
		expect(caret.hasAttribute("data-visible")).toBe(false);
	});

	it("leaves touch devices on the native caret", async () => {
		stubPointer(false);
		vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ left: 0, top: 0, right: 0, bottom: 18, width: 0, height: 18 }] as unknown as DOMRectList);
		const { container } = render(<Harness />);
		const textarea = container.querySelector("textarea")!;

		act(() => textarea.focus());
		await nextFrame();

		expect(textarea.style.caretColor).toBe("");
	});
});
