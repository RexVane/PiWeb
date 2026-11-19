// @vitest-environment jsdom
/** Queue editing is isolated from the main draft and preserves typed edits across queue updates. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";
import type { WebQueue } from "@/lib/types";

afterEach(cleanup);
const token = (n: number) => String(n).padStart(64, "0");
function renderQueued(queue: WebQueue, options: { isStreaming?: boolean; onSendQueueNow?: () => Promise<any> | any; onEditQueue?: () => Promise<any> | any } = {}) {
	queue = { ...queue, editTokens: queue.editTokens ?? { steering: queue.steering.map((_, i) => token(i + 1)), followUp: queue.followUp.map((_, i) => token(i + 100)) } };
	const onClearQueue = vi.fn(async () => ({ success: true, data: queue }));
	const onSendQueueNow = options.onSendQueueNow ?? vi.fn(async () => ({ success: true }));
	const onEditQueue = options.onEditQueue ?? vi.fn(async () => ({ success: true }));
	const props = { isStreaming: options.isStreaming ?? true, model: { provider: "test", id: "test-model", name: "Test Model" }, contextPercent: null,
		contextTokens: null, contextWindow: null, thinkingLevels: [], models: [], providerNames: {}, authByProvider: {}, queue,
		onSend: vi.fn(async () => ({ success: true })), onSteer: vi.fn(async () => ({ success: true })), onAbort: vi.fn(), onClearQueue,
		onSendQueueNow, onEditQueue, onSelectModel: vi.fn(), onSelectLevel: vi.fn() };
	const view = render(<ChatInput {...props} />);
	return { ...view, props, onClearQueue, onSendQueueNow, onEditQueue, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}
const beginEdit = (index = 0) => { fireEvent.click(screen.getAllByRole("button", { name: "编辑待发消息" })[index]); return screen.getByRole("textbox", { name: "编辑待发消息" }) as HTMLTextAreaElement; };

describe("ChatInput inline queue editing", () => {
	it("keeps every recovered image but refuses to send an oversized merged draft after stop", async () => {
		const images = Array.from({ length: 21 }, () => ({ type: "image" as const, data: "YQ==", mimeType: "image/png" }));
		const onSend = vi.fn(async () => ({ success: true })); const onSteer = vi.fn(async () => ({ success: true }));
		render(<ChatInput isStreaming model={{ provider: "test", id: "test-model", name: "Test" }} contextPercent={null} contextTokens={null} contextWindow={null}
			thinkingLevels={[]} models={[]} providerNames={{}} authByProvider={{}} queue={{ steering: ["Recovered"], followUp: [] }}
			onSend={onSend} onSteer={onSteer} onAbort={async () => ({ success: true, data: { steering: ["Recovered"], followUp: [], images } })} onSelectModel={vi.fn()} onSelectLevel={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "停止" }));
		await waitFor(() => expect(screen.getByText(/取回的图片已全部保留/)).toBeTruthy());
		expect(document.querySelectorAll('img[src^="data:image/png"]')).toHaveLength(21);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		expect(onSend).not.toHaveBeenCalled(); expect(onSteer).not.toHaveBeenCalled();
	});
	it("keeps queued messages in the first area of the composer card", () => {
		const { container } = renderQueued({ steering: ["第一条"], followUp: ["第二条"] });
		const banner = screen.getByTestId("composer-queue");
		expect(container.querySelector(".isx-composer")?.firstElementChild).toBe(banner);
		expect(banner.textContent).toContain("插话"); expect(banner.textContent).toContain("排队");
	});
	it("edits only the selected row; confirm does not clear the queue or touch the main draft", async () => {
		const view = renderQueued({ steering: ["第一条"], followUp: ["第二条"] });
		fireEvent.change(view.textarea, { target: { value: "未发送的草稿" } });
		const editor = beginEdit(1);
		expect(editor.value).toBe("第二条"); expect(document.activeElement).toBe(editor);
		fireEvent.change(editor, { target: { value: "修改后的第二条\n@src/index.ts" } });
		expect(view.textarea.value).toBe("未发送的草稿");
		fireEvent.click(screen.getByRole("button", { name: "确认修改" }));
		await waitFor(() => expect(view.onEditQueue).toHaveBeenCalledWith({ kind: "followUp", index: 0, revision: token(100), text: "修改后的第二条\n@src/index.ts" }));
		await waitFor(() => expect(screen.queryByTestId("queue-inline-editor")).toBeNull());
		expect(view.onClearQueue).not.toHaveBeenCalled(); expect(view.textarea.value).toBe("未发送的草稿");
	});
	it("cancel restores the unchanged row and never sends edits", () => {
		const view = renderQueued({ steering: ["原文"], followUp: [] });
		fireEvent.change(beginEdit(), { target: { value: "不保存" } });
		fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
		expect(screen.getByText("原文")).toBeTruthy(); expect(view.onEditQueue).not.toHaveBeenCalled(); expect(view.onClearQueue).not.toHaveBeenCalled();
	});
	it("retains the edit when earlier messages are delivered, then marks it stale if its own message disappears", async () => {
		const view = renderQueued({ steering: ["先发", "正在改"], followUp: [] });
		fireEvent.change(beginEdit(1), { target: { value: "保留的修改" } });
		view.rerender(<ChatInput {...view.props} queue={{ steering: ["正在改"], followUp: [], editTokens: { steering: [token(2)], followUp: [] } }} />);
		expect((screen.getByRole("textbox", { name: "编辑待发消息" }) as HTMLTextAreaElement).value).toBe("保留的修改");
		expect((screen.getByRole("button", { name: "确认修改" }) as HTMLButtonElement).disabled).toBe(false);
		view.rerender(<ChatInput {...view.props} queue={{ steering: [], followUp: [], editTokens: { steering: [], followUp: [] } }} />);
		expect((screen.getByRole("textbox", { name: "编辑待发消息" }) as HTMLTextAreaElement).value).toBe("保留的修改");
		expect((screen.getByRole("button", { name: "确认修改" }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole("alert").textContent).toContain("当前改动已保留");
	});
	it("keeps failed edits in place for retry", async () => {
		const view = renderQueued({ steering: ["原文"], followUp: [] }, { onEditQueue: vi.fn(async () => ({ success: false, error: "network error" })) });
		fireEvent.change(beginEdit(), { target: { value: "仍然保留" } });
		fireEvent.click(screen.getByRole("button", { name: "确认修改" }));
		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("network error"));
		expect((screen.getByRole("textbox", { name: "编辑待发消息" }) as HTMLTextAreaElement).value).toBe("仍然保留"); expect(view.textarea.value).toBe("");
	});
	it("supports Enter/Escape, Shift+Enter and IME composition without touching composer submission", async () => {
		const view = renderQueued({ steering: ["原文"], followUp: [] });
		const editor = beginEdit(); fireEvent.change(editor, { target: { value: "新文" } });
		fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
		fireEvent.compositionStart(editor); fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
		expect(view.onEditQueue).not.toHaveBeenCalled(); fireEvent.compositionEnd(editor);
		fireEvent.keyDown(editor, { key: "Enter" });
		await waitFor(() => expect(view.onEditQueue).toHaveBeenCalledTimes(1)); expect(view.props.onSteer).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.queryByTestId("queue-inline-editor")).toBeNull());
		fireEvent.keyDown(beginEdit(), { key: "Escape" }); expect(screen.queryByTestId("queue-inline-editor")).toBeNull();
	});
	it("empty-composer ArrowUp edits the latest pending row, without pulling back messages", () => {
		const view = renderQueued({ steering: ["第一条"], followUp: ["最近的消息"] });
		fireEvent.keyDown(view.textarea, { key: "ArrowUp" });
		expect((screen.getByRole("textbox", { name: "编辑待发消息" }) as HTMLTextAreaElement).value).toBe("最近的消息"); expect(view.onClearQueue).not.toHaveBeenCalled();
	});
	it("drop still clears the queue without restoring text", async () => {
		const view = renderQueued({ steering: ["要丢弃的"], followUp: [] });
		fireEvent.click(screen.getByRole("button", { name: "丢弃" }));
		await waitFor(() => expect(view.onClearQueue).toHaveBeenCalledTimes(1)); expect(view.textarea.value).toBe("");
	});
	it("send-now is the last footer button and recovers text on failure", async () => {
		const view = renderQueued({ steering: ["立刻回答"], followUp: [] });
		const buttons = view.container.querySelectorAll(".pw-queue-foot button"); expect(buttons).toHaveLength(2); expect(buttons[1].className).toContain("pw-queue-btn-send");
		fireEvent.click(screen.getByRole("button", { name: "打断并立即发送" })); await waitFor(() => expect(view.onSendQueueNow).toHaveBeenCalledTimes(1));
		cleanup();
		const failed = renderQueued({ steering: ["失败后要保留"], followUp: [] }, { isStreaming: false, onSendQueueNow: vi.fn(async () => ({ success: false, error: "network error", data: { steering: ["失败后要保留"], followUp: [] } })) });
		fireEvent.click(screen.getByRole("button", { name: "立即发送" })); await waitFor(() => expect(failed.textarea.value).toBe("失败后要保留"));
	});
	it("does not render an empty queue", () => { renderQueued({ steering: [], followUp: [] }); expect(screen.queryByTestId("composer-queue")).toBeNull(); });
});
