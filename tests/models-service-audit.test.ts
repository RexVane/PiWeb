/**
 * 模型配置体检：models.json 里没写 contextWindow / maxTokens / input 的条目会被 pi 的缺省顶掉
 * （128000 / 16384 / 只文本）。盯两件事：只查 models[]（modelOverrides 有内置真值）、补全只填空。
 */
import { describe, expect, it } from "vitest";
import { customModelGaps, fillCustomModelDefaults } from "../src/lib/models-service";
import { MODEL_FIELD_DEFAULTS, modelInputFor } from "../src/lib/model-draft";

const CONTENT = JSON.stringify({
	providers: {
		magpie: { baseUrl: "http://127.0.0.1:3425/v1", apiKey: "sk-secret", models: [
			{ id: "full", contextWindow: 1_000_000, maxTokens: 32_000, input: ["text", "image"] },
			{ id: "missing-all" },
			{ id: "missing-max", contextWindow: 200_000, input: ["text"] },
		] },
		anthropic: { modelOverrides: { "claude-x": { maxTokens: 8192 } } },
	},
}, null, 2);

describe("模型配置体检", () => {
	it("只列 models[] 里缺字段的条目", () => {
		expect(customModelGaps(CONTENT)).toEqual([
			{ provider: "magpie", providerName: null, id: "missing-all", name: null, missing: ["contextWindow", "maxTokens", "input"] },
			{ provider: "magpie", providerName: null, id: "missing-max", name: null, missing: ["maxTokens"] },
		]);
	});

	it("一键补全只补容量、只填空：不覆盖已有值，也不碰 modelOverrides", () => {
		const filled = fillCustomModelDefaults(CONTENT);
		expect(filled.filled).toBe(2);
		const parsed = JSON.parse(filled.content);
		const models = parsed.providers.magpie.models;
		expect(models[0]).toEqual({ id: "full", contextWindow: 1_000_000, maxTokens: 32_000, input: ["text", "image"] });
		// 视觉不自动猜：只补容量，input 保持缺失（由用户表态）
		expect(models[1]).toEqual({ id: "missing-all", contextWindow: MODEL_FIELD_DEFAULTS.contextWindow, maxTokens: MODEL_FIELD_DEFAULTS.maxTokens });
		expect(models[2]).toEqual({ id: "missing-max", contextWindow: 200_000, maxTokens: MODEL_FIELD_DEFAULTS.maxTokens, input: ["text"] });
		expect(parsed.providers.anthropic.modelOverrides["claude-x"]).toEqual({ maxTokens: 8192 });
		expect(fillCustomModelDefaults(filled.content).filled).toBe(0);
	});

	it("视觉走显式表态：给了才写，已有声明不被改写", () => {
		const withVision = JSON.parse(fillCustomModelDefaults(CONTENT, MODEL_FIELD_DEFAULTS, true).content);
		expect(withVision.providers.magpie.models[1].input).toEqual(modelInputFor(true));
		const textOnly = JSON.parse(fillCustomModelDefaults(CONTENT, MODEL_FIELD_DEFAULTS, false).content);
		expect(textOnly.providers.magpie.models[1].input).toEqual(["text"]);
		// 已经声明过的条目保持原样（false 不能把有视觉的模型改成纯文本）
		expect(textOnly.providers.magpie.models[0].input).toEqual(["text", "image"]);
		expect(textOnly.providers.magpie.models[2].input).toEqual(["text"]);
	});

	it("内容里没有可体检的条目也不报错", () => {
		expect(customModelGaps(JSON.stringify({ providers: {} }))).toEqual([]);
		expect(customModelGaps(JSON.stringify({ providers: { p: { models: [{ id: "" }, "junk", { id: "ok" }] } } })).map((gap) => gap.id)).toEqual(["ok"]);
	});
});
