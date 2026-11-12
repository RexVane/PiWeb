// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ExtensionDialogHost, ExtensionWidgets } from "@/components/ExtensionUI";
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

	it("opens a multi-line editor with the extension's prefill and submits the edited text", () => {
		// ctx.ui.editor()：以前在网页端直接返回 undefined，扩展拿到的是「用户取消了」
		const onAnswer = vi.fn();
		render(<ExtensionDialogHost dialog={makeDialog({ method: "editor", title: "编辑提交说明", prefill: "feat: 第一行\n\n正文" })} onAnswer={onAnswer} />);
		const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
		expect(editor.tagName).toBe("TEXTAREA");
		expect(editor.value).toBe("feat: 第一行\n\n正文");
		fireEvent.change(editor, { target: { value: "fix: 改过的说明" } });
		// 单独的 Enter 是换行，不提交
		fireEvent.keyDown(editor, { key: "Enter" });
		expect(onAnswer).not.toHaveBeenCalled();
		fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
		expect(onAnswer).toHaveBeenCalledWith("dialog-1", { value: "fix: 改过的说明" });
	});

	it("resets the editor text when the next editor request arrives", () => {
		const { rerender } = render(<ExtensionDialogHost dialog={makeDialog({ id: "e1", method: "editor", prefill: "第一份" })} onAnswer={vi.fn()} />);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "用户改过" } });
		rerender(<ExtensionDialogHost dialog={makeDialog({ id: "e2", method: "editor", prefill: "第二份" })} onAnswer={vi.fn()} />);
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("第二份");
	});
});

describe("ExtensionWidgets", () => {
	const widgets = {
		todo: { lines: ["☐ 写测试", "☑ 改实现"], placement: "aboveEditor" as const },
		plan: { lines: ["步骤 2/5"], placement: "belowEditor" as const },
		empty: { lines: [], placement: "aboveEditor" as const },
	};

	it("shows each widget's lines in the slot the extension asked for", () => {
		const { container } = render(<ExtensionWidgets widgets={widgets} placement="aboveEditor" />);
		const blocks = container.querySelectorAll("pre");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].textContent).toBe("☐ 写测试\n☑ 改实现");
		cleanup();
		const below = render(<ExtensionWidgets widgets={widgets} placement="belowEditor" />);
		expect(below.container.querySelector("pre")?.textContent).toBe("步骤 2/5");
	});

	it("renders nothing when no widget targets the slot", () => {
		const { container } = render(<ExtensionWidgets widgets={{ plan: widgets.plan }} placement="aboveEditor" />);
		expect(container.firstChild).toBeNull();
	});
});
