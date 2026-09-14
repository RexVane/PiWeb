// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ExtensionDialogHost } from "@/components/ExtensionUI";
import type { ExtensionDialog } from "@/hooks/usePiWeb";

afterEach(cleanup);

function makeDialog(overrides: Partial<ExtensionDialog> = {}): ExtensionDialog {
	return { id: "dialog-1", method: "select", title: "Permission Required", ts: Date.now(), ...overrides };
}

describe("ExtensionDialogHost", () => {
	it("renders select options and answers with the clicked value", () => {
		const onAnswer = vi.fn();
		render(
			<ExtensionDialogHost
				dialog={makeDialog({ message: "Allow this command?", options: ["Yes, allow once", "No, deny"] })}
				onAnswer={onAnswer}
			/>,
		);
		expect(screen.getByRole("dialog", { name: "Permission Required" })).toBeTruthy();
		expect(screen.getByText("Allow this command?")).toBeTruthy();
		const list = screen.getByRole("listbox");
		expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["Yes, allow once", "No, deny"]);
		fireEvent.click(within(list).getByRole("option", { name: "Yes, allow once" }));
		expect(onAnswer).toHaveBeenCalledWith("dialog-1", { value: "Yes, allow once" });
	});

	it("renders key-value messages as structured rows", () => {
		render(
			<ExtensionDialogHost
				dialog={makeDialog({ message: "tool : bash\ncommand : ls -la D:/AIApp" })}
				onAnswer={vi.fn()}
			/>,
		);
		expect(screen.getByText("tool")).toBeTruthy();
		expect(screen.getByText("bash")).toBeTruthy();
		expect(screen.getByText("command")).toBeTruthy();
		expect(screen.getByText("ls -la D:/AIApp")).toBeTruthy();
	});

	it("keeps plain prose messages intact when they are not key-value rows", () => {
		render(<ExtensionDialogHost dialog={makeDialog({ method: "confirm", message: "Line one\nLine two" })} onAnswer={vi.fn()} />);
		expect(screen.getByText(/Line one/)).toBeTruthy();
		expect(screen.queryByText("Line one")).toBeNull(); // 整段渲染，不是拆成键值行
	});

	it("answers confirm dialogs with confirmed / cancelled", () => {
		const onAnswer = vi.fn();
		render(<ExtensionDialogHost dialog={makeDialog({ method: "confirm" })} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", { name: "确认" }));
		expect(onAnswer).toHaveBeenCalledWith("dialog-1", { confirmed: true });
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(onAnswer).toHaveBeenCalledWith("dialog-1", { cancelled: true });
	});

	it("submits input dialogs on Enter", () => {
		const onAnswer = vi.fn();
		render(<ExtensionDialogHost dialog={makeDialog({ method: "input", placeholder: "type here" })} onAnswer={onAnswer} />);
		const input = screen.getByPlaceholderText("type here");
		fireEvent.change(input, { target: { value: "hello" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onAnswer).toHaveBeenCalledWith("dialog-1", { value: "hello" });
	});

	it("cancels on Escape", () => {
		const onAnswer = vi.fn();
		render(<ExtensionDialogHost dialog={makeDialog({ options: ["a", "b"] })} onAnswer={onAnswer} />);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onAnswer).toHaveBeenCalledWith("dialog-1", { cancelled: true });
	});

	it("moves the select highlight with arrow keys and confirms with Enter", () => {
		const onAnswer = vi.fn();
		render(<ExtensionDialogHost dialog={makeDialog({ options: ["first", "second"] })} onAnswer={onAnswer} />);
		const dialog = screen.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "ArrowDown" });
		expect(screen.getByRole("option", { name: "second" }).getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(dialog, { key: "Enter" });
		expect(onAnswer).toHaveBeenCalledWith("dialog-1", { value: "second" });
	});

	it("renders nothing without a dialog", () => {
		const { container } = render(<ExtensionDialogHost dialog={null} onAnswer={vi.fn()} />);
		expect(container.firstChild).toBeNull();
	});
});
