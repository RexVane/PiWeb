// @vitest-environment jsdom
/**
 * 额度显示必须和"配置的提供商"在同一张卡片框内（改前它是卡片框外面的并列兄弟，
 * 视觉上像悬在卡片下面的一行小字）。断言从提供商名找到带边框的卡片元素，
 * 再检查额度行是它的后代——改前这条会失败。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));
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
		if (url === "/api/security") return response({ defaultProjectTrust: "ask" });
		if (url === "/api/version") return response({ piWeb: "0.test", piEngine: "0.test" });
		if (url === "/api/web-auth") return response({ enabled: false });
		throw new Error(`unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	render(<SettingsPanel open cwd="/test-workspace" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "模型" }));
	return fetchMock;
}

describe("provider usage inside the provider card", () => {
	it("renders quota windows inside the same frame as the provider card", async () => {
		setup({ kind: "quota", planType: "pro", windows: [{ limitWindowSeconds: 7 * 24 * 60 * 60, remainingPercent: 42, resetAt: new Date(Date.now() + 3_600_000).toISOString() }], probedAt: Date.now() });

		await waitFor(() => expect(screen.getByText(/额度剩余 42%/)).toBeTruthy());
		const usage = screen.getByText(/额度剩余 42%/);
		const name = screen.getByText("DeepSeek");
		const card = name.closest(`div[style*="${CARD_BORDER}"]`);
		expect(card).not.toBeNull();
		// 关键：额度行在这个提供商的卡片框内部，而不是框外的兄弟节点
		expect(card!.contains(usage)).toBe(true);
		// 同框内还应该找得到该提供商的名称与凭据来源
		expect(card!.textContent).toContain("DeepSeek");
		expect(card!.textContent).toContain("额度剩余");
	});

	it("keeps balance rows inside the card as well", async () => {
		setup({ kind: "balance", primary: { amount: "12.34", currency: "USD" }, details: [{ key: "granted", amount: "10.00" }], probedAt: Date.now() });

		await waitFor(() => expect(screen.getByText(/12\.34/)).toBeTruthy());
		const usage = screen.getByText(/12\.34/);
		const card = screen.getByText("DeepSeek").closest(`div[style*="${CARD_BORDER}"]`);
		expect(card!.contains(usage)).toBe(true);
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
