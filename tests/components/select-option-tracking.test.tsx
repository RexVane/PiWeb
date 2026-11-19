// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SelectOption } from "@/components/settings/SharedControls";

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;
afterEach(() => {
	cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
	Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
});
const options = [{ value: "one", label: "逐条处理" }, { value: "all", label: "合并处理" }];

it.each(["keyboard", "click"])("allows only one popup after %s activation without mousedown", (method) => {
	const onChange = vi.fn();
	render(<><SelectOption label="First" value="one" options={options} onChange={onChange} />
		<SelectOption label="Second" value="one" options={options} onChange={onChange} /></>);
	const first = screen.getByRole("button", { name: "First" });
	const second = screen.getByRole("button", { name: "Second" });
	fireEvent.click(first);
	expect(screen.getAllByRole("listbox")).toHaveLength(1);
	if (method === "keyboard") fireEvent.keyDown(second, { key: "Enter" });
	else act(() => second.click());
	expect(screen.getAllByRole("listbox")).toHaveLength(1);
	expect(first.getAttribute("aria-expanded")).toBe("false");
	expect(second.getAttribute("aria-expanded")).toBe("true");
	expect(document.activeElement).toBe(within(screen.getByRole("listbox")).getByRole("option", { name: "逐条处理" }));
	expect(onChange).not.toHaveBeenCalled();
});

function openAt(top: number, left = 100) {
	const view = render(<div data-testid="scroller"><SelectOption label="Select" value="one" options={options} onChange={vi.fn()} /></div>);
	const chip = screen.getByRole("button", { name: "Select" });
	const coordinates = { top, left };
	const rect = vi.spyOn(chip, "getBoundingClientRect").mockImplementation(() => ({
		x: coordinates.left, y: coordinates.top, left: coordinates.left, right: coordinates.left + 100,
		top: coordinates.top, bottom: coordinates.top + 32, height: 32, width: 100, toJSON: () => ({}),
	}));
	fireEvent.click(chip);
	return { view, chip, coordinates, rect, menu: screen.getByRole("listbox") };
}

it("tracks the anchor when the inner settings scroller moves, without tracking menu-internal scroll", () => {
	const { coordinates, menu, rect } = openAt(393);
	expect(menu.style.top).toBe("431px");
	coordinates.top += 140;
	fireEvent.scroll(screen.getByTestId("scroller"));
	expect(menu.style.top).toBe("571px");
	expect(parseFloat(menu.style.top) - (coordinates.top + 32)).toBe(6);
	const calls = rect.mock.calls.length;
	fireEvent.scroll(menu);
	expect(rect.mock.calls.length).toBe(calls);
});

it("recomputes placement on resize and clamps the real menu width on a 430px screen", () => {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 430 });
	const { menu, coordinates } = openAt(100, 297);
	expect(menu.style.left).toBe("282px"); // 430 - 8 - 140
	Object.defineProperty(menu, "offsetWidth", { configurable: true, value: 240 });
	fireEvent.resize(window);
	expect(menu.style.left).toBe("182px"); // clamp using actual width, not just minWidth
	expect(parseFloat(menu.style.left) + 240).toBeLessThanOrEqual(422);
	coordinates.top = window.innerHeight - 40;
	fireEvent.resize(window);
	expect(menu.dataset.placement).toBe("top");
	expect(menu.style.top).toBe("");
	expect(parseFloat(menu.style.bottom)).toBe(46);
});

it("tracks content/anchor ResizeObserver changes and removes observers on close", () => {
	let resize!: ResizeObserverCallback;
	const observe = vi.fn();
	const disconnect = vi.fn();
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: ResizeObserverCallback) { resize = callback; }
		observe = observe;
		disconnect = disconnect;
	});
	const { coordinates, menu, view } = openAt(100);
	expect(observe).toHaveBeenCalledWith(menu);
	coordinates.top = 200;
	act(() => resize([], {} as ResizeObserver));
	expect(menu.style.top).toBe("238px");
	view.unmount();
	expect(disconnect).toHaveBeenCalled();
});

it("still closes on outside pointer input and Escape, returning focus to the trigger", () => {
	const { menu, chip } = openAt(100);
	fireEvent.pointerDown(document.body);
	expect(screen.queryByRole("listbox")).toBeNull();
	fireEvent.keyDown(chip, { key: "ArrowDown" });
	fireEvent.keyDown(within(screen.getByRole("listbox")).getByRole("option", { name: "逐条处理" }), { key: "Escape" });
	expect(menu.isConnected).toBe(false);
	expect(document.activeElement).toBe(chip);
});
