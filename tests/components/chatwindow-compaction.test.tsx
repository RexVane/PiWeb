// @vitest-environment jsdom
/**
 * 压缩分隔卡：压缩前的消息照常显示（还能编辑），卡片夹在中间说明「以上内容模型只看得到摘要」，
 * 摘要可展开；压缩切在回合中间时，卡片后面的助手消息另起一个回合，不并回卡片上方。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

/** Markdown 在 ChatWindow 里是懒加载分块，首次呈现要现场转换整个依赖图 */
const MARKDOWN_READY_TIMEOUT_MS = 20_000;

const text = (value: string) => [{ type: "text" as const, text: value }];
const marker: WebMessage = { role: "summary", id: "c1", summaryKind: "compaction", summary: "**摘要正文**", tokensBefore: 12345, content: [], timestamp: 3 };

function order(container: HTMLElement): string[] {
	return [...container.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="summary"], [data-role="assistant"]')].map((node) => node.dataset.role!);
}

describe("compaction divider", () => {
	it("keeps messages above the divider editable and expands the summary", async () => {
		const messages: WebMessage[] = [
			{ role: "user", id: "u1", content: text("压缩前的问题"), timestamp: 1 },
			{ role: "assistant", id: "a1", content: text("压缩前的回答"), stopReason: "stop", timestamp: 2 },
			marker,
			{ role: "user", id: "u2", content: text("压缩后的问题"), timestamp: 4 },
			{ role: "assistant", id: "a2", content: text("压缩后的回答"), stopReason: "stop", timestamp: 5 },
		];
		const { container } = render(<ChatWindow messages={messages} tools={{}} isStreaming={false} onEditMessage={vi.fn()} />);

		expect(screen.getByText("上下文已压缩 · 压缩前约 12.35K tokens")).toBeTruthy();
		expect(screen.getByText("以上内容模型只看得到摘要")).toBeTruthy();
		expect(order(container)).toEqual(["user", "assistant", "summary", "user", "assistant"]);
		expect(screen.getAllByRole("button", { name: "编辑这条消息" })).toHaveLength(2);

		fireEvent.click(screen.getByRole("button", { name: "查看摘要" }));
		expect(screen.getByRole("button", { name: "收起摘要" }).getAttribute("aria-expanded")).toBe("true");
		await waitFor(() => expect(screen.getByText("摘要正文")).toBeTruthy(), { timeout: MARKDOWN_READY_TIMEOUT_MS });
	}, 30_000);

	it("starts a new turn after the divider when compaction cut a turn in half", () => {
		const messages: WebMessage[] = [
			{ role: "user", id: "u1", content: text("长任务"), timestamp: 1 },
			{ role: "assistant", id: "a1", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }], stopReason: "toolUse", timestamp: 2 },
			marker,
			{ role: "assistant", id: "a2", content: text("做完了"), stopReason: "stop", timestamp: 4 },
		];
		const { container } = render(<ChatWindow messages={messages} tools={{}} isStreaming={false} />);
		expect(order(container)).toEqual(["user", "summary", "assistant"]);
	});

	it("labels branch summaries separately", () => {
		const branch: WebMessage = { role: "summary", id: "b1", summaryKind: "branch", summary: "试过方案 B", content: [] };
		render(<ChatWindow messages={[{ role: "user", id: "u1", content: text("q"), timestamp: 1 }, branch]} tools={{}} isStreaming={false} />);
		expect(screen.getByText("分支摘要")).toBeTruthy();
		expect(screen.queryByText("以上内容模型只看得到摘要")).toBeNull();
	});
});
