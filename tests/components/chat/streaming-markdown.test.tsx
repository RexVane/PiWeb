// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "@/components/chat/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(() => { cleanup(); });

const user: WebMessage = { id: "u1", role: "user", content: [{ type: "text", text: "看看这个项目" }], timestamp: 1 };
// 还在生成：代码块的围栏没收尾
const partial = "## 结构\n\n| 目录 | 作用 |\n| --- | --- |\n| src | 源码 |\n\n运行 `npm test`：\n\n```sh\nnpm te";

describe("streaming answer", () => {
	it("renders headings, tables and code as formatted elements before the message ends", () => {
		const messages: WebMessage[] = [user, { role: "assistant", content: [{ type: "text", text: partial }], stopReason: "pending", streamId: "s1", timestamp: 2 }];
		render(<ChatWindow messages={messages} tools={{}} isStreaming />);
		const live = screen.getByTestId("streaming-markdown");
		expect(within(live).getByRole("heading", { name: "结构" })).toBeTruthy();
		expect(within(live).getByRole("table")).toBeTruthy();
		expect(within(live).getByText("npm test").tagName).toBe("CODE");
		expect(live.querySelector("pre code")?.textContent).toContain("npm te");
		expect(live.querySelector(".md-code-copy button")).toBeTruthy();
		expect(live.textContent).not.toContain("##");
		expect(live.textContent).not.toContain("| --- |");
	});

	it("copies the fenced code through the shared copy action", () => {
		const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		try {
			const messages: WebMessage[] = [user, { role: "assistant", content: [{ type: "text", text: partial }], stopReason: "pending", streamId: "s1", timestamp: 2 }];
			render(<ChatWindow messages={messages} tools={{}} isStreaming />);
			const button = screen.getByTestId("streaming-markdown").querySelector(".md-code-copy button");
			expect(button).toBeTruthy();
			fireEvent.click(button!);
			expect(writeText).toHaveBeenCalledWith(expect.stringContaining("npm te"));
		} finally {
			if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
			else Reflect.deleteProperty(navigator, "clipboard");
		}
	});
});
