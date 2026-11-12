// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PermissionSelector } from "@/components/composer/PermissionSelector";

afterEach(cleanup);

it("navigates in the portalled menu without changing permissions until Enter, then restores focus", () => {
	const onChange = vi.fn(async () => ({ success: true }));
	const { container } = render(<PermissionSelector value="standard" onChange={onChange} />);
	const trigger = screen.getByTestId("permission-trigger");
	fireEvent.keyDown(trigger, { key: "ArrowDown" });
	const menu = screen.getByRole("listbox", { name: "权限" });
	expect(container.contains(menu)).toBe(false);
	expect(document.activeElement?.textContent).toContain("常规编辑");
	fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
	expect(document.activeElement?.textContent).toContain("完全访问");
	expect(onChange).not.toHaveBeenCalled();
	fireEvent.keyDown(document.activeElement!, { key: "Enter" });
	expect(onChange).toHaveBeenCalledWith("full");
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(document.activeElement).toBe(trigger);
});

it("closes with Escape and an outside pointer without applying the highlighted option", () => {
	const onChange = vi.fn(async () => ({ success: true }));
	render(<PermissionSelector value="readonly" onChange={onChange} />);
	const trigger = screen.getByTestId("permission-trigger");
	fireEvent.click(trigger);
	fireEvent.keyDown(document.activeElement!, { key: "Escape" });
	expect(document.activeElement).toBe(trigger);
	expect(screen.queryByRole("listbox")).toBeNull();
	fireEvent.click(trigger);
	fireEvent.pointerDown(document.body);
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(onChange).not.toHaveBeenCalled();
});

it("does not mislabel an existing custom tool selection as a preset", () => {
	const onChange = vi.fn(async () => ({ success: true }));
	render(<PermissionSelector value="standard" custom onChange={onChange} />);
	fireEvent.click(screen.getByRole("button", { name: "权限: 自定义" }));
	expect(screen.getByText(/选择权限档位会替换/)).toBeTruthy();
	expect(screen.getAllByRole("option").every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
	fireEvent.click(screen.getByRole("option", { name: /^常规编辑/ }));
	expect(onChange).toHaveBeenCalledWith("standard");
});

it("blocks mouse and keyboard changes while saving", () => {
	const onChange = vi.fn(async () => ({ success: true }));
	render(<PermissionSelector value="readonly" saving onChange={onChange} />);
	const trigger = screen.getByTestId("permission-trigger") as HTMLButtonElement;
	expect(trigger.disabled).toBe(true);
	fireEvent.click(trigger);
	fireEvent.keyDown(trigger, { key: "ArrowDown" });
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(onChange).not.toHaveBeenCalled();
});
