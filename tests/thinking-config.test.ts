import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { nextThinkingRow, thinkingRowsFromMap, thinkingRowsToMap, validThinkingRows, matchOfficialThinkingModel } from "../src/lib/thinking-config";
import { modelDraftFromConfig, serializeModelDraft, serializeProviderDraft, validateModelDrafts } from "../src/lib/model-draft";

it("adds low/low first, then medium/medium, skips used levels and stops at seven", () => {
	const rows = [];
	for (const level of ["low", "medium", "high", "xhigh", "max", "off", "minimal"]) {
		const next = nextThinkingRow(rows);
		expect(next).toEqual({ level, value: level === "off" ? "none" : level });
		rows.push(next!);
	}
	expect(nextThinkingRow(rows)).toBeNull();
	expect(nextThinkingRow([{ level: "high", value: "high" }])).toEqual({ level: "low", value: "low" });
});

it("represents unlisted levels as null so Pi exposes exactly the manual rows", () => {
	const map = thinkingRowsToMap([{ level: "low", value: "low" }, { level: "max", value: "maximum" }]);
	expect(map).toEqual({ off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: "maximum" });
	expect(getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: map } as never)).toEqual(["low", "max"]);
});

it("keeps Pi's implicit default levels when reading sparse existing maps", () => {
	expect(thinkingRowsFromMap({ high: "deep" }).map((row) => row.level)).toEqual(["off", "minimal", "low", "medium", "high"]);
	const source = { id: "m", reasoning: true, thinkingLevelMap: { high: "deep" }, compat: { opaque: "kept" } };
	expect(serializeModelDraft(modelDraftFromConfig(source))).toEqual(source);
});

it("stores manual rows through both models[] and modelOverrides, and supports resetting to automatic", () => {
	const row = { ...modelDraftFromConfig({ id: "m", reasoning: true, maxTokens: 2048 }), thinkingRows: [{ level: "high", value: "high" }] };
	const saved = serializeProviderDraft({}, { baseUrl: "", models: [row] }, undefined, new Set(["m"]));
	expect((saved.modelOverrides as Record<string, Record<string, unknown>>).m.thinkingLevelMap).toEqual(thinkingRowsToMap(row.thinkingRows));
	const source = { id: "m", thinkingLevelMap: { high: "deep" }, headers: { x: "keep" } };
	const reset = serializeModelDraft({ ...modelDraftFromConfig(source), thinkingRows: undefined });
	expect(reset).toEqual({ id: "m", headers: { x: "keep" } });
});

it("rejects duplicate levels, empty values, invalid names and overlong API values", () => {
	for (const rows of [[], [{ level: "low", value: "" }], [{ level: "invalid", value: "x" }], [{ level: "low", value: "x" }, { level: "low", value: "y" }], [{ level: "high", value: "x".repeat(65) }]]) {
		expect(validThinkingRows(rows)).toBe(false);
		expect(validateModelDrafts([{ id: "m", name: "", thinkingRows: rows }])).toEqual({ index: 0, reason: "thinking" });
	}
});

describe("official model matching", () => {
	const catalog = [
		{ provider: "zai", id: "glm-5.3", reasoning: true },
		{ provider: "zai", id: "glm-5.3-flash", reasoning: true },
		{ provider: "xai", id: "grok-4.7", reasoning: true },
		{ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", reasoning: true },
		{ provider: "google", id: "gemini-3.8-flash", reasoning: true },
	];
	it.each([["glm-5.3-flash-background", "glm-5.3-flash"], ["grok/grok-4.7-build-fast@500k", "grok-4.7"], ["deepseek-v4.1-flash-1017-fast", "deepseek/deepseek-v4.1-flash"], ["agy-acp/gemini-3.8-flash", "gemini-3.8-flash"]])("matches %s without borrowing another generation", (id, official) => {
		expect(matchOfficialThinkingModel({ provider: "custom", id }, catalog)?.id).toBe(official);
	});
	it("does not guess an unmatched model or a newer model generation", () => {
		expect(matchOfficialThinkingModel({ provider: "custom", id: "glm-5.4-flash" }, catalog)).toBeUndefined();
		expect(matchOfficialThinkingModel({ provider: "custom", id: "unknown" }, catalog)).toBeUndefined();
	});
});
