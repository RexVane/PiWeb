// @vitest-environment jsdom
import { useRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preserveChatReadingPosition, useChatReadingAnchor } from "@/components/chat/reading-anchor";

const shouldPin = () => false;
function Harness() {
	const root = useRef<HTMLDivElement>(null);
	const scroll = useRef<HTMLDivElement>(null);
	useChatReadingAnchor(root, scroll, shouldPin);
	return <div ref={root}><div ref={scroll} data-testid="main-scroller"><p data-testid="paragraph">正在阅读的段落</p></div><div data-testid="other-scroller" /></div>;
}
const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 500, width: 500, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("main conversation reading anchor", () => {
	it("keeps the visible paragraph in place when opening or dragging the right column changes text layout", async () => {
		let resized!: () => void;
		vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
		render(<Harness />);
		const scroller = screen.getByTestId("main-scroller");
		const paragraph = screen.getByTestId("paragraph");
		const other = screen.getByTestId("other-scroller");
		let paragraphY = 990;
		let width = 800;
		scroller.parentElement!.getBoundingClientRect = () => ({ ...rect(0, 500), width });
		scroller.scrollTop = 1000;
		other.scrollTop = 75;
		scroller.getBoundingClientRect = () => rect(0, 500);
		paragraph.getBoundingClientRect = () => rect(paragraphY - scroller.scrollTop, paragraphY - scroller.scrollTop + 140);
		preserveChatReadingPosition();
		width = 500;
		paragraphY += 400;
		resized();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		expect(scroller.scrollTop).toBe(1400);
		expect(paragraph.getBoundingClientRect().top).toBe(-10);
		expect(other.scrollTop).toBe(75);
		preserveChatReadingPosition();
		width = 720;
		paragraphY -= 220;
		resized();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		expect(paragraph.getBoundingClientRect().top).toBe(-10);
	});
});
