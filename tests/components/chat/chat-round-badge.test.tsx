// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatWindow, type RoundBadge } from "@/components/chat/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(() => { cleanup(); });

const messages: WebMessage[] = [
	{ id: "u1", role: "user", content: [{ type: "text", text: "把保存按钮改成红色" }], timestamp: 1 },
	{ id: "a1", role: "assistant", content: [{ type: "text", text: "改好了" }], stopReason: "stop", timestamp: 2 },
	{ id: "u2", role: "user", content: [{ type: "text", text: "只是问个问题" }], timestamp: 3 },
	{ id: "a2", role: "assistant", content: [{ type: "text", text: "答案" }], stopReason: "stop", timestamp: 4 },
	{ id: "u3", role: "user", content: [{ type: "text", text: "还没记录的一轮" }], timestamp: 5 },
];

describe("ChatWindow round badges", () => {
	it("shows each round's changes under its first prompt and opens the round on click", () => {
		const badges = new Map<string, RoundBadge>([
			["u1", { commit: "c1", files: 2, add: 12, del: 3 }],
			["u2", { commit: "c2", files: 0, add: 0, del: 0 }],
		]);
		const onShowRound = vi.fn();
		render(<ChatWindow messages={messages} tools={{}} roundBadges={badges} onShowRound={onShowRound} />);
		const shown = screen.getAllByTestId("round-badge");
		expect(shown).toHaveLength(2);
		expect(shown[0].textContent).toMatch(/(本轮改了 2 个文件|This round changed 2 files)\s*\+12\s*−3/);
		expect(shown[1].textContent).toMatch(/本轮没有改动文件|No file changes this round/);
		fireEvent.click(shown[0]);
		expect(onShowRound).toHaveBeenCalledWith("c1");
		// 提问气泡带上 entryId，项目栏「在对话里看」靠它定位
		expect(document.querySelector('[data-role="user"][data-message-id="u3"]')).not.toBeNull();
	});
});
