import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS, clampThinkingLevelTo, newSessionThinkingLevel } from "../src/lib/thinking-level";

type PiModel = Parameters<typeof clampThinkingLevel>[0];

function model(reasoning: boolean, thinkingLevelMap?: Record<string, string | null>): PiModel {
	return { id: "m", provider: "p", api: "openai-completions", reasoning, thinkingLevelMap } as unknown as PiModel;
}

describe("clampThinkingLevelTo", () => {
	it("matches pi-ai's clampThinkingLevel for every model shape and every requested level", () => {
		const shapes = [
			model(false),
			model(true),
			model(true, { xhigh: "xhigh" }),
			model(true, { xhigh: null }),
			model(true, { max: null, xhigh: null }),
			model(true, { minimal: null, low: null }),
		];
		for (const m of shapes) {
			const supported = getSupportedThinkingLevels(m);
			for (const level of [...THINKING_LEVELS, "bogus"]) {
				expect(clampThinkingLevelTo(supported, level)).toBe(clampThinkingLevel(m, level as never));
			}
		}
	});

	it("keeps a supported level and climbs before it descends", () => {
		expect(clampThinkingLevelTo(["off", "low", "high"], "low")).toBe("low");
		expect(clampThinkingLevelTo(["off", "low", "high"], "medium")).toBe("high");
		expect(clampThinkingLevelTo(["off", "low", "high"], "max")).toBe("high");
	});

	it("collapses a non-reasoning model to off and an empty list to off", () => {
		expect(clampThinkingLevelTo(["off"], "high")).toBe("off");
		expect(clampThinkingLevelTo([], "high")).toBe("off");
	});
});

describe("newSessionThinkingLevel", () => {
	const all = THINKING_LEVELS;

	it("uses an explicit choice over every default", () => {
		expect(newSessionThinkingLevel({ supported: all, requested: "high", modelOverride: "low", defaultLevel: "minimal" })).toBe("high");
	});

	it("uses the per-model override over the settings default", () => {
		expect(newSessionThinkingLevel({ supported: all, requested: "", modelOverride: "low", defaultLevel: "minimal" })).toBe("low");
	});

	it("uses the settings default when no override is set", () => {
		expect(newSessionThinkingLevel({ supported: all, defaultLevel: "minimal" })).toBe("minimal");
	});

	it("falls back to medium, the SDK's default, when nothing is configured", () => {
		expect(newSessionThinkingLevel({ supported: all })).toBe(DEFAULT_THINKING_LEVEL);
		expect(DEFAULT_THINKING_LEVEL).toBe("medium");
	});

	it("clamps the effective level to what the model supports", () => {
		expect(newSessionThinkingLevel({ supported: ["off"], defaultLevel: "high" })).toBe("off");
		expect(newSessionThinkingLevel({ supported: ["off", "minimal", "low", "medium", "high"], requested: "xhigh" })).toBe("high");
	});
});
