// @vitest-environment jsdom
/**
 * 用户消息的原地编辑重发：复制图标右边多一个编辑按钮，点开后原地编辑，
 * 点「重新发送」把（本条消息 id, 新文本）交给上层——上层 navigate + prompt 让模型重新回答。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

const userMessage = {
	role: "user",
	id: "entry-1",
	content: [{ type: "text", text: "hello world" }],
	timestamp: 1,
} as unknown as WebMessage;

function renderWindow(onEditMessage?: (entryId: string, text: string) => void) {
	return render(
		<ChatWindow
			messages={[userMessage]}
			tools={{}}
			isStreaming={false}
			onEditMessage={onEditMessage}
		/>,
	);
}

describe("user message edit affordance", () => {
	it("offers edit next to copy and resends the edited text", () => {
		const onEdit = vi.fn();
		renderWindow(onEdit);

		const editButton = screen.getByRole("button", { name: "编辑这条消息" });
		fireEvent.click(editButton);

		const editor = screen.getByRole("textbox", { name: "编辑这条消息" }) as HTMLTextAreaElement;
		expect(editor.value).toBe("hello world");
		fireEvent.change(editor, { target: { value: "hello edited" } });
		fireEvent.click(screen.getByRole("button", { name: "重新发送" }));

		expect(onEdit).toHaveBeenCalledTimes(1);
		expect(onEdit).toHaveBeenCalledWith("entry-1", "hello edited");
	});

	it("keeps the edit button disabled while the draft is unchanged", () => {
		const onEdit = vi.fn();
		renderWindow(onEdit);
		fireEvent.click(screen.getByRole("button", { name: "编辑这条消息" }));
		expect((screen.getByRole("button", { name: "重新发送" }) as HTMLButtonElement).disabled).toBe(true);
		expect(onEdit).not.toHaveBeenCalled();
	});

	it("cancel returns to the plain bubble without notifying the parent", () => {
		const onEdit = vi.fn();
		renderWindow(onEdit);
		fireEvent.click(screen.getByRole("button", { name: "编辑这条消息" }));
		fireEvent.change(screen.getByRole("textbox", { name: "编辑这条消息" }), { target: { value: "changed" } });
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(screen.queryByRole("textbox", { name: "编辑这条消息" })).toBeNull();
		expect(onEdit).not.toHaveBeenCalled();
	});

	it("does not offer editing when the host has no handler", () => {
		renderWindow(undefined);
		expect(screen.queryByRole("button", { name: "编辑这条消息" })).toBeNull();
	});
});
