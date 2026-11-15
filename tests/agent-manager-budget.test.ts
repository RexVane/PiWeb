/**
 * H3 可选单回合预算（默认关闭）+ L7 会话订阅者上限（默认关闭）。
 * 两项都只在 env 显式设置时生效；未设置必须保持原行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, dispose: () => {} }),
}));

import { maxSessionSubscribers, parseAgentBudget, subscribe, trackAgentBudget } from "@/lib/agent-manager";

type Managed = Parameters<typeof trackAgentBudget>[0];

const BUDGET_ENV_NAMES = ["PIWEB_AGENT_MAX_STEPS", "PIWEB_AGENT_MAX_DURATION_MS", "PIWEB_AGENT_TOKEN_BUDGET", "PIWEB_MAX_SESSION_SUBSCRIBERS"] as const;
const saved = new Map(BUDGET_ENV_NAMES.map((name) => [name, process.env[name]]));

function managed(overrides: Record<string, unknown> = {}): Managed {
	const abort = vi.fn(async () => {});
	return {
		sessionPath: "/budget/session.jsonl", cwd: "/budget", session: { abort }, creating: null,
		disposed: false, seq: 0, buffer: [], subscribers: new Set(), lastActive: 0, ...overrides,
	} as unknown as Managed;
}

function errors(m: Managed): string[] {
	return m.buffer.map((frame) => frame.json).filter((json) => json.includes('"type":"error"'));
}

beforeEach(() => {
	for (const name of BUDGET_ENV_NAMES) delete process.env[name];
});

afterEach(() => {
	for (const name of BUDGET_ENV_NAMES) {
		const value = saved.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	vi.useRealTimers();
});

describe("parseAgentBudget", () => {
	it("returns null when no budget env is set (default behaviour)", () => {
		expect(parseAgentBudget({})).toBeNull();
		expect(parseAgentBudget({ PATH: "x" })).toBeNull();
	});

	it("parses positive integer limits and ignores unset/blank fields", () => {
		expect(parseAgentBudget({ PIWEB_AGENT_MAX_STEPS: "2" })).toEqual({ maxSteps: 2, maxDurationMs: undefined, tokenBudget: undefined });
		expect(parseAgentBudget({ PIWEB_AGENT_MAX_DURATION_MS: " 1500 ", PIWEB_AGENT_TOKEN_BUDGET: "10000" })).toEqual({ maxSteps: undefined, maxDurationMs: 1500, tokenBudget: 10000 });
	});

	it("ignores invalid values instead of limiting unexpectedly", () => {
		for (const value of ["0", "-1", "abc", "1.5", "NaN", ""]) {
			expect(parseAgentBudget({ PIWEB_AGENT_MAX_STEPS: value }), value).toBeNull();
			expect(parseAgentBudget({ PIWEB_AGENT_TOKEN_BUDGET: value }), value).toBeNull();
		}
	});
});

describe("trackAgentBudget", () => {
	it("does nothing when budgets are disabled", () => {
		const m = managed();
		trackAgentBudget(m, { type: "agent_start" });
		for (let i = 0; i < 100; i += 1) trackAgentBudget(m, { type: "turn_start" });
		trackAgentBudget(m, { type: "turn_end", message: { usage: { input: 1_000_000, output: 1_000_000 } } });
		expect(errors(m)).toEqual([]);
		expect((m.session as unknown as { abort: ReturnType<typeof vi.fn> }).abort).not.toHaveBeenCalled();
	});

	it("aborts the turn with a clear error when the step limit is exceeded", () => {
		process.env.PIWEB_AGENT_MAX_STEPS = "2";
		const m = managed();
		trackAgentBudget(m, { type: "agent_start" });
		trackAgentBudget(m, { type: "turn_start" });
		trackAgentBudget(m, { type: "turn_start" });
		expect(errors(m)).toHaveLength(0);
		trackAgentBudget(m, { type: "turn_start" });
		const published = errors(m);
		expect(published).toHaveLength(1);
		expect(published[0]).toContain("PIWEB_AGENT_MAX_STEPS=2");
		expect((m.session as unknown as { abort: ReturnType<typeof vi.fn> }).abort).toHaveBeenCalledTimes(1);
		// 只会中止一次，后续事件不再重复报错
		trackAgentBudget(m, { type: "turn_start" });
		expect(errors(m)).toHaveLength(1);
	});

	it("aborts the turn when duration exceeds the configured limit", () => {
		vi.useFakeTimers();
		process.env.PIWEB_AGENT_MAX_DURATION_MS = "1000";
		const m = managed();
		trackAgentBudget(m, { type: "agent_start" }, 0);
		vi.advanceTimersByTime(999);
		expect(errors(m)).toHaveLength(0);
		vi.advanceTimersByTime(1);
		const published = errors(m);
		expect(published).toHaveLength(1);
		expect(published[0]).toContain("PIWEB_AGENT_MAX_DURATION_MS=1000");
		expect((m.session as unknown as { abort: ReturnType<typeof vi.fn> }).abort).toHaveBeenCalledTimes(1);
	});

	it("clears the duration timer on settle so no budget error appears after the turn", () => {
		vi.useFakeTimers();
		process.env.PIWEB_AGENT_MAX_DURATION_MS = "1000";
		const m = managed();
		trackAgentBudget(m, { type: "agent_start" }, 0);
		trackAgentBudget(m, { type: "agent_settled" }, 10);
		vi.advanceTimersByTime(10_000);
		expect(errors(m)).toHaveLength(0);
		expect((m.session as unknown as { abort: ReturnType<typeof vi.fn> }).abort).not.toHaveBeenCalled();
	});

	it("aborts the turn when the token budget is exceeded", () => {
		process.env.PIWEB_AGENT_TOKEN_BUDGET = "100";
		const m = managed();
		trackAgentBudget(m, { type: "agent_start" });
		trackAgentBudget(m, { type: "turn_end", message: { usage: { input: 40, output: 30, cacheRead: 10, cacheWrite: 0 } } });
		expect(errors(m)).toHaveLength(0);
		trackAgentBudget(m, { type: "turn_end", message: { usage: { input: 30, output: 5 } } });
		const published = errors(m);
		expect(published).toHaveLength(1);
		expect(published[0]).toContain("PIWEB_AGENT_TOKEN_BUDGET=100");
		expect((m.session as unknown as { abort: ReturnType<typeof vi.fn> }).abort).toHaveBeenCalledTimes(1);
	});
});

describe("maxSessionSubscribers / subscribe limit", () => {
	it("returns null when the env is unset or invalid (default behaviour)", () => {
		expect(maxSessionSubscribers({})).toBeNull();
		for (const value of ["0", "-2", "abc", ""]) expect(maxSessionSubscribers({ PIWEB_MAX_SESSION_SUBSCRIBERS: value }), value).toBeNull();
		expect(maxSessionSubscribers({ PIWEB_MAX_SESSION_SUBSCRIBERS: "3" })).toBe(3);
	});

	it("keeps the previous behaviour when no limit is configured", () => {
		const m = managed();
		for (let i = 0; i < 10; i += 1) expect(subscribe(m, () => {}, 0)).toBe(true);
		expect(m.subscribers.size).toBe(10);
	});

	it("rejects new subscribers over the configured limit without touching existing ones", () => {
		process.env.PIWEB_MAX_SESSION_SUBSCRIBERS = "2";
		const m = managed();
		expect(subscribe(m, () => {}, 0)).toBe(true);
		expect(subscribe(m, () => {}, 0)).toBe(true);
		expect(subscribe(m, () => {}, 0)).toBe(false);
		expect(m.subscribers.size).toBe(2);
		// 已有订阅重复注册不会因为“满了”被拒
		const existing = [...m.subscribers][0];
		expect(subscribe(m, existing, 0)).toBe(true);
		expect(m.subscribers.size).toBe(2);
	});
});
