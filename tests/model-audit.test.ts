/**
 * 模型配置体检：models.json 里没写 contextWindow / maxTokens / input 的条目会落到 pi 的缺省上
 * （128000 / 16384 / 只文本）。盯三件事：只查 models[]（modelOverrides 有内置真值）、
 * 不替用户猜值（只写用户填的）、补全只填空。
 */
import { describe, expect, it } from "vitest";
import { customModelGaps, fillModelFields, modelInputFor } from "../src/lib/model-draft";

const providers = (): Record<string, unknown> => ({
	magpie: { baseUrl: "http://127.0.0.1:3425/v1", models: [
		{ id: "full", contextWindow: 1_000_000, maxTokens: 32_000, input: ["text", "image"] },
		{ id: "missing-all", name: " Missing All " },
		{ id: "missing-max", contextWindow: 200_000, input: ["text"] },
	] },
	anthropic: { modelOverrides: { "claude-x": { maxTokens: 8192 } } },
});

describe("customModelGaps", () => {
	it("只列 models[] 里缺字段的条目，带上位置和已写的值", () => {
		// reasoning 也要算：没写时 pi 按 false 处理，推理模型的思考档位会整个消失
		expect(customModelGaps(providers())).toEqual([
			{ provider: "magpie", index: 0, id: "full", name: null, contextWindow: 1_000_000, maxTokens: 32_000, vision: true, missing: ["reasoning"] },
			{ provider: "magpie", index: 1, id: "missing-all", name: "Missing All", missing: ["contextWindow", "maxTokens", "input", "reasoning"] },
			{ provider: "magpie", index: 2, id: "missing-max", name: null, contextWindow: 200_000, vision: false, missing: ["maxTokens", "reasoning"] },
		]);
	});

	it("空配置和坏条目不报错", () => {
		expect(customModelGaps({})).toEqual([]);
		expect(customModelGaps({ p: { models: [{ id: "" }, "junk", { id: "ok" }] }, q: "junk", r: { models: "junk" } }).map((gap) => [gap.id, gap.index]))
			.toEqual([["ok", 2]]);
	});
});

describe("fillModelFields", () => {
	it("只写用户填的值、只填空：已有值、modelOverrides 都不动", () => {
		const source = providers();
		const before = structuredClone(source);
		const result = fillModelFields(source, [
			{ provider: "magpie", index: 1, id: "missing-all", contextWindow: 256_000, vision: true },
			// 已经写了 contextWindow / input 的条目：这两个值不被覆盖
			{ provider: "magpie", index: 2, id: "missing-max", contextWindow: 1, maxTokens: 64_000, vision: true },
		]);
		expect(result.filled).toBe(2);
		const models = (result.providers.magpie as { models: unknown[] }).models;
		expect(models[0]).toEqual({ id: "full", contextWindow: 1_000_000, maxTokens: 32_000, input: ["text", "image"] });
		// 没填的 maxTokens 保持缺失，不拿缺省顶上
		expect(models[1]).toEqual({ id: "missing-all", name: " Missing All ", contextWindow: 256_000, input: modelInputFor(true) });
		expect(models[2]).toEqual({ id: "missing-max", contextWindow: 200_000, maxTokens: 64_000, input: ["text"] });
		expect(result.providers.anthropic).toEqual(before.anthropic);
		expect(source).toEqual(before);
	});

	it("位置或 ID 对不上、值无效、什么都没填，都不算补了", () => {
		const result = fillModelFields(providers(), [
			{ provider: "magpie", index: 1, id: "renamed-meanwhile", contextWindow: 256_000 },
			{ provider: "magpie", index: 9, id: "missing-all", contextWindow: 256_000 },
			{ provider: "ghost", index: 0, id: "full", maxTokens: 8_000 },
			{ provider: "__proto__", index: 0, id: "x", maxTokens: 8_000 },
			{ provider: "magpie", index: 1, id: "missing-all", contextWindow: 0, maxTokens: 1.5 },
			{ provider: "magpie", index: 1, id: "missing-all" },
		]);
		expect(result.filled).toBe(0);
		expect(result.providers).toEqual(providers());
	});

	it("补完再体检，缺口跟着消失", () => {
		const { providers: next } = fillModelFields(providers(), [
			// reasoning 也要一起补：没写时 pi 按 false 处理，体检会继续提示
			{ provider: "magpie", index: 0, id: "full", reasoning: true },
			{ provider: "magpie", index: 1, id: "missing-all", contextWindow: 256_000, maxTokens: 16_000, vision: false, reasoning: false },
			{ provider: "magpie", index: 2, id: "missing-max", maxTokens: 8_000, reasoning: true },
		]);
		expect(customModelGaps(next)).toEqual([]);
	});
});
