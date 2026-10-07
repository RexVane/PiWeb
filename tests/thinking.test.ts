import { clampThinkingLevel as piClamp, getSupportedThinkingLevels as piSupported } from "@earendil-works/pi-ai";
import { DEFAULT_THINKING_BUDGETS } from "@earendil-works/pi-ai/api/simple-options";
import { describe, expect, it } from "vitest";
import {
	clampThinkingLevel,
	defaultThinkingFor,
	normalizeThinkingLevelMap,
	PI_DEFAULT_THINKING_BUDGETS,
	supportedThinkingLevels,
	THINKING_LEVELS,
	thinkingMapFromRows,
	thinkingRowsFromMap,
	type ThinkingLevelMap,
} from "../src/lib/thinking";

const maps: Array<ThinkingLevelMap | undefined> = [
	undefined,
	{},
	{ xhigh: "xhigh" },
	{ off: null, minimal: null },
	{ minimal: "low", max: "max", high: null },
	{ low: null, medium: null, high: null, xhigh: null },
];

function model(reasoning: boolean, thinkingLevelMap?: ThinkingLevelMap) {
	return { id: "m", name: "m", api: "openai-completions", provider: "p", baseUrl: "", reasoning, thinkingLevelMap, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 } as never;
}

describe("thinking levels match pi-ai", () => {
	it("lists supported levels exactly like getSupportedThinkingLevels", () => {
		for (const reasoning of [false, true]) {
			for (const map of maps) expect(supportedThinkingLevels(reasoning, map)).toEqual(piSupported(model(reasoning, map)));
		}
	});

	it("clamps exactly like clampThinkingLevel (nearest higher level first, then lower)", () => {
		for (const map of maps) {
			const supported = supportedThinkingLevels(true, map);
			for (const level of [...THINKING_LEVELS, "bogus"]) expect(clampThinkingLevel(level, supported)).toBe(piClamp(model(true, map), level as never));
		}
		expect(clampThinkingLevel("high", ["off"])).toBe("off");
	});

	it("shows pi-ai's built-in thinking budgets as placeholders", () => {
		expect(PI_DEFAULT_THINKING_BUDGETS).toEqual(DEFAULT_THINKING_BUDGETS);
	});
});

describe("default thinking level for a new session or model switch", () => {
	const defaults = { provider: null, modelId: null, thinkingLevel: "low" as const, modelThinkingLevels: { "p/fast": "minimal" as const, "p/deep": "max" as const } };

	it("prefers the per-model level, then the global default, then medium, clamped to the model", () => {
		const all = supportedThinkingLevels(true, { xhigh: "xhigh", max: "max" });
		expect(defaultThinkingFor(defaults, "p", "fast", all)).toBe("minimal");
		expect(defaultThinkingFor(defaults, "p", "other", all)).toBe("low");
		expect(defaultThinkingFor(null, "p", "other", all)).toBe("medium");
		// max 不支持时就近往低钳到 high
		expect(defaultThinkingFor(defaults, "p", "deep", supportedThinkingLevels(true))).toBe("high");
		expect(defaultThinkingFor(defaults, "p", "fast", ["off"])).toBe("off");
	});
});

describe("thinking level table for custom models", () => {
	it("round-trips maps through form rows without changing meaning", () => {
		for (const map of maps) {
			const rows = thinkingRowsFromMap(map);
			expect(supportedThinkingLevels(true, thinkingMapFromRows(rows))).toEqual(supportedThinkingLevels(true, map));
		}
		const mapped = { off: "none", minimal: "low", high: null, xhigh: "extra" };
		expect(thinkingMapFromRows(thinkingRowsFromMap(mapped))).toEqual(mapped);
	});

	it("disables base levels with null, opts into xhigh / max with their own name by default", () => {
		const rows = thinkingRowsFromMap(undefined).map((row) =>
			row.level === "off" ? { ...row, enabled: false }
				: row.level === "max" ? { ...row, enabled: true }
					: row.level === "low" ? { ...row, value: " light " }
						: row,
		);
		expect(thinkingMapFromRows(rows)).toEqual({ off: null, low: "light", max: "max" });
	});

	it("drops unknown keys and invalid values when normalizing hand-written maps", () => {
		expect(normalizeThinkingLevelMap({ high: "deep", turbo: "x", low: 3, off: null })).toEqual({ high: "deep", off: null });
		expect(normalizeThinkingLevelMap(["high"])).toBeUndefined();
	});
});
