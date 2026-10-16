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
import { ChatWindow, SessionStatsBar } from "@/components/ChatWindow";
import type { RoundBadge } from "@/components/ChatWindow";
import type { WebMessage, WebStats } from "@/lib/types";

afterEach(cleanup);

const measuredStats: WebStats = { userMessages: 1, assistantMessages: 2, toolCalls: 2, totalMessages: 5,
	tokens: { input: 100, cacheRead: 900, cacheWrite: 0, output: 20, total: 1020 }, cost: 0,
	llmMs: 1250, toolMs: 500, llmTimedSteps: 1, toolTimedCalls: 1, ttftMs: 100, ttftSteps: 1, decodeMs: 200, decodeTokens: 20, decodeSteps: 1 };

describe("session stats measurement scope", () => {
	it("includes cached input and shows timing coverage and live sample counts", () => {
		const { container } = render(<SessionStatsBar stats={measuredStats} />);
		const text = container.textContent;
		expect(text).toContain("输入 1.00K tok · 输出 20 tok");
		expect(text).toContain("缓存命中 90.00%");
		// 括号里的解释（计时覆盖、实时测量步数）不再显示在统计条上
		expect(text).toContain("首 token 平均 0.10s");
		expect(text).not.toContain("条有计时");
		expect(text).not.toContain("实时测量");
		expect(text).toContain("100.00 tok/s");
	});
	it("hides the cache-hit rate when the upstream never reports cache fields", () => {
		// 很多中转 / 自建网关只返回 prompt_tokens 与 completion_tokens，cacheRead/cacheWrite 恒为 0。
		// 那不是「一次都没命中」而是「没有这个数据」，显示 0.00% 会误导用户以为缓存失效。
		const { container } = render(<SessionStatsBar stats={{
			...measuredStats,
			tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 20, total: 1020 },
		}} />);
		expect(container.textContent).not.toContain("缓存命中");
		// 输入 / 输出仍然照常显示
		expect(container.textContent).toContain("输入 1.00K tok · 输出 20 tok");
	});
	it("does not fabricate historical TTFT or speed when only durations are stored", () => {
		const { container } = render(<SessionStatsBar stats={{ ...measuredStats, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, decodeSteps: 0 }} />);
		expect(container.textContent).toContain("LLM 1.25s");
		expect(container.textContent).not.toContain("首 token");
		expect(container.textContent).not.toContain("tok/s");
	});
	// 统计条只有 20px 高:之前改成允许换行(overflow-wrap:anywhere),窄屏折成两行
	// 会把输入卡顶上去。行本身必须保持单行 + 省略号,超出的部分由
	// mobile-fit.css 在手机上改成横向滑动(见 src/lib/remote/assets.json 第 4 条)。
	it("keeps the stats line single-line so it can never push the composer up", () => {
		const { container } = render(<SessionStatsBar stats={measuredStats} />);
		const line = container.querySelector("div.text-center > div")!;
		expect(line.className).toContain("overflow-hidden");
		expect(line.className).toContain("text-ellipsis");
		expect(line.className).toContain("whitespace-nowrap");
		expect(line.className).not.toContain("[overflow-wrap:anywhere]");
	});
});

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
