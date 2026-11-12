// @vitest-environment jsdom
/** 输入框里的 `!` 命令：发送前就把模式显示出来，发送时走 onBash 而不是发给模型 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";

afterEach(cleanup);

function renderInput({ withBash = true, isStreaming = false } = {}) {
	const onSend = vi.fn(async () => ({ success: true }));
	const onSteer = vi.fn(async () => ({ success: true }));
	const onBash = vi.fn(async () => ({ success: true }));
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
			onBash={withBash ? onBash : undefined}
			onSteer={onSteer}
			onAbort={vi.fn()}
			onSelectModel={vi.fn()}
			onSelectLevel={vi.fn()}
		/>,
	);
	return { onSend, onSteer, onBash, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

describe("ChatInput ! 命令", () => {
	it("输入时提示这是命令，发送时直接执行、不发给模型", async () => {
		const { textarea, onBash, onSend } = renderInput();
		expect(screen.queryByTestId("composer-bash-hint")).toBeNull();
		fireEvent.change(textarea, { target: { value: "!git status" } });
		expect(screen.getByTestId("composer-bash-hint").textContent).toContain("直接在工作区运行");
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onBash).toHaveBeenCalledWith("git status", false));
		expect(onSend).not.toHaveBeenCalled();
		await waitFor(() => expect(textarea.value).toBe(""));
	});

	it("!! 的结果不进模型上下文，提示也说明这一点", async () => {
		const { textarea, onBash } = renderInput();
		fireEvent.change(textarea, { target: { value: "!!cat secrets.txt" } });
		expect(screen.getByTestId("composer-bash-hint").textContent).toContain("不发给模型");
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onBash).toHaveBeenCalledWith("cat secrets.txt", true));
	});

	it("回合进行中也是直接执行，不变成插话", async () => {
		const { textarea, onBash, onSteer } = renderInput({ isStreaming: true });
		fireEvent.change(textarea, { target: { value: "!ls" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => expect(onBash).toHaveBeenCalledWith("ls", false));
		expect(onSteer).not.toHaveBeenCalled();
	});

	it("没接 onBash、或开头其实是 Markdown 图片时，照常当消息发", async () => {
		const plain = renderInput({ withBash: false });
		fireEvent.change(plain.textarea, { target: { value: "!git status" } });
		expect(screen.queryByTestId("composer-bash-hint")).toBeNull();
		fireEvent.keyDown(plain.textarea, { key: "Enter" });
		await waitFor(() => expect(plain.onSend).toHaveBeenCalledWith("!git status", []));
		cleanup();

		const image = renderInput();
		fireEvent.change(image.textarea, { target: { value: "![图](https://example.com/a.png) 这里报错" } });
		expect(screen.queryByTestId("composer-bash-hint")).toBeNull();
		fireEvent.keyDown(image.textarea, { key: "Enter" });
		await waitFor(() => expect(image.onSend).toHaveBeenCalledWith("![图](https://example.com/a.png) 这里报错", []));
		expect(image.onBash).not.toHaveBeenCalled();
	});
});
