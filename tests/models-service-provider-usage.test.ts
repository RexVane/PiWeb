import { describe, expect, it } from "vitest";
import {
	MONTHLY_WINDOW_SECONDS,
	parseAnthropicUsagePayload,
	parseCodexUsagePayload,
	parseCopilotUserPayload,
	parseDeepSeekBalancePayload,
	parseKimiCodingUsagePayload,
	parseMoonshotBalancePayload,
	parseOpencodeUsagePayload,
	parseOpenRouterKeyPayload,
	parseVercelGatewayCreditsPayload,
	planTypeFromAccessToken,
	quotaWindowKind,
	supportsUsageProbe,
	WEEKLY_WINDOW_SECONDS,
} from "../src/lib/models-service";

const FIVE_HOURS = 5 * 60 * 60;

/** 造一个只带 payload 的 JWT；真实 token 用 base64url，这里保持一致。 */
function jwt(claims: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function accessTokenWithPlan(plan: string): string {
	return jwt({ sub: "user", "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: "acct-1" } });
}

function windowOf(seconds: number, usedPercent: number, resetAt = 1_791_823_822): Record<string, unknown> {
	return { used_percent: usedPercent, limit_window_seconds: seconds, reset_after_seconds: resetAt - 1_700_000_000, reset_at: resetAt };
}

describe("codex usage payload", () => {
	it("reads a Go-style payload that only carries a 30-day window", () => {
		// 实测的 Go 套餐形状：secondary_window 是 null，只有一个 30 天窗
		const parsed = parseCodexUsagePayload({
			plan_type: "go",
			rate_limit: { allowed: true, limit_reached: false, primary_window: windowOf(MONTHLY_WINDOW_SECONDS, 15), secondary_window: null },
		});
		expect(parsed.planType).toBe("go");
		expect(parsed.windows).toHaveLength(1);
		expect(parsed.windows[0].limitWindowSeconds).toBe(MONTHLY_WINDOW_SECONDS);
		expect(parsed.windows[0].remainingPercent).toBe(85);
		expect(parsed.windows[0].resetAt).toBe(new Date(1_791_823_822 * 1000).toISOString());
	});

	it("keeps both windows when a plan reports 5-hour and 7-day windows, shortest first", () => {
		const parsed = parseCodexUsagePayload({
			plan_type: "pro",
			rate_limit: { primary_window: windowOf(WEEKLY_WINDOW_SECONDS, 27), secondary_window: windowOf(FIVE_HOURS, 60) },
		});
		expect(parsed.windows.map((w) => w.limitWindowSeconds)).toEqual([FIVE_HOURS, WEEKLY_WINDOW_SECONDS]);
		expect(parsed.windows.map((w) => w.remainingPercent)).toEqual([40, 73]);
	});

	it("accepts a plan that only reports the 7-day window", () => {
		const parsed = parseCodexUsagePayload({ plan_type: "plus", rate_limit: { primary_window: windowOf(WEEKLY_WINDOW_SECONDS, 100) } });
		expect(parsed.windows).toHaveLength(1);
		expect(parsed.windows[0].remainingPercent).toBe(0);
	});

	it("clamps a used percentage that falls outside 0-100", () => {
		const parsed = parseCodexUsagePayload({
			plan_type: "pro",
			rate_limit: { primary_window: windowOf(WEEKLY_WINDOW_SECONDS, -20), secondary_window: windowOf(FIVE_HOURS, 140) },
		});
		expect(parsed.windows.map((w) => w.remainingPercent)).toEqual([0, 100]);
	});

	it("drops a window without a usable percentage but keeps the rest", () => {
		const parsed = parseCodexUsagePayload({
			plan_type: "pro",
			rate_limit: { primary_window: { limit_window_seconds: WEEKLY_WINDOW_SECONDS }, secondary_window: windowOf(FIVE_HOURS, 25) },
		});
		expect(parsed.windows.map((w) => w.limitWindowSeconds)).toEqual([FIVE_HOURS]);
	});

	it("drops a window without a positive duration", () => {
		const parsed = parseCodexUsagePayload({
			plan_type: "pro",
			rate_limit: { primary_window: windowOf(0, 25), secondary_window: { used_percent: 30 } },
		});
		expect(parsed.windows).toEqual([]);
	});

	it("keeps the window but omits the reset time when reset_at is unusable", () => {
		const parsed = parseCodexUsagePayload({
			plan_type: "pro",
			rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: WEEKLY_WINDOW_SECONDS, reset_at: 0 } },
		});
		expect(parsed.windows).toHaveLength(1);
		expect(parsed.windows[0].resetAt).toBeUndefined();
	});

	it("reports nothing rather than guessing for malformed payloads", () => {
		for (const value of [null, undefined, "pro", 42, [], {}, { plan_type: "   ", rate_limit: "nope" }]) {
			expect(parseCodexUsagePayload(value).windows).toEqual([]);
		}
	});

	it("ignores account identifiers and other unrelated fields", () => {
		const parsed = parseCodexUsagePayload({
			user_id: "user-secret",
			account_id: "acct-secret",
			email: "someone@example.com",
			plan_type: "pro",
			rate_limit: { primary_window: windowOf(WEEKLY_WINDOW_SECONDS, 10) },
		});
		expect(Object.keys(parsed).sort()).toEqual(["planType", "windows"]);
	});
});

describe("codex plan type from access token", () => {
	it("reads the plan claim from the OpenAI auth namespace", () => {
		expect(planTypeFromAccessToken(accessTokenWithPlan("go"))).toBe("go");
		expect(planTypeFromAccessToken(accessTokenWithPlan("pro"))).toBe("pro");
	});

	it("returns undefined when the token is not a decodable JWT or lacks the claim", () => {
		expect(planTypeFromAccessToken("not-a-jwt")).toBeUndefined();
		expect(planTypeFromAccessToken("a.b.c")).toBeUndefined();
		expect(planTypeFromAccessToken(jwt({ sub: "user" }))).toBeUndefined();
		expect(planTypeFromAccessToken(jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "  " } }))).toBeUndefined();
	});
});

