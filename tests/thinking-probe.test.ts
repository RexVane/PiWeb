import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	analyzeThinkingProbe,
	parseCompletionTokens,
	parseReasoningTokens,
	probeThinkingLevels,
	responseFingerprint,
	suggestLevelMap,
	supportedThinkingLevelsOf,
	validateThinkingLevelMap,
	type ThinkingProbeAttempt,
} from "../src/lib/thinking-probe";

type PiModel = Parameters<typeof getSupportedThinkingLevels>[0];
const piModel = (reasoning: boolean, thinkingLevelMap?: Record<string, string | null>): PiModel =>
	({ id: "m", provider: "p", api: "openai-completions", reasoning, thinkingLevelMap } as unknown as PiModel);

function attempt(level: string, over: Partial<ThinkingProbeAttempt> = {}): ThinkingProbeAttempt {
	return {
		level,
		phase: "behavior",
		ok: true,
		reasoningTokens: null,
		completionTokens: null,
		backend: "resp-hex · m",
		latencyMs: 100,
		...over,
	};
}

describe("parse helpers", () => {
	it("extracts reasoning and completion tokens from OpenAI-style usage", () => {
		expect(parseReasoningTokens({ completion_tokens_details: { reasoning_tokens: 17 } })).toBe(17);
		expect(parseReasoningTokens({})).toBeNull();
		expect(parseReasoningTokens("nope")).toBeNull();
		expect(parseCompletionTokens({ completion_tokens: 42 })).toBe(42);
		expect(parseCompletionTokens(null)).toBeNull();
	});
});

describe("responseFingerprint", () => {
	it("classifies id shapes and keeps the echoed model", () => {
		expect(responseFingerprint("resp_0217950890abcdef", "deepseek-v4.1-flash")).toBe("resp-hex · deepseek-v4.1-flash");
		expect(responseFingerprint("resp_03AaHzpeAvwKi7Kw", "deepseek-v4.1-flash")).toBe("resp-uuid · deepseek-v4.1-flash");
		expect(responseFingerprint("chatcmpl-56a9613a", "commandcode/deepseek")).toBe("chatcmpl · commandcode/deepseek");
		expect(responseFingerprint("", undefined)).toBe("unknown · ?");
	});
});

