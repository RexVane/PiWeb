// @vitest-environment jsdom
/**
 * 设置页的下选芯片：下方放不下时向上翻转。
 * 回归：注释写着「向上翻转」，代码只是把 top 钳到窗口底部上方 40px——靠近底部时只露出第一项，其余落到屏幕外。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SelectOption } from "@/components/SettingsPanel";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const options = ["a", "b", "c", "d", "e", "f"].map((v) => ({ value: v, label: v.toUpperCase() }));

function openAt(top: number) {
	const view = render(<SelectOption value="a" options={options} onChange={vi.fn()} />);
	const chip = view.container.querySelector(".select-chip") as HTMLButtonElement;
	vi.spyOn(chip, "getBoundingClientRect").mockReturnValue({ left: 100, right: 220, top, bottom: top + 30, width: 120, height: 30, x: 100, y: top, toJSON: () => ({}) } as DOMRect);
	fireEvent.click(chip);
	return document.querySelector(".popover") as HTMLElement;
}

describe("SelectOption placement", () => {
	it("opens upward when the chip sits near the bottom of the window", () => {
		const pop = openAt(window.innerHeight - 40);
		expect(pop.dataset.placement).toBe("top");
		expect(pop.style.top).toBe("");
		expect(pop.style.bottom).toBe(`${window.innerHeight - (window.innerHeight - 40 - 6)}px`);
		expect(parseFloat(pop.style.maxHeight)).toBeLessThanOrEqual(280);
	});

	it("opens downward when there is room below", () => {
		const pop = openAt(100);
		expect(pop.dataset.placement).toBe("bottom");
		expect(pop.style.top).toBe(`${100 + 30 + 6}px`);
		expect(pop.style.bottom).toBe("");
	});
});