describe("codex window kind", () => {
	it("names the windows the UI labels as weekly and monthly", () => {
		expect(quotaWindowKind(WEEKLY_WINDOW_SECONDS)).toBe("weekly");
		expect(quotaWindowKind(MONTHLY_WINDOW_SECONDS)).toBe("monthly");
	});

	it("falls back to hours below a day and days otherwise", () => {
		expect(quotaWindowKind(FIVE_HOURS)).toBe("hours");
		expect(quotaWindowKind(24 * 60 * 60)).toBe("days");
		expect(quotaWindowKind(3 * 24 * 60 * 60)).toBe("days");
	});
});

describe("claude usage payload", () => {
	it("maps the three fixed windows Claude reports", () => {
		const parsed = parseAnthropicUsagePayload({
			five_hour: { utilization: 12, resets_at: "2026-09-15T20:00:00.000Z" },
			seven_day: { utilization: 64.4, resets_at: "2026-09-22T16:40:00.000Z" },
			seven_day_opus: { utilization: 90, resets_at: "2026-09-22T16:40:00.000Z" },
		});
		expect(parsed.windows.map((w) => w.limitWindowSeconds)).toEqual([FIVE_HOURS, WEEKLY_WINDOW_SECONDS, WEEKLY_WINDOW_SECONDS]);
		// utilization 是「已用」，剩余要反过来算
		expect(parsed.windows.map((w) => w.remainingPercent)).toEqual([88, 36, 10]);
		// 同为 7 天的两个窗口靠 variant 区分，界面才不会当作同一行
		expect(parsed.windows.map((w) => w.variant)).toEqual([undefined, undefined, "opus"]);
		expect(parsed.windows[0].resetAt).toBe("2026-09-15T20:00:00.000Z");
	});

	it("keeps only the windows the account actually reports", () => {
		const parsed = parseAnthropicUsagePayload({ seven_day: { utilization: 30, resets_at: "2026-09-22T16:40:00.000Z" } });
		expect(parsed.windows).toHaveLength(1);
		expect(parsed.windows[0].limitWindowSeconds).toBe(WEEKLY_WINDOW_SECONDS);
		expect(parsed.windows[0].remainingPercent).toBe(70);
	});

	it("clamps utilization and omits an unparsable reset time", () => {
		const parsed = parseAnthropicUsagePayload({ five_hour: { utilization: 130, resets_at: "not-a-date" } });
		expect(parsed.windows[0].remainingPercent).toBe(0);
		expect(parsed.windows[0].resetAt).toBeUndefined();
	});

	it("reports nothing for malformed payloads", () => {
		for (const value of [null, undefined, "x", 7, [], {}, { five_hour: {} }, { five_hour: { utilization: "12" } }]) {
			expect(parseAnthropicUsagePayload(value).windows).toEqual([]);
		}
	});
});