describe("supportedThinkingLevelsOf mirrors pi-ai", () => {
	it("matches getSupportedThinkingLevels for every shape", () => {
		const shapes = [
			piModel(false),
			piModel(true),
			piModel(true, { xhigh: "xhigh" }),
			piModel(true, { xhigh: null }),
			piModel(true, { off: "none", minimal: null, low: "low", high: "high", xhigh: "high", max: null }),
		];
		for (const m of shapes) {
			const map = "thinkingLevelMap" in m ? (m as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap : undefined;
			expect(supportedThinkingLevelsOf(m.reasoning, map)).toEqual(getSupportedThinkingLevels(m));
		}
	});
});

describe("validateThinkingLevelMap", () => {
	it("normalizes valid maps and rejects everything else", () => {
		expect(validateThinkingLevelMap({ off: "none", low: "low", max: null })).toEqual({ off: "none", low: "low", max: null });
		expect(validateThinkingLevelMap({})).toEqual({});
		expect(validateThinkingLevelMap({ low: " low " })).toEqual({ low: "low" });
		expect(validateThinkingLevelMap({ bogus: "x" })).toBeNull();
		expect(validateThinkingLevelMap({ low: 3 })).toBeNull();
		expect(validateThinkingLevelMap("x")).toBeNull();
		expect(validateThinkingLevelMap(null)).toBeNull();
		expect(validateThinkingLevelMap({ high: "".padEnd(65, "x") })).toBeNull();
		expect(validateThinkingLevelMap({ high: "a\nb" })).toBeNull();
	});
});

describe("suggestLevelMap", () => {
	it("maps accepted levels to themselves and rejected levels to null", () => {
		expect(suggestLevelMap({ off: true, low: true, high: false, xhigh: false, max: false })).toEqual({ off: "none", minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null });
	});
});

describe("analyzeThinkingProbe", () => {
	it("reports rejected when no level value is accepted", () => {
		const report = analyzeThinkingProbe([attempt("off", { phase: "acceptance", ok: false, status: 400 })], {});
		expect(report.verdict).toBe("rejected");
		expect(report.suggestedMap).toBeNull();
	});

	it("flags multi-upstream endpoints as unstable even when tokens look ordered", () => {
		const attempts = [
			attempt("low", { backend: "a · m", reasoningTokens: 50 }),
			attempt("high", { backend: "b · m", reasoningTokens: 500 }),
		];
		const report = analyzeThinkingProbe(attempts, { low: true, high: true, off: true });
		expect(report.multiUpstream).toBe(true);
		expect(report.verdict).toBe("unstable");
		// 不稳定的端点仍给出映射（拒绝的档位被隐藏），但结论必须警示
		expect(report.suggestedMap).not.toBeNull();
		expect(report.notes[0]).toContain("上游");
	});

	it("detects effective levels when reasoning grows monotonically", () => {
		const attempts = [
			attempt("low", { reasoningTokens: 40 }),
			attempt("low", { reasoningTokens: 60 }),
			attempt("medium", { reasoningTokens: 120 }),
			attempt("high", { reasoningTokens: 300 }),
		];
		const report = analyzeThinkingProbe(attempts, { off: true, low: true, medium: true, high: true, minimal: true, xhigh: false, max: false });
		expect(report.verdict).toBe("effective");
		expect(report.suggestedMap).toEqual({ off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null });
	});

	it("stays inconclusive when tokens do not track the level", () => {
		const attempts = [
			attempt("low", { reasoningTokens: 240 }),
			attempt("medium", { reasoningTokens: 20 }),
			attempt("high", { reasoningTokens: 90 }),
		];
		const report = analyzeThinkingProbe(attempts, { off: true, low: true, medium: true, high: true, minimal: true, xhigh: false, max: false });
		expect(report.verdict).toBe("inconclusive");
	});

	it("stays inconclusive when the endpoint never reports reasoning tokens", () => {
		const report = analyzeThinkingProbe([
			attempt("low", { reasoningTokens: null }),
			attempt("high", { reasoningTokens: null }),
		], { off: true, low: true, high: true, minimal: true, medium: true, xhigh: false, max: false });
		expect(report.verdict).toBe("inconclusive");
	});
});

describe("probeThinkingLevels", () => {
	const fetchOk = (usage = { completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 } }) =>
		vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ id: "resp_0217abc", model: "m", choices: [{ message: { content: "hi" } }], usage }), { status: 200 }));

	it("throws when even the control request fails: no point burning a dozen more", async () => {
		const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
		await expect(probeThinkingLevels({ baseUrl: "https://x.test/v1", modelId: "m", fetchImpl, paceMs: 0 }))
			.rejects.toThrow(/404/);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("probes acceptance for every level value and samples behavior only for accepted low/medium/high", async () => {
		const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
			if (body.reasoning_effort === undefined) return new Response(JSON.stringify({ id: "resp_0217a", model: "m", usage: { completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 1 } } }), { status: 200 });
			if (["low", "medium", "high"].includes(body.reasoning_effort)) return new Response(JSON.stringify({ id: "resp_0217b", model: "m", usage: { completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 7 } } }), { status: 200 });
			return new Response("{}", { status: 400 });
		});
		const report = await probeThinkingLevels({ baseUrl: "https://x.test/v1", modelId: "m", fetchImpl, paceMs: 0, samples: 1 });
		expect(report.accepted).toEqual({ off: false, minimal: false, low: true, medium: true, high: true, xhigh: false, max: false });
		expect(report.attempts.filter((attempt) => attempt.phase === "behavior").map((attempt) => attempt.level)).toEqual(["absent", "low", "medium", "high"]);
		// 控制请求 + 7 个枚举 + 4 个行为采样 = 12
		expect(fetchImpl).toHaveBeenCalledTimes(12);
		expect(report.multiUpstream).toBe(false);
	});

	it("never sends a stored credential anywhere but the configured baseUrl", async () => {
		const fetchImpl = fetchOk();
		await probeThinkingLevels({ baseUrl: "https://x.test/v1/", modelId: "m", headers: { Authorization: "Bearer k" }, fetchImpl, paceMs: 0, samples: 1 });
		for (const call of fetchImpl.mock.calls) expect(String(call[0])).toBe("https://x.test/v1/chat/completions");
	});
});
