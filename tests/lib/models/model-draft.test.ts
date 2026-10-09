import { describe, expect, it } from "vitest";
import { modelDraftFromConfig, parseCapacity, serializeModelDraft, serializeProviderDraft, validateModelDrafts, withBuiltinOverride } from "../../../src/lib/models/model-draft";

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
	it("writes capability edits only when they change and keeps hand-written maps untouched otherwise", () => {
		const odd = { id: "x", reasoning: true, thinkingLevelMap: { low: " light ", turbo: "x" }, input: ["image", "text"] };
		// 未改动：原样保留（包括 pi 不认识的键与首尾空格）
		expect(serializeModelDraft(modelDraftFromConfig(odd))).toEqual(odd);
		// 只改名字：能力字段不受影响
		expect(serializeModelDraft({ ...modelDraftFromConfig(odd), name: "X" })).toEqual({ ...odd, name: "X" });
		// 改了档位：按规范形式整张重写
		expect(serializeModelDraft({ ...modelDraftFromConfig(odd), thinkingLevelMap: { low: " light ", max: "" } })).toEqual({ ...odd, thinkingLevelMap: { low: "light", max: "max" } });
		// 关掉思考与看图：删键回到 pi 默认
		const off = serializeModelDraft({ ...modelDraftFromConfig(odd), reasoning: false, vision: false });
		expect(off).not.toHaveProperty("reasoning");
		expect(off).not.toHaveProperty("input");
		expect(off.thinkingLevelMap).toEqual(odd.thinkingLevelMap);
		// 新行只写填了的能力
		expect(serializeModelDraft({ id: "new", name: "", reasoning: true, vision: true, thinkingLevelMap: { xhigh: "" } })).toEqual({ id: "new", reasoning: true, input: ["text", "image"], thinkingLevelMap: { xhigh: "xhigh" } });
		expect(serializeModelDraft({ id: "plain", name: "" })).toEqual({ id: "plain" });
	});
	it("rejects duplicate IDs, zero, negative, infinite and fractional capacities", () => {
		expect(validateModelDrafts([{ id: "a", name: "" }, { id: " a ", name: "" }])).toEqual({ index: 1, reason: "id" });
		for (const value of [0, -1, Infinity, NaN, 1.5]) expect(validateModelDrafts([{ id: "a", name: "", contextWindow: value }])).toEqual({ index: 0, reason: "capacity" });
		expect(parseCapacity("0.00001")).toBeNaN();
	});
});

describe("built-in provider override write-back", () => {
	it("drops a block emptied of overrides instead of saving one pi rejects, and keeps blocks with content or a hidden key", () => {
		const providers = { xai: { api: "openai-responses", models: [{ id: "grok-4.7" }] }, other: { baseUrl: "https://example.invalid" } };
		const before = structuredClone(providers);
		const emptied = serializeProviderDraft(providers.xai, { baseUrl: "", models: [] }, "openai-responses");
		expect(emptied).toEqual({ api: "openai-responses", models: [] });
		expect(withBuiltinOverride(providers, "xai", emptied)).toEqual({ other: providers.other });
		// 只填密钥的「添加提供方」：没有旧块也不写空块
		expect(withBuiltinOverride(providers, "deepseek", {})).toEqual(providers);
		expect(withBuiltinOverride(providers, "xai", emptied, true)).toEqual({ ...providers, xai: emptied });
		expect(withBuiltinOverride(providers, "xai", { ...emptied, headers: { "x-test": "1" } }).xai).toEqual({ ...emptied, headers: { "x-test": "1" } });
		expect(providers).toEqual(before);
	});
});
