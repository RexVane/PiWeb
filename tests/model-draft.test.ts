import { describe, expect, it } from "vitest";
import { modelDraftFromConfig, parseCapacity, serializeModelDraft, serializeProviderDraft, validateModelDrafts } from "../src/lib/model-draft";

const model = {
	id: "reasoner", name: "Reasoner", contextWindow: 128000, maxTokens: 16000,
	reasoning: true, input: ["text", "image"], compat: { supportsDeveloperRole: false },
	thinkingLevelMap: { high: "deep" }, headers: { "x-model": "test" },
	cost: { input: 2, output: 4 }, vendorOption: { nested: [1, 2] },
};

describe("model draft round trips", () => {
	it("preserves every unedited model/provider field without mutating its source", () => {
		const source = { name: "Gateway", baseUrl: "https://example.invalid", api: "custom-api", oauth: { mode: "device" }, headers: { "x-provider": "test" }, compat: { flag: true }, models: [model] };
		const before = structuredClone(source);
		expect(serializeModelDraft(modelDraftFromConfig(model))).toEqual(model);
		expect(serializeProviderDraft(source, { name: "Gateway", baseUrl: source.baseUrl, api: source.api, models: source.models.map(modelDraftFromConfig), apiKey: "" })).toEqual(source);
		expect(source).toEqual(before);
	});
	it("renames model IDs and removes rows without restoring old entries", () => {
		const source = { models: [model, { id: "remove-me", reasoning: false }] };
		const edited = { ...modelDraftFromConfig(model), id: "renamed", name: "", contextWindow: undefined };
		const saved = serializeProviderDraft(source, { baseUrl: "", models: [edited] });
		expect(saved.models).toEqual([{ ...model, id: "renamed", name: undefined, contextWindow: undefined }]);
		expect((saved.models as object[])[0]).not.toHaveProperty("name");
		expect((saved.models as object[])[0]).not.toHaveProperty("contextWindow");
		expect(serializeProviderDraft(source, { baseUrl: "", models: [] }).models).toEqual([]);
	});
	it("clears builtin URL overrides but keeps API and opaque provider settings", () => {
		const source = { baseUrl: "https://old.invalid", api: "openai-responses", headers: { a: "b" }, models: [model] };
		const saved = serializeProviderDraft(source, { baseUrl: "", models: [] }, "openai-completions");
		expect(saved).toEqual({ api: "openai-responses", headers: { a: "b" }, models: [] });
	});
	it("leaves redacted keys absent and writes only an explicitly supplied key", () => {
		expect(serializeProviderDraft({}, { baseUrl: "", models: [], apiKey: "" })).not.toHaveProperty("apiKey");
		expect(serializeProviderDraft({}, { baseUrl: "", models: [], apiKey: " test-only " }).apiKey).toBe("test-only");
	});
	it("rejects duplicate IDs, zero, negative, infinite and fractional capacities", () => {
		expect(validateModelDrafts([{ id: "a", name: "" }, { id: " a ", name: "" }])).toEqual({ index: 1, reason: "id" });
		for (const value of [0, -1, Infinity, NaN, 1.5]) expect(validateModelDrafts([{ id: "a", name: "", contextWindow: value }])).toEqual({ index: 0, reason: "capacity" });
		expect(parseCapacity("0.00001")).toBeNaN();
	});
});
