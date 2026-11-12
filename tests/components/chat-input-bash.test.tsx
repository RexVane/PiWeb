// @vitest-environment jsdom
/** 输入框没有命令执行模式，感叹号开头的内容也按普通消息发送。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";

afterEach(cleanup);

function renderInput({ isStreaming = false } = {}) {
	const onSend = vi.fn(async () => ({ success: true }));
	const onSteer = vi.fn(async () => ({ success: true }));
	render(
		<ChatInput
			isStreaming={isStreaming}
			model={{ provider: "test", id: "test-model", name: "Test Model" }}
			contextPercent={null}
			contextTokens={null}
			contextWindow={null}
			thinkingLevels={[]}
			models={[]}
			providerNames={{}}
			authByProvider={{}}
			queue={{ steering: [], followUp: [] }}
			onSend={onSend}
			onSteer={onSteer}
			onAbort={vi.fn()}
			onSelectModel={vi.fn()}
			onSelectLevel={vi.fn()}
		/>,
	);
	return { onSend, onSteer, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

describe("ChatInput 感叹号作为普通消息", () => {
	it.each(["!git status", "!!cat secrets.txt"])("%s 保留原文，通过普通消息发送", async (text) => {
		const { textarea, onSteer, onSend } = renderInput();
		fireEvent.change(textarea, { target: { value: text } });
		expect(screen.queryByTestId("composer-bash-hint")).toBeNull();
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onSend).toHaveBeenCalledWith(text, []));
		expect(onSteer).not.toHaveBeenCalled();
		await waitFor(() => expect(textarea.value).toBe(""));
	});

	it("回合进行中按普通消息插话", async () => {
		const { textarea, onSend, onSteer } = renderInput({ isStreaming: true });
		fireEvent.change(textarea, { target: { value: "!ls" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onSteer).toHaveBeenCalledWith("!ls", []));
		expect(onSend).not.toHaveBeenCalled();
	});

	it("Markdown 图片语法也保持原文发送", async () => {
		const image = renderInput();
		fireEvent.change(image.textarea, { target: { value: "![图](https://example.com/a.png) 这里报错" } });
		fireEvent.keyDown(image.textarea, { key: "Enter" });
		await waitFor(() => expect(image.onSend).toHaveBeenCalledWith("![图](https://example.com/a.png) 这里报错", []));
	});
});
