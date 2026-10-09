// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ChatWindow } from "@/components/chat/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
const messages: WebMessage[] = [
	{ role: "user", id: "u1", timestamp: 1, content: [image, { type: "text", text: "first question" }] },
	{ role: "assistant", id: "a1", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "first answer" }] },
	{ role: "user", id: "u2", timestamp: 3, content: [{ type: "text", text: "second question" }] },
	{ role: "assistant", id: "a2", timestamp: 4, stopReason: "stop", content: [{ type: "text", text: "second answer" }] },
];

function setup(extra: Partial<Parameters<typeof ChatWindow>[0]> = {}) {
	const onEditMessage = vi.fn(async () => ({ success: true }));
	const onRecallMessage = vi.fn(async () => ({ success: true }));
	render(
		<ChatWindow
			messages={messages}
			tools={{}}
			roundBadges={new Map([["u1", { commit: "c1", files: 2, add: 3, del: 1 }]])}
			onEditMessage={onEditMessage}
			onRecallMessage={onRecallMessage}
			{...extra}
		/>,
	);
	const bubble = (id: string) => document.querySelector(`[data-message-id="${id}"]`) as HTMLElement;
	return { onEditMessage, onRecallMessage, bubble };
}

describe("editing and withdrawing sent messages", () => {
	it("withdraws the last message straight away when nothing else would be lost", async () => {
		const { onRecallMessage, bubble } = setup();
		fireEvent.click(within(bubble("u2")).getByRole("button", { name: "撤回" }));
		await waitFor(() => expect(onRecallMessage).toHaveBeenCalledWith("u2", "second question", []));
		expect(within(bubble("u2")).queryByRole("group", { name: "撤回" })).toBeNull();
	});

	it("asks first when later turns would leave the conversation or files were changed", async () => {
		const { onRecallMessage, bubble } = setup();
		fireEvent.click(within(bubble("u1")).getByRole("button", { name: "撤回" }));
		expect(onRecallMessage).not.toHaveBeenCalled();
		const confirm = within(bubble("u1")).getByRole("group", { name: "撤回" });
		expect(confirm.textContent).toContain("之后的 1 轮对话会从当前对话移除（会话文件里仍保留）。 已改动的文件不会还原。");
		fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
		expect(within(bubble("u1")).queryByRole("group", { name: "撤回" })).toBeNull();

		fireEvent.click(within(bubble("u1")).getByRole("button", { name: "撤回" }));
		fireEvent.click(within(within(bubble("u1")).getByRole("group", { name: "撤回" })).getByRole("button", { name: "撤回" }));
		await waitFor(() => expect(onRecallMessage).toHaveBeenCalledWith("u1", "first question", [image]));
	});

	it("edits in place with the original images, shows what will be lost, and resends on Enter", async () => {
		const { onEditMessage, bubble } = setup();
		fireEvent.click(within(bubble("u1")).getByRole("button", { name: "编辑" }));
		const editor = within(bubble("u1")).getByRole("textbox", { name: "修改消息" }) as HTMLTextAreaElement;
		expect(editor.value).toBe("first question");
		expect(document.activeElement).toBe(editor);
		expect(within(bubble("u1")).getByText(/之后的 1 轮对话会从当前对话移除/)).toBeTruthy();
		fireEvent.click(within(bubble("u1")).getByRole("button", { name: "移除图片" }));
		fireEvent.change(editor, { target: { value: "first question, rephrased" } });
		fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
		expect(onEditMessage).not.toHaveBeenCalled();
		fireEvent.keyDown(editor, { key: "Enter" });
		await waitFor(() => expect(onEditMessage).toHaveBeenCalledWith("u1", "first question, rephrased", []));
		await waitFor(() => expect(within(bubble("u1")).queryByRole("textbox", { name: "修改消息" })).toBeNull());
	});

	it("keeps the editor open with its content when the resend fails, and Escape cancels", async () => {
		const { bubble } = setup({ onEditMessage: vi.fn(async () => ({ success: false, error: "busy" })) });
		fireEvent.click(within(bubble("u2")).getByRole("button", { name: "编辑" }));
		const editor = within(bubble("u2")).getByRole("textbox", { name: "修改消息" }) as HTMLTextAreaElement;
		fireEvent.change(editor, { target: { value: "changed" } });
		fireEvent.click(within(bubble("u2")).getByRole("button", { name: "发送" }));
		await waitFor(() => expect((within(bubble("u2")).getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false));
		expect(editor.value).toBe("changed");
		fireEvent.keyDown(editor, { key: "Escape" });
		expect(within(bubble("u2")).queryByRole("textbox", { name: "修改消息" })).toBeNull();
		expect(within(bubble("u2")).getByText("second question")).toBeTruthy();
	});

	it("offers no edit or withdraw for a message that is not persisted yet", () => {
		const pending: WebMessage = { role: "user", streamId: "s1", timestamp: 5, content: [{ type: "text", text: "just sent" }] };
		render(<ChatWindow messages={[pending]} tools={{}} onEditMessage={vi.fn()} onRecallMessage={vi.fn()} />);
		expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
		expect(screen.queryByRole("button", { name: "撤回" })).toBeNull();
	});
});