describe("balance payloads", () => {
	it("reads DeepSeek balances as strings with the account currency", () => {
		const parsed = parseDeepSeekBalancePayload({
			is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
		});
		expect(parsed.primary).toEqual({ amount: "110.00", currency: "CNY" });
		expect(parsed.details).toEqual([
			{ key: "granted", amount: "10.00", currency: "CNY" },
			{ key: "toppedUp", amount: "100.00", currency: "CNY" },
		]);
	});

	it("prefers the remaining credit for OpenRouter keys that have a cap", () => {
		const parsed = parseOpenRouterKeyPayload({ data: { limit: 20, limit_remaining: 12.5, usage: 7.5 } });
		expect(parsed.primary).toEqual({ amount: "12.50", currency: "USD" });
		expect(parsed.primaryKey).toBeUndefined();
		expect(parsed.details).toEqual([
			{ key: "limit", amount: "20.00", currency: "USD" },
			{ key: "used", amount: "7.50", currency: "USD" },
		]);
	});

	it("falls back to cumulative usage for uncapped OpenRouter keys", () => {
		const parsed = parseOpenRouterKeyPayload({ data: { limit: null, limit_remaining: null, usage: 3.25 } });
		expect(parsed.primaryKey).toBe("used");
		expect(parsed.primary).toEqual({ amount: "3.25", currency: "USD" });
		expect(parsed.details).toEqual([{ key: "used", amount: "3.25", currency: "USD" }]);
	});

	it("reads Moonshot balances under the requested currency", () => {
		const payload = { code: 0, status: true, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 } };
		const cn = parseMoonshotBalancePayload(payload, "CNY");
		expect(cn.primary).toEqual({ amount: "49.59", currency: "CNY" });
		expect(cn.details).toEqual([
			{ key: "voucher", amount: "46.59", currency: "CNY" },
			{ key: "cash", amount: "3.00", currency: "CNY" },
		]);
		expect(parseMoonshotBalancePayload(payload, "USD").primary?.currency).toBe("USD");
	});

	it("reports nothing when a balance endpoint answers an error envelope", () => {
		expect(parseMoonshotBalancePayload({ code: 401, status: false, data: { available_balance: 1 } }, "CNY").details).toEqual([]);
		expect(parseDeepSeekBalancePayload({ balance_infos: [] }).details).toEqual([]);
		expect(parseDeepSeekBalancePayload({ balance_infos: [{ currency: "CNY" }] }).primary).toBeUndefined();
		expect(parseOpenRouterKeyPayload({ data: { usage: "abc" } }).primary).toBeUndefined();
	});

	it("never treats a non-numeric amount as zero", () => {
		const parsed = parseDeepSeekBalancePayload({ balance_infos: [{ currency: "USD", total_balance: null, granted_balance: "", topped_up_balance: "NaN" }] });
		expect(parsed.primary).toBeUndefined();
		expect(parsed.details).toEqual([]);
	});
});

describe("usage probe support", () => {
	it("covers the providers with real read-only usage endpoints", () => {
		for (const id of ["xai", "openai-codex", "anthropic", "deepseek", "openrouter", "moonshotai", "moonshotai-cn", "kimi-coding", "github-copilot", "vercel-ai-gateway", "opencode-go"]) {
			expect(supportsUsageProbe(id)).toBe(true);
		}
	});

	it("leaves providers without such an endpoint unprobed", () => {
		for (const id of ["openai", "google", "google-vertex", "azure-openai-responses", "amazon-bedrock", "groq", "mistral", "together", "cerebras", "fireworks", "nvidia", "baseten", "ant-ling", "minimax", "minimax-cn", "huggingface", "zai", "zai-coding-cn", "qwen-token-plan", "qwen-token-plan-cn", "xiaomi-token-plan-cn", "opencode", "cloudflare-workers-ai", "cloudflare-ai-gateway"]) {
			expect(supportsUsageProbe(id)).toBe(false);
		}
	});
});

