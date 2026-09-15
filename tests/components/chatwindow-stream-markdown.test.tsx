// @vitest-environment jsdom
/**
 * 流式期间就要按 Markdown 渲染（不是纯文本等回合结束）。
 * 改前 live 分支渲染的是纯文本，`**加粗**` 会原样出现；这里断言流式中就已经是 <strong>。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

const streaming = {
	role: "assistant",
	id: "a1",
	content: [{ type: "text", text: "这是 **加粗** 与 `代码`。\n\n- 列表项\n" }],
	stopReason: "pending",
	timestamp: 1,
} as unknown as WebMessage;

describe("streaming markdown rendering", () => {
	it("renders markdown while the message is still pending", async () => {
		render(<ChatWindow messages={[streaming]} tools={{}} isStreaming />);
		// 节流窗口过后应出现真正的 Markdown 结构
		await waitFor(() => expect(document.querySelector("strong")).toBeTruthy());
		expect(document.querySelector("strong")?.textContent).toBe("加粗");
		expect(document.querySelector("code")?.textContent).toBe("代码");
		expect(document.querySelectorAll("li").length).toBeGreaterThan(0);
		// 不该把 Markdown 记号当纯文本留在界面上
		expect(screen.queryByText(/\*\*加粗\*\*/)).toBeNull();
	});

	it("keeps rendering markdown after the stream settles", async () => {
		const done = { ...streaming, stopReason: "stop" } as unknown as WebMessage;
		const { rerender } = render(<ChatWindow messages={[streaming]} tools={{}} isStreaming />);
		await waitFor(() => expect(document.querySelector("strong")).toBeTruthy());
		rerender(<ChatWindow messages={[done]} tools={{}} isStreaming={false} />);
		await waitFor(() => expect(document.querySelector("strong")?.textContent).toBe("加粗"));
	});
});
