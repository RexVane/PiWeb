/**
 * 模型目录条目的能力探测。
 *
 * 重点：字段名各家不同，读不到就要留空（不猜）——猜错 reasoning 会让非推理模型
 * 多出思考档位、选中后上游直接 400；猜错 vision 会把图片发给不收图的上游。
 */
import { describe, expect, it } from "vitest";
import { catalogCapabilities } from "@/lib/models-service";

describe("catalogCapabilities", () => {
	it("reads context window under the field names seen in the wild", () => {
		expect(catalogCapabilities({ context_window: 200000 })).toMatchObject({ contextWindow: 200000 });
		expect(catalogCapabilities({ context_length: 128000 })).toMatchObject({ contextWindow: 128000 });
		expect(catalogCapabilities({ max_input_tokens: 1000000 })).toMatchObject({ contextWindow: 1000000 });
		expect(catalogCapabilities({ architecture: { context_length: 32000 } })).toMatchObject({ contextWindow: 32000 });
	});

	it("reads max output tokens, including OpenRouter's nested top_provider", () => {
		expect(catalogCapabilities({ max_output_tokens: 8192 })).toMatchObject({ maxTokens: 8192 });
		expect(catalogCapabilities({ max_completion_tokens: 4096 })).toMatchObject({ maxTokens: 4096 });
		expect(catalogCapabilities({ top_provider: { max_completion_tokens: 2048 } })).toMatchObject({ maxTokens: 2048 });
	});

	it("reads vision from the three known modality shapes", () => {
		expect(catalogCapabilities({ modalities: { input: ["text", "image"] } })).toMatchObject({ vision: true });
		expect(catalogCapabilities({ architecture: { input_modalities: ["text"] } })).toMatchObject({ vision: false });
		expect(catalogCapabilities({ input_modalities: ["text", "IMAGE"] })).toMatchObject({ vision: true });
	});

	it("reads reasoning from boolean fields, capabilities, and OpenRouter's supported_parameters", () => {
		expect(catalogCapabilities({ reasoning: true })).toMatchObject({ reasoning: true });
		expect(catalogCapabilities({ reasoning: false })).toMatchObject({ reasoning: false });
		expect(catalogCapabilities({ supports_reasoning: true })).toMatchObject({ reasoning: true });
		expect(catalogCapabilities({ capabilities: { reasoning: true } })).toMatchObject({ reasoning: true });
		expect(catalogCapabilities({ capabilities: { thinking: { supported: true } } })).toMatchObject({ reasoning: true });
		expect(catalogCapabilities({ supported_parameters: ["temperature", "reasoning"] })).toMatchObject({ reasoning: true });
		expect(catalogCapabilities({ supported_parameters: ["include_reasoning"] })).toMatchObject({ reasoning: true });
	});

	it("leaves a capability absent when nothing reports it, rather than guessing", () => {
		const empty = catalogCapabilities({ id: "some-model" });
		expect(empty.contextWindow).toBeUndefined();
		expect(empty.maxTokens).toBeUndefined();
		expect(empty.vision).toBeUndefined();
		expect(empty.reasoning).toBeUndefined();
		// supported_parameters 里没有 reasoning 相关项时也不能当作「支持推理」
		expect(catalogCapabilities({ supported_parameters: ["temperature", "top_p"] }).reasoning).toBeUndefined();
	});

	it("ignores non-positive or non-integer capacities", () => {
		expect(catalogCapabilities({ context_window: 0 }).contextWindow).toBeUndefined();
		expect(catalogCapabilities({ context_window: -1 }).contextWindow).toBeUndefined();
		expect(catalogCapabilities({ context_window: 1.5 }).contextWindow).toBeUndefined();
		expect(catalogCapabilities({ context_window: "128000" }).contextWindow).toBeUndefined();
	});
});