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

	it("allows resending the unchanged text from the taken-back editor", () => {
		// 「取回编辑」的语义是把消息收回来重发：内容没变也可能是想在同一位置重跑一遍，
		// 所以未修改不再禁用按钮，点下去照常把原文交回上层。
		const onEdit = vi.fn();
		renderWindow(onEdit);
		fireEvent.click(screen.getByRole("button", { name: "编辑这条消息" }));

		const resend = screen.getByRole("button", { name: "重新发送" }) as HTMLButtonElement;
		expect(resend.disabled).toBe(false);
		fireEvent.click(resend);
		expect(onEdit).toHaveBeenCalledWith("entry-1", "hello world");
	});

	it("keeps the resend button disabled while the draft is empty", () => {
		const onEdit = vi.fn();
		renderWindow(onEdit);
		fireEvent.click(screen.getByRole("button", { name: "编辑这条消息" }));
		fireEvent.change(screen.getByRole("textbox", { name: "编辑这条消息" }), { target: { value: "   " } });
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

	it("keeps showing the attached images while editing", () => {
		// 编辑只改文字，图片由服务端从原消息带进重发；编辑框里图不能消失，否则看着像被丢了
		const withImage = {
			...userMessage,
			content: [{ type: "text", text: "看图" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
		} as unknown as WebMessage;
		const { container } = render(<ChatWindow messages={[withImage]} tools={{}} isStreaming={false} onEditMessage={vi.fn()} />);
		const imageCount = () => container.querySelectorAll('[data-role="user"] img[src^="data:image/png"]').length;
		expect(imageCount()).toBe(1);
		fireEvent.click(screen.getByRole("button", { name: "编辑这条消息" }));
		expect(screen.getByRole("textbox", { name: "编辑这条消息" })).toBeTruthy();
		expect(imageCount()).toBe(1);
	});

	it("does not offer editing when the host has no handler", () => {
		renderWindow(undefined);
		expect(screen.queryByRole("button", { name: "编辑这条消息" })).toBeNull();
	});
});
