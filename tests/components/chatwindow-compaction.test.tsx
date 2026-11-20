// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

/** Markdown 在 ChatWindow 里是懒加载分块，首次呈现要现场转换整个依赖图 */
const MARKDOWN_READY_TIMEOUT_MS = 20_000;

const text = (value: string) => [{ type: "text" as const, text: value }];
const marker: WebMessage = { role: "summary", id: "c1", summaryKind: "compaction", automaticCompaction: true, summary: "**摘要正文**", tokensBefore: 12345, content: [], timestamp: 3 };

function order(container: HTMLElement): string[] {
	return [...container.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="summary"], [data-role="assistant"], [data-role="modelChange"]')].map((node) => node.dataset.role!);
}

describe("chat timeline notices", () => {
	it("shows one inline compaction notice and keeps earlier messages editable", () => {
		const messages: WebMessage[] = [
			{ role: "user", id: "u1", content: text("压缩前的问题"), timestamp: 1 },
			{ role: "assistant", id: "a1", content: text("压缩前的回答"), stopReason: "stop", timestamp: 2 },
			marker,
			{ role: "user", id: "u2", content: text("压缩后的问题"), timestamp: 4 },
			{ role: "assistant", id: "a2", content: text("压缩后的回答"), stopReason: "stop", timestamp: 5 },
		];
		const { container } = render(<ChatWindow messages={messages} tools={{}} isStreaming={false} onEditMessage={vi.fn()} />);

		expect(screen.getAllByText("上下文已自动压缩")).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "查看摘要" })).toBeNull();
		expect(order(container)).toEqual(["user", "assistant", "summary", "user", "assistant"]);
		expect(screen.getAllByRole("button", { name: "编辑这条消息" })).toHaveLength(2);
	});

	it("keeps the status between tool activity and the following response", () => {
		const messages: WebMessage[] = [
			{ role: "user", id: "u1", content: text("长任务"), timestamp: 1 },
			{ role: "assistant", id: "a1", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }], stopReason: "toolUse", timestamp: 2 },
			marker,
			{ role: "assistant", id: "a2", content: text("做完了"), stopReason: "stop", timestamp: 4 },
		];
		const { container } = render(<ChatWindow messages={messages} tools={{}} isStreaming={false} />);
		expect(order(container)).toEqual(["user", "summary", "assistant"]);
	});

	it("can still expand a branch summary", async () => {
		const branch: WebMessage = { role: "summary", id: "b1", summaryKind: "branch", summary: "试过方案 B", content: [] };
		render(<ChatWindow messages={[{ role: "user", id: "u1", content: text("q"), timestamp: 1 }, branch]} tools={{}} isStreaming={false} />);
		expect(screen.getByText("分支摘要")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "查看摘要" }));
		await waitFor(() => expect(screen.getByText("试过方案 B")).toBeTruthy(), { timeout: MARKDOWN_READY_TIMEOUT_MS });
	}, 30_000);

	it("renders errors with selectable text and an explicit close button", () => {
		const onClearError = vi.fn();
		render(<ChatWindow messages={[]} tools={{}} isStreaming={false} error="request failed (500)" onClearError={onClearError} />);
		const alert = screen.getByRole("alert");
		expect(alert.tagName).toBe("DIV");
		expect(alert.textContent).toContain("request failed (500)");
		fireEvent.click(alert);
		expect(onClearError).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "关闭" }));
		expect(onClearError).toHaveBeenCalledTimes(1);
	});

	it("replaces the animated compaction status with a static timeline row", () => {
		const messages: WebMessage[] = [{ role: "user", id: "u1", content: text("q"), timestamp: Date.now() }];
		const { container, rerender } = render(
			<ChatWindow messages={messages} tools={{}} isStreaming={true} compaction={{ phase: "start", ts: 1 }} />,
		);
		const progress = screen.getByText("正在压缩上下文 · 可能需要几分钟");
		expect(progress.classList.contains("pw-shimmer")).toBe(true);
		expect(container.querySelectorAll(".pw-shimmer")).toHaveLength(1);
		expect(container.querySelector(".pw-toast-card")).toBeNull();

		rerender(<ChatWindow messages={[...messages, marker]} tools={{}} isStreaming={false} />);
		expect(screen.getAllByText("上下文已自动压缩")).toHaveLength(1);
		expect(container.querySelector(".pw-shimmer")).toBeNull();
		expect(order(container)).toEqual(["user", "summary"]);
	});

	it("shows the two model names at the point where the model switched", () => {
		const notice: WebMessage = {
			role: "modelChange", id: "m1", content: [],
			modelChange: {
				from: { provider: "openai", id: "astra", name: "GPT-6.2 Astra" },
				to: { provider: "openai", id: "sol", name: "GPT-6.2 Sol" },
			},
		};
		const { container } = render(<ChatWindow messages={[
			{ role: "user", id: "u1", content: text("q"), timestamp: 1 },
			notice,
			{ role: "user", id: "u2", content: text("q2"), timestamp: 3 },
		]} tools={{}} isStreaming={false} />);

		expect(screen.getByText("模型已从 GPT-6.2 Astra 更改为 GPT-6.2 Sol。")).toBeTruthy();
		expect(screen.getByTitle("openai/astra → openai/sol")).toBeTruthy();
		expect(screen.queryByText("上下文已压缩")).toBeNull();
		expect(order(container)).toEqual(["user", "modelChange", "user"]);
	});
});
