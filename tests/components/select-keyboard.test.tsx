// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CustomSelect } from "@/components/CustomSelect";
import { SelectOption } from "@/components/SettingsPanel";

afterEach(cleanup);
const options = [{ value: "a", label: "A" }, { value: "b", label: "B", disabled: true }, { value: "c", label: "C" }];
const option = (name: string) => within(screen.getByRole("listbox")).getByRole("option", { name });

describe.each(["custom", "settings"] as const)("%s select keyboard", (kind) => {
	it("keeps long-menu keyboard candidates visible without scrolling an ancestor", () => {
		const longOptions = Array.from({ length: 20 }, (_, index) => ({ value: String(index), label: `Choice ${index}` }));
		const { container } = render(<div data-testid="outer-scroll">{kind === "custom"
			? <CustomSelect value="0" options={longOptions} onChange={vi.fn()} />
			: <SelectOption value="0" options={longOptions} onChange={vi.fn()} />}</div>);
		fireEvent.click(screen.getByRole("button", { name: "Choice 0" }));
		const menu = screen.getByRole("listbox");
		const outer = screen.getByTestId("outer-scroll");
		outer.scrollTop = 173;
		container.scrollTop = 91;
		Object.defineProperties(menu, { clientHeight: { value: 60 }, clientTop: { value: 2 } });
		vi.spyOn(menu, "getBoundingClientRect").mockImplementation(() => ({ top: 100, bottom: 164 } as DOMRect));
		within(menu).getAllByRole("option").forEach((item, index) => {
			vi.spyOn(item, "getBoundingClientRect").mockImplementation(() => ({ top: 102 + index * 20 - menu.scrollTop, bottom: 122 + index * 20 - menu.scrollTop } as DOMRect));
		});
		fireEvent.keyDown(document.activeElement!, { key: "End" });
		expect(document.activeElement).toBe(option("Choice 19"));
		expect(menu.scrollTop).toBe(340);
		fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
		expect(menu.scrollTop).toBe(340);
		fireEvent.keyDown(document.activeElement!, { key: "Home" });
		expect(menu.scrollTop).toBe(0);
		fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
		expect(menu.scrollTop).toBe(340);
		fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
		expect(menu.scrollTop).toBe(0);
		expect(outer.scrollTop).toBe(173);
		expect(container.scrollTop).toBe(91);
	});

	it("opens once, moves through candidates, and commits with Enter", () => {
		const onChange = vi.fn();
		render(kind === "custom" ? <CustomSelect value="a" options={options} onChange={onChange} /> : <SelectOption value="a" options={options} onChange={onChange} />);
		const trigger = screen.getByRole("button", { name: "A" });
		trigger.focus();
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		expect(screen.getByRole("listbox")).toBeTruthy();
		expect(document.activeElement).toBe(option("A"));
		fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
		expect(document.activeElement).toBe(option("C"));
		fireEvent.keyDown(document.activeElement!, { key: "Enter" });
		expect(onChange).toHaveBeenCalledWith("c");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("supports Home/End and consumes Escape before a containing dialog", () => {
		const parentKeyDown = vi.fn();
		render(<div onKeyDown={parentKeyDown}>{kind === "custom" ? <CustomSelect value="a" options={options} onChange={vi.fn()} /> : <SelectOption value="a" options={options} onChange={vi.fn()} />}</div>);
		const trigger = screen.getByRole("button", { name: "A" });
		fireEvent.click(trigger);
		fireEvent.keyDown(document.activeElement!, { key: "End" });
		expect(document.activeElement).toBe(option("C"));
		fireEvent.keyDown(document.activeElement!, { key: "Home" });
		expect(document.activeElement).toBe(option("A"));
		parentKeyDown.mockClear();
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(parentKeyDown).not.toHaveBeenCalled();
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});
});
