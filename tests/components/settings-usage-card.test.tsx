// @vitest-environment jsdom
/**
 * 额度显示必须和"配置的提供商"在同一张卡片框内（改前它是卡片框外面的并列兄弟，
 * 视觉上像悬在卡片下面的一行小字）。断言从提供商名找到带边框的卡片元素，
 * 再检查额度行是它的后代——改前这条会失败。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/theme")>()),
	applyPebrelTheme: () => {},
	loadPebrelTheme: () => "dsh",
	loadThemeMode: () => "system",
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const CARD_BORDER = '0.5px solid var(--dsw-border-l2)';

function response(data: unknown) { return { ok: true, status: 200, json: async () => ({ success: true, data }) }; }

function setup(usagePayload: unknown, providerId = "deepseek", providerName = "DeepSeek") {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/models?custom=1") {
			return response({
				providers: [{ id: providerId, name: providerName, builtIn: true, authReady: true, authConfigured: true, keyManaged: false, authTypes: ["api_key"], apis: ["openai-completions"], modelCount: 1 }],
				customProviders: { content: JSON.stringify({ providers: {} }), revision: "rev-1", secretProviderIds: [] },
			});
		}
		if (url === "/api/models") {
			const body = JSON.parse(String(init?.body));
			if (body.action === "providerUsage") return response({ usage: usagePayload });
			return response({});
		}
		if (url === "/api/pi-settings") return response({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } });
		if (url === "/api/version") return response({ piWeb: "0.test", piEngine: "0.test" });
		if (url === "/api/web-auth") return response({ enabled: false });
		throw new Error(`unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	render(<SettingsPanel open onClose={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "模型" }));
	return fetchMock;
}

describe("provider usage inside the provider card", () => {
	it("renders quota windows inside the same frame as the provider card", async () => {
		setup({ kind: "quota", planType: "pro", windows: [{ limitWindowSeconds: 7 * 24 * 60 * 60, remainingPercent: 42, resetAt: new Date(Date.now() + 3_600_000).toISOString() }], probedAt: Date.now() });

		await waitFor(() => expect(screen.getByText("42%")).toBeTruthy());
		const usage = screen.getByText("42%");
		const name = screen.getByText("DeepSeek");
		const card = name.closest(`div[style*="${CARD_BORDER}"]`);
		expect(card).not.toBeNull();
		// 关键：额度行在这个提供商的卡片框内部，而不是框外的兄弟节点
		expect(card!.contains(usage)).toBe(true);
		// 同框内还能看到套餐徽章、窗口名与重置倒计时
		expect(card!.textContent).toContain("DeepSeek");
		expect(card!.textContent).toContain("周限");
		expect(card!.textContent).toContain("套餐 Pro");
		expect(card!.textContent).toContain("1 小时后刷新");
	});

	it("keeps balance rows inside the card as well", async () => {
		setup({ kind: "balance", primary: { amount: "12.34", currency: "USD" }, details: [{ key: "granted", amount: "10.00" }], probedAt: Date.now() });

		await waitFor(() => expect(screen.getByText(/12\.34/)).toBeTruthy());
		const usage = screen.getByText(/12\.34/);
		const card = screen.getByText("DeepSeek").closest(`div[style*="${CARD_BORDER}"]`);
		expect(card!.contains(usage)).toBe(true);
	});

	it("auto-refreshes with a real probe every minute and again when the tab becomes visible", async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = setup({ kind: "balance", primary: { amount: "12.34", currency: "USD" }, details: [], probedAt: Date.now() });
			const usageCalls = () => fetchMock.mock.calls
				.filter(([url]) => url === "/api/models")
				.map(([, init]) => JSON.parse(String(init?.body)) as { action?: string; force?: boolean })
				.filter((body) => body.action === "providerUsage");

			// 首次探测（允许走服务端缓存）
			for (let i = 0; i < 60 && usageCalls().length === 0; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(50); });
			expect(usageCalls()).toHaveLength(1);
			expect(usageCalls()[0].force).toBe(false);

			// 60 秒后自动刷新必须 force：否则服务端 5 分钟缓存会返回同一份数据，看起来就像没自动刷新
			await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
			expect(usageCalls().length).toBeGreaterThanOrEqual(2);
			expect(usageCalls().at(-1)!.force).toBe(true);

			// 45 秒内连续切回页面不重复发探测
			const before = usageCalls().length;
			await act(async () => {
				document.dispatchEvent(new Event("visibilitychange"));
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(usageCalls()).toHaveLength(before);
		} finally {
			vi.useRealTimers();
		}
	});

	it("adds no second段 for a provider without a usage endpoint", async () => {
		// openai 不在可探测名单里：卡片保持原样，没有分隔线、没有探测按钮
		setup(null, "openai", "OpenAI");
		await waitFor(() => expect(screen.getByText("OpenAI")).toBeTruthy());
		const card = screen.getByText("OpenAI").closest(`div[style*="${CARD_BORDER}"]`) as HTMLElement;
		expect(card.querySelector(`div[style*="border-top"]`)).toBeNull();
		expect(card.textContent).not.toContain("检测配额");
	});

	it("keeps the probe row inside the card even before any data arrives", async () => {
		setup(null);
		await waitFor(() => expect(screen.getByText(/读取提供商的只读用量端点/)).toBeTruthy());
		const usage = screen.getByText(/读取提供商的只读用量端点/);
		const card = screen.getByText("DeepSeek").closest(`div[style*="${CARD_BORDER}"]`);
		expect(card!.contains(usage)).toBe(true);
	});
});

describe("quota dashboard details", () => {
	it("shows the exact request counts and heading a subscription window carries", async () => {
		setup({
			kind: "quota",
			planType: "pro",
			windows: [{ name: "premium", remainingPercent: 31, remaining: 93, limit: 300, resetAt: new Date(Date.now() + 30 * 60_000).toISOString() }],
			probedAt: Date.now(),
		}, "github-copilot", "GitHub Copilot");

		await waitFor(() => expect(screen.getByText("31%")).toBeTruthy());
		expect(screen.getByText("高级请求")).toBeTruthy();
		expect(screen.getByText("剩余 93 / 300")).toBeTruthy();
		expect(screen.getByText("30 分钟后刷新")).toBeTruthy();
		expect(screen.getByText("刚刚更新")).toBeTruthy();
	});

	it("separates the code review window from the ordinary 5-hour window", async () => {
		setup({
			kind: "quota",
			planType: "plus",
			windows: [
				{ limitWindowSeconds: 5 * 3600, remainingPercent: 60 },
				{ limitWindowSeconds: 5 * 3600, name: "codeReview", remainingPercent: 40 },
			],
			extra: { kind: "credits", balance: { amount: "12.50" } },
			probedAt: Date.now(),
		}, "openai-codex", "Codex");

		await waitFor(() => expect(screen.getByText("60%")).toBeTruthy());
		expect(screen.getByText("5 小时 · 代码审查")).toBeTruthy();
		expect(screen.getByText("积分余额")).toBeTruthy();
		// credits 余额不带币种（上游没声明），原样显示数字
		expect(screen.getByText(/额度剩余 12\.50/)).toBeTruthy();
	});

	it("renders the pay-as-you-go pool with its cap", async () => {
		setup({
			kind: "quota",
			windows: [{ limitWindowSeconds: 7 * 86400, remainingPercent: 70 }],
			extra: { kind: "extra", used: { amount: "143.75", currency: "USD" }, limit: { amount: "200.00", currency: "USD" }, remainingPercent: 28 },
			probedAt: Date.now(),
		}, "anthropic", "Claude");

		await waitFor(() => expect(screen.getByText("按量额度")).toBeTruthy());
		expect(screen.getByText("28%")).toBeTruthy();
		expect(screen.getByText("已用 $143.75 · 上限 $200.00")).toBeTruthy();
	});

	it("shows balance structure, spend progress and the daily spend", async () => {
		setup({
			kind: "balance",
			primary: { amount: "12.50", currency: "USD" },
			details: [{ key: "limit", amount: "20.00", currency: "USD" }, { key: "used", amount: "7.50", currency: "USD" }],
			periodSpend: [{ period: "daily", amount: "1.25", currency: "USD" }, { period: "monthly", amount: "7.50", currency: "USD" }],
			probedAt: Date.now(),
		}, "openrouter", "OpenRouter");

		await waitFor(() => expect(screen.getByText("$12.50")).toBeTruthy());
		expect(screen.getByText("已用 $7.50 / 上限 $20.00")).toBeTruthy();
		expect(screen.getByText("今日")).toBeTruthy();
		expect(screen.getByText("$1.25")).toBeTruthy();
		expect(screen.getByText("本月")).toBeTruthy();
	});

	it("draws the granted/topped-up structure as a legend", async () => {
		setup({
			kind: "balance",
			primary: { amount: "25.78", currency: "CNY" },
			details: [{ key: "granted", amount: "20.00", currency: "CNY" }, { key: "toppedUp", amount: "5.78", currency: "CNY" }],
			probedAt: Date.now(),
		});
		await waitFor(() => expect(screen.getByText("¥25.78")).toBeTruthy());
		expect(screen.getByText("赠金")).toBeTruthy();
		expect(screen.getByText("充值")).toBeTruthy();
		expect(screen.getByText("¥20.00")).toBeTruthy();
	});

	it("flags a free-tier or unavailable account in the header", async () => {
		setup({ kind: "balance", primary: { amount: "0.11", currency: "USD" }, details: [], isFreeTier: true, available: false, probedAt: Date.now() }, "openrouter", "OpenRouter");
		await waitFor(() => expect(screen.getByText("免费层")).toBeTruthy());
		expect(screen.getByText("账户当前不可用")).toBeTruthy();
	});

	it("marks a quota that the provider already exhausted", async () => {
		setup({ kind: "quota", planType: "pro", limitReached: true, windows: [{ limitWindowSeconds: 7 * 86400, remainingPercent: 0 }], probedAt: Date.now() });
		await waitFor(() => expect(screen.getByText("额度已用尽")).toBeTruthy());
		expect(screen.getByText("0%")).toBeTruthy();
	});
});
