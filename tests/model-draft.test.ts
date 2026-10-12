import { describe, expect, it } from "vitest";
import {
	isInertProviderConfig, modelDraftFromConfig, modelDraftsFromProviderConfig, parseCapacity, serializeModelDraft, serializeProviderDraft, validateModelDrafts,
} from "../src/lib/model-draft";

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

describe("builtin provider overrides", () => {
	const catalog = new Set(["builtin-a", "builtin-b", "__proto__"]);

	it("writes rows for catalog models as modelOverrides and only new IDs as models[]", () => {
		// 回归：同 ID 的 models[] 会被 SDK 按默认值整条重建，丢 reasoning / 上下文 / 价格 / 思考档位
		const saved = serializeProviderDraft({}, {
			baseUrl: "",
			models: [{ id: "builtin-a", name: "Renamed", contextWindow: 64000 }, { id: "builtin-b", name: "" }, { id: "new-model", name: "New" }],
		}, "anthropic-messages", catalog);
		expect(saved).toEqual({
			models: [{ id: "new-model", name: "New" }],
			modelOverrides: { "builtin-a": { name: "Renamed", contextWindow: 64000 } },
			api: "anthropic-messages",
		});
	});

	it("does not add a provider API when every row overrides an existing model", () => {
		expect(serializeProviderDraft({}, { baseUrl: "", models: [{ id: "builtin-a", name: "Renamed" }] }, "anthropic-messages", catalog))
			.toEqual({ modelOverrides: { "builtin-a": { name: "Renamed" } } });
	});

	it("migrates same-ID models[] rows into overrides but keeps hand-written full definitions", () => {
		const source = {
			api: "openai-completions",
			models: [model, { id: "builtin-a", name: "Old", cost: { input: 1 } }, { id: "builtin-b", api: "openai-responses", baseUrl: "https://proxy.invalid" }],
		};
		const saved = serializeProviderDraft(source, { baseUrl: "", models: modelDraftsFromProviderConfig(source) }, "anthropic-messages", catalog);
		expect(saved).toEqual({
			api: "openai-completions",
			models: [model, { id: "builtin-b", api: "openai-responses", baseUrl: "https://proxy.invalid" }],
			modelOverrides: { "builtin-a": { name: "Old", cost: { input: 1 } } },
		});
	});

	it("round-trips existing overrides, keeps unknown-ID overrides and drops emptied ones", () => {
		const source = { baseUrl: "https://gateway.invalid", modelOverrides: { "builtin-a": { name: "A", headers: { x: "y" } }, "retired-model": { maxTokens: 9000 }, "builtin-b": { name: "B" } } };
		const rows = modelDraftsFromProviderConfig(source);
		expect(rows.map((row) => [row.id, row.origin])).toEqual([["builtin-a", "override"], ["retired-model", "override"], ["builtin-b", "override"]]);
		expect(serializeProviderDraft(source, { baseUrl: source.baseUrl, models: rows }, "x", catalog)).toEqual(source);
		const edited = [rows[0], rows[1], { ...rows[2], name: "" }];
		expect(serializeProviderDraft(source, { baseUrl: source.baseUrl, models: edited }, "x", catalog).modelOverrides)
			.toEqual({ "builtin-a": { name: "A", headers: { x: "y" } }, "retired-model": { maxTokens: 9000 } });
		expect(serializeProviderDraft(source, { baseUrl: source.baseUrl, models: [] }, "x", catalog)).toEqual({ baseUrl: "https://gateway.invalid" });
	});

	it("turns an override renamed to an unknown ID into a new model definition", () => {
		const source = { modelOverrides: { "builtin-a": { name: "A" } } };
		const [row] = modelDraftsFromProviderConfig(source);
		expect(serializeProviderDraft(source, { baseUrl: "", models: [{ ...row, id: "brand-new" }] }, "openai-completions", catalog))
			.toEqual({ models: [{ id: "brand-new", name: "A" }], api: "openai-completions" });
	});

	it("stores a __proto__ model ID as data, not as the overrides prototype", () => {
		const saved = serializeProviderDraft({}, { baseUrl: "", models: [{ id: "__proto__", name: "Odd" }] }, "x", catalog);
		const overrides = saved.modelOverrides as Record<string, unknown>;
		expect(Object.getPrototypeOf(overrides)).toBe(Object.prototype);
		expect(JSON.parse(JSON.stringify(saved))).toEqual(JSON.parse('{"modelOverrides":{"__proto__":{"name":"Odd"}}}'));
	});

	it("recognizes provider entries the SDK would reject as empty", () => {
		// SDK：条目至少要有非空 models / modelOverrides、baseUrl、headers、compat、apiKey、oauth、authHeader 之一
		expect(isInertProviderConfig({})).toBe(true);
		expect(isInertProviderConfig({ api: "anthropic-messages", models: [], modelOverrides: {}, name: "x" })).toBe(true);
		expect(isInertProviderConfig({ models: [{ id: "m" }] })).toBe(false);
		expect(isInertProviderConfig({ modelOverrides: { m: { name: "M" } } })).toBe(false);
		for (const field of ["baseUrl", "headers", "compat", "apiKey", "oauth", "authHeader", "futureField"]) {
			expect(isInertProviderConfig({ api: "x", [field]: field === "authHeader" ? false : "value" })).toBe(false);
		}
	});
});
