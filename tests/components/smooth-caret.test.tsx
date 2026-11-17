// @vitest-environment jsdom
/**
 * 全局滑行光标的兜底：画不准时必须保留原生光标，不能让用户看不到光标。
 *
 * jsdom 没有排版引擎，正好是「量不出位置」的环境；真实排版下的位置精度要在浏览器里验证。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { SmoothCaret } from "@/components/SmoothCaret";

function Harness() {
	return (
		<div>
			<textarea data-testid="area" defaultValue="hello" />
			<input data-testid="search" type="search" defaultValue="query" />
			<input data-testid="check" type="checkbox" />
			<input data-testid="password" type="password" defaultValue="secret" />
			<input data-testid="readonly" type="text" defaultValue="fixed" readOnly />
			<SmoothCaret />
		</div>
	);
}

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

function stubPointer(fine: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.includes("fine") ? fine : !fine,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
}

/** 假装有排版：所有行内矩形都落在输入框里面 */
function stubLayout() {
	const rect = { left: 12, top: 4, right: 12, bottom: 22, width: 0, height: 18, x: 12, y: 4, toJSON: () => ({}) };
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([rect] as unknown as DOMRectList);
	Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
	// 光标位置按「边框盒 + 边框宽度」算，边界判定也读 getBoundingClientRect；jsdom 默认全是 0，这里给个固定盒子。
	const box = { left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100, x: 0, y: 0, toJSON: () => ({}) };
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box as DOMRect);
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
		const { container, getByTestId } = render(<Harness />);
		const textarea = getByTestId("area") as HTMLTextAreaElement;

		act(() => textarea.focus());
		await nextFrame();

		expect(textarea.style.caretColor).toBe("");
		expect(container.querySelector("[data-smooth-caret]")!.hasAttribute("data-visible")).toBe(false);
	});

	it("follows focus across every text field and hands the native caret back", async () => {
		stubPointer(true);
		stubLayout();
		const { container, getByTestId } = render(<Harness />);
		const textarea = getByTestId("area") as HTMLTextAreaElement;
		const search = getByTestId("search") as HTMLInputElement;
		const caret = container.querySelector<HTMLElement>("[data-smooth-caret]")!;

		act(() => textarea.focus());
		await nextFrame();
		expect(textarea.style.caretColor).toBe("transparent");
		expect(caret.hasAttribute("data-visible")).toBe(true);
		expect(caret.style.transform).toContain("translate3d(");

		// 换到搜索框：前一个输入框立刻拿回原生光标，自绘光标跟到新输入框
		act(() => search.focus());
		expect(textarea.style.caretColor).toBe("");
		await nextFrame();
		expect(search.style.caretColor).toBe("transparent");
		expect(caret.hasAttribute("data-visible")).toBe(true);

		// 选中一段文字时浏览器本来就不画光标：交还原生，自绘光标隐藏
		act(() => search.setSelectionRange(0, 3));
		await nextFrame();
		expect(search.style.caretColor).toBe("");
		expect(caret.hasAttribute("data-visible")).toBe(false);

		act(() => search.setSelectionRange(2, 2));
		await nextFrame();
		expect(caret.hasAttribute("data-visible")).toBe(true);

		act(() => search.blur());
		expect(search.style.caretColor).toBe("");
		expect(caret.hasAttribute("data-visible")).toBe(false);
	});

	it("ignores checkboxes, password and read-only fields", async () => {
		stubPointer(true);
		stubLayout();
		const { container, getByTestId } = render(<Harness />);
		const caret = container.querySelector("[data-smooth-caret]")!;

		for (const id of ["check", "password", "readonly"]) {
			const element = getByTestId(id) as HTMLInputElement;
			act(() => element.focus());
			await nextFrame();
			expect(element.style.caretColor, id).toBe("");
			expect(caret.hasAttribute("data-visible"), id).toBe(false);
		}
	});

	it("leaves touch devices on the native caret", async () => {
		stubPointer(false);
		stubLayout();
		const { getByTestId } = render(<Harness />);
		const textarea = getByTestId("area") as HTMLTextAreaElement;

		act(() => textarea.focus());
		await nextFrame();

		expect(textarea.style.caretColor).toBe("");
	});
});
