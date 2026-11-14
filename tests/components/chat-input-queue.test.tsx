// @vitest-environment jsdom
/** 排队 / 插话提示条集成在 .isx-composer 顶部，支持取回编辑与丢弃。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";

afterEach(cleanup);

function renderQueued(queue: { steering: string[]; followUp: string[] }, options: { isStreaming?: boolean; onSendQueueNow?: () => Promise<any> | any } = {}) {
	const onClearQueue = vi.fn(async () => ({ success: true, data: queue }));
	const onSendQueueNow = options.onSendQueueNow ?? vi.fn(async () => ({ success: true }));
	const { container } = render(
		<ChatInput
			isStreaming={options.isStreaming ?? true}
			model={{ provider: "test", id: "test-model", name: "Test Model" }}
			contextPercent={null}
			contextTokens={null}
			contextWindow={null}
			thinkingLevels={[]}
			models={[]}
			providerNames={{}}
			authByProvider={{}}
			queue={queue}
			onSend={vi.fn(async () => ({ success: true }))}
			onSteer={vi.fn(async () => ({ success: true }))}
			onAbort={vi.fn()}
			onClearQueue={onClearQueue}
			onSendQueueNow={onSendQueueNow}
			onSelectModel={vi.fn()}
			onSelectLevel={vi.fn()}
		/>,
	);
	return {
		container,
		onClearQueue,
		onSendQueueNow,
		textarea: screen.getByRole("textbox") as HTMLTextAreaElement,
	};
}

describe("ChatInput 排队提示条布局与交互", () => {
	it("keeps every recovered image but refuses to send an oversized merged draft", async () => {
		const images = Array.from({ length: 21 }, () => ({ type: "image" as const, data: "YQ==", mimeType: "image/png" }));
		const onSend = vi.fn(async () => ({ success: true }));
		const onDraftChange = vi.fn();
		render(<ChatInput isStreaming={false} model={{ provider: "test", id: "test-model", name: "Test" }} contextPercent={null} contextTokens={null} contextWindow={null}
			thinkingLevels={[]} models={[]} providerNames={{}} authByProvider={{}} queue={{ steering: ["Recovered"], followUp: [] }}
			onSend={onSend} onSteer={vi.fn()} onAbort={vi.fn()} onSelectModel={vi.fn()} onSelectLevel={vi.fn()} onDraftChange={onDraftChange}
			onClearQueue={async () => ({ success: true, data: { steering: ["Recovered"], followUp: [], images } })} />);
		fireEvent.click(screen.getByRole("button", { name: "↑ 取回编辑" }));
		await waitFor(() => expect(screen.getByText(/取回的图片已全部保留/)).toBeTruthy());
		expect(document.querySelectorAll('img[src^="data:image/png"]')).toHaveLength(21);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		expect(onSend).not.toHaveBeenCalled();
	});
	it("待发消息贴合在 .isx-composer 卡片顶部第一块区域展示", () => {
		const { container } = renderQueued({ steering: ["这个问题有什么区别"], followUp: ["顺便检查下测试"] });
		const card = container.querySelector(".isx-composer");
		const banner = screen.getByTestId("composer-queue");

		expect(card).not.toBeNull();
		expect(card?.firstElementChild).toBe(banner);
		expect(banner.textContent).toContain("插话");
		expect(banner.textContent).toContain("这个问题有什么区别");
		expect(banner.textContent).toContain("排队");
		expect(banner.textContent).toContain("顺便检查下测试");
	});

	it("点击取回编辑会把排队消息填回输入框，点击丢弃只清空队列", async () => {
		const { onClearQueue, textarea } = renderQueued({ steering: ["第一条"], followUp: ["第二条"] });
		const pullBtn = screen.getByRole("button", { name: "↑ 取回编辑" });
		const dropBtn = screen.getByRole("button", { name: "丢弃" });
		expect(pullBtn.getAttribute("title")).toBe("↑ 取回编辑");
		expect(pullBtn.querySelector("svg")).not.toBeNull();
		expect(dropBtn.getAttribute("title")).toBe("丢弃");
		expect(dropBtn.querySelector("svg")).not.toBeNull();

		fireEvent.click(pullBtn);
		await waitFor(() => expect(onClearQueue).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(textarea.value).toBe("第一条\n\n第二条"));

		cleanup();
		const dropped = renderQueued({ steering: ["要丢弃的"], followUp: [] });
		fireEvent.click(screen.getByRole("button", { name: "丢弃" }));
		await waitFor(() => expect(dropped.onClearQueue).toHaveBeenCalledTimes(1));
		expect(dropped.textarea.value).toBe("");
	});

	it("最右侧提供立即发送按钮，触发打断并发送且失败时放回输入框", async () => {
		const { container, onSendQueueNow } = renderQueued({ steering: ["立刻回答这个问题"], followUp: [] });
		const footButtons = container.querySelectorAll(".pw-queue-foot button");
		expect(footButtons).toHaveLength(3);
		expect(footButtons[2].className).toContain("pw-queue-btn-send");

		const sendNowBtn = screen.getByRole("button", { name: "打断并立即发送" });
		expect(sendNowBtn.getAttribute("title")).toBe("打断并立即发送");
		expect(sendNowBtn.querySelector("svg")).not.toBeNull();
		fireEvent.click(sendNowBtn);
		await waitFor(() => expect(onSendQueueNow).toHaveBeenCalledTimes(1));

		cleanup();
		const failed = renderQueued(
			{ steering: ["失败后要保留"], followUp: [] },
			{
				isStreaming: false,
				onSendQueueNow: vi.fn(async () => ({
					success: false,
					error: "network error",
					data: { steering: ["失败后要保留"], followUp: [] },
				})),
			},
		);
		const idleSendBtn = screen.getByRole("button", { name: "立即发送" });
		fireEvent.click(idleSendBtn);
		await waitFor(() => expect(failed.textarea.value).toBe("失败后要保留"));
		expect(screen.getByRole("alert").textContent).toContain("network error");
	});

	it("队列为空时不渲染顶部提示条", () => {
		renderQueued({ steering: [], followUp: [] });
		expect(screen.queryByTestId("composer-queue")).toBeNull();
	});
});