describe("kimi coding usage", () => {
	it("maps the four fixed keys, with used_ratio as a 0-1 fraction", () => {
		const parsed = parseKimiCodingUsagePayload({
			usages: {
				limit_5h: { used_ratio: 0.3, reset_time: "2026-09-15T18:00:00Z" },
				limit_7d: { used_ratio: 0.2, reset_time: "2026-09-22T00:00:00Z" },
				limit_month_total: { used_ratio: 0.4, reset_time: "2026-10-01T00:00:00Z" },
				limit_month_code: { used_ratio: 0.25, reset_time: "2026-10-01T00:00:00Z" },
			},
		});
		expect(parsed.windows.map((w) => w.limitWindowSeconds)).toEqual([FIVE_HOURS, WEEKLY_WINDOW_SECONDS, MONTHLY_WINDOW_SECONDS, MONTHLY_WINDOW_SECONDS]);
		expect(parsed.windows.map((w) => w.remainingPercent)).toEqual([70, 80, 60, 75]);
		// 两个同周期的月度窗口靠 variant 区分
		expect(parsed.windows.map((w) => w.variant)).toEqual([undefined, undefined, undefined, "code"]);
	});

	it("keeps only the keys the account reports", () => {
		const parsed = parseKimiCodingUsagePayload({ usages: { limit_7d: { used_ratio: 0, reset_time: "2026-09-22T00:00:00Z" } } });
		expect(parsed.windows).toHaveLength(1);
		expect(parsed.windows[0].remainingPercent).toBe(100);
		expect(parseKimiCodingUsagePayload({ usages: {} }).windows).toEqual([]);
		expect(parseKimiCodingUsagePayload({}).windows).toEqual([]);
	});
});

describe("github copilot usage", () => {
	it("reports the plan and per-category remaining entitlement", () => {
		const parsed = parseCopilotUserPayload({
			copilot_plan: "business",
			quota_reset_date: "2026-10-01T00:00:00Z",
			quota_snapshots: {
				chat: { percent_remaining: 88.2, has_quota: true },
				completions: { percent_remaining: 100, has_quota: true },
				premium_interactions: { percent_remaining: 42.6, has_quota: true },
			},
		});
		expect(parsed.planType).toBe("business");
		expect(parsed.windows.map((w) => w.name)).toEqual(["premium", "chat", "completions"]);
		expect(parsed.windows.map((w) => w.remainingPercent)).toEqual([43, 88, 100]);
		// 额度类别没有固定周期，不该编出一个窗口时长
		expect(parsed.windows.every((w) => w.limitWindowSeconds === undefined)).toBe(true);
		expect(parsed.windows[0].resetAt).toBe("2026-10-01T00:00:00.000Z");
	});

	it("skips unlimited and quota-less categories instead of inventing a number", () => {
		const parsed = parseCopilotUserPayload({
			copilot_plan: "individual",
			quota_snapshots: {
				chat: { percent_remaining: 50, unlimited: true },
				completions: { percent_remaining: 50, has_quota: false },
				premium_interactions: { percent_remaining: 50, has_quota: true },
			},
		});
		expect(parsed.windows.map((w) => w.name)).toEqual(["premium"]);
	});

	it("still reports the plan when no snapshot is usable", () => {
		const parsed = parseCopilotUserPayload({ copilot_plan: "pro" });
		expect(parsed.planType).toBe("pro");
		expect(parsed.windows).toEqual([]);
		expect(parseCopilotUserPayload(null).windows).toEqual([]);
	});
});

describe("vercel ai gateway credits", () => {
	it("reads the balance and cumulative usage as USD strings", () => {
		const parsed = parseVercelGatewayCreditsPayload({ balance: "95.50", total_used: "4.50" });
		expect(parsed.primary).toEqual({ amount: "95.50", currency: "USD" });
		expect(parsed.details).toEqual([{ key: "used", amount: "4.50", currency: "USD" }]);
	});

	it("reports nothing for a malformed envelope", () => {
		expect(parseVercelGatewayCreditsPayload({ balance: "n/a" }).primary).toBeUndefined();
		expect(parseVercelGatewayCreditsPayload(undefined).details).toEqual([]);
	});
});

describe("opencode go usage", () => {
	it("inverts the used percentage the endpoint reports", () => {
		const parsed = parseOpencodeUsagePayload({
			usage: {
				rolling: { status: "ok", percent: 12.5, resetsAt: "2026-09-15T20:00:00Z" },
				weekly: { status: "ok", percent: 40, resetsAt: "2026-09-22T00:00:00Z" },
				monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-01T00:00:00Z" },
			},
		});
		// 周期已知的窗口按长短排在前，rolling 因为没有周期被排到最后
		expect(parsed.windows.map((w) => w.remainingPercent)).toEqual([60, 0, 88]);
		expect(parsed.windows.map((w) => w.limitWindowSeconds)).toEqual([WEEKLY_WINDOW_SECONDS, MONTHLY_WINDOW_SECONDS, undefined]);
		expect(parsed.windows[2].name).toBe("rolling");
	});

	it("reports nothing for an entitlement error envelope", () => {
		expect(parseOpencodeUsagePayload({ type: "error", error: { type: "EntitlementError" } }).windows).toEqual([]);
		expect(parseOpencodeUsagePayload({ usage: { rolling: {} } }).windows).toEqual([]);
	});
});
