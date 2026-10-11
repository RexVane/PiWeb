// @vitest-environment jsdom
/**
 * 「本轮改了 N 个文件」的位置：必须在**模型回复之后**——也就是最终回答那一行的
 * 耗时 / 时间戳后面，而不是挂在用户消息下面（那是改之前的位置）。
 *
 * 这条测试盯的就是位置本身，因为位置正是这次改动的全部内容：
 * 数据来自项目生长的 refs/piweb/rounds，本地仓库没记录过轮次时它不出现，
 * 光靠跑起来看是验证不到的。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import type { RoundBadge } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

afterEach(cleanup);

const userMessage = {
	role: "user",
	id: "entry-1",
	content: [{ type: "text", text: "改一下这个功能" }],
	timestamp: 1000,
} as unknown as WebMessage;

/** isFinalAnswer 要求：有文本、没有 toolCall、stopReason 是正常结束 */
const finalAnswer = {
	role: "assistant",
	id: "assistant-1",
	content: [{ type: "text", text: "改好了。" }],
	stopReason: "stop",
	timestamp: 23_000,
	endedAt: 23_000,
} as unknown as WebMessage;

function renderWindow(options: { badge?: RoundBadge; isStreaming?: boolean } = {}) {
	const badges = new Map<string, RoundBadge>();
	if (options.badge) badges.set("entry-1", options.badge);
	return render(
		<ChatWindow
			messages={[userMessage, finalAnswer]}
			tools={{}}
			isStreaming={options.isStreaming ?? false}
			roundBadges={badges}
			onShowRound={vi.fn()}
		/>,
	);
}

describe("round badge placement", () => {
	it("renders after the final answer's action row, not under the user message", () => {
		renderWindow({ badge: { commit: "abc1234", files: 3, add: 12, del: 4 } });

		const badge = screen.getByTestId("round-badge");
		expect(badge.textContent).toContain("本轮改了 3 个文件");

		const answer = document.querySelector('[data-role="assistant"]');
		const user = document.querySelector('[data-role="user"]');
		expect(answer).not.toBeNull();
		expect(user).not.toBeNull();

		// 位置：在最终回答里，且在被改写之前它所在的地方（用户消息）之外
		expect(answer!.contains(badge)).toBe(true);
		expect(user!.contains(badge)).toBe(false);

		// 顺序：在最终回答的动作行（耗时 / 时间戳那一行）之后
		const actions = answer!.querySelector(".msg-actions");
		expect(actions).not.toBeNull();
		expect(actions!.textContent).toContain("22"); // 耗时 22 秒，动作行确实在
		expect(actions!.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("keeps the +N / −N detail and the click target", () => {
		const onShowRound = vi.fn();
		const badges = new Map<string, RoundBadge>([["entry-1", { commit: "abc1234", files: 2, add: 7, del: 1 }]]);
		render(<ChatWindow messages={[userMessage, finalAnswer]} tools={{}} isStreaming={false} roundBadges={badges} onShowRound={onShowRound} />);

		const badge = screen.getByTestId("round-badge");
		expect(badge.textContent).toContain("+7");
		expect(badge.textContent).toContain("−1");
		badge.click();
		expect(onShowRound).toHaveBeenCalledWith("abc1234");
	});

	it("says so when the round changed nothing", () => {
		renderWindow({ badge: { commit: "abc1234", files: 0, add: 0, del: 0 } });
		expect(screen.getByTestId("round-badge").textContent).toContain("本轮没有改动文件");
	});

	it("shows nothing for a round with no recorded commits", () => {
		renderWindow();
		expect(screen.queryByTestId("round-badge")).toBeNull();
	});

	it("hides the badge while the turn is still streaming", () => {
		renderWindow({ badge: { commit: "abc1234", files: 3, add: 1, del: 1 }, isStreaming: true });
		expect(screen.queryByTestId("round-badge")).toBeNull();
	});
});
