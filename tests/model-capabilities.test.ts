import { describe, expect, it } from "vitest";
import { inferModelCapabilities, type OfficialModelCapabilities } from "../src/lib/model-capabilities";
import { customModelGaps } from "../src/lib/model-draft";

const catalog: OfficialModelCapabilities[] = [
	{ provider: "openai", id: "gpt-test-1", contextWindow: 1000000, maxTokens: 32000, input: ["text", "image"], reasoning: true },
	{ provider: "openai", id: "gpt-test-2", contextWindow: 128000, maxTokens: 8192, input: ["text"], reasoning: false },
];
const source = (model: object = { id: "gpt-test-1" }) => ({ gateway: { models: [model] } });
const models = (result: ReturnType<typeof inferModelCapabilities>) => (result.providers.gateway as { models: object[] }).models;

describe("automatic capability completion", () => {
	it("fills all four capabilities from the official version and eliminates manual prompts", () => {
		const result = inferModelCapabilities(source(), new Map(), catalog);
		expect(models(result)[0]).toEqual({ id: "gpt-test-1", contextWindow: 1000000, maxTokens: 32000, input: ["text", "image"], reasoning: true });
		expect(customModelGaps(result.providers)).toEqual([]);
	});
	it("uses endpoint limits and explicit false capabilities before official data", () => {
		const result = inferModelCapabilities(source(), new Map([["gateway", [{ id: "gpt-test-1", contextWindow: 256000, maxTokens: 4096, vision: false, reasoning: false }]]]), catalog);
		expect(models(result)[0]).toEqual({ id: "gpt-test-1", contextWindow: 256000, maxTokens: 4096, input: ["text"], reasoning: false });
	});
	it("never overwrites manual values, false declarations, opaque fields or modelOverrides", () => {
		const config = { gateway: { headers: { "x-opaque": "kept" }, models: [{ id: "gpt-test-1", contextWindow: 64000, reasoning: false, opaque: true }], modelOverrides: { "gpt-test-1": { maxTokens: 1024, input: ["text"] } } } };
		const result = inferModelCapabilities(config, new Map(), catalog);
		expect(result).toEqual({ providers: config, filled: 0 });
	});
	it("matches supported gateway aliases but respects a smaller deployment context", () => {
		const result = inferModelCapabilities(source({ id: "proxy/gpt-test-1-fast@500k" }), new Map(), catalog);
		expect(models(result)[0]).toMatchObject({ contextWindow: 500000, maxTokens: 32000, reasoning: true });
	});
	it("recognizes non-reasoning text-only official models too", () => {
		const result = inferModelCapabilities(source({ id: "gpt-test-2" }), new Map(), catalog);
		expect(models(result)[0]).toMatchObject({ input: ["text"], reasoning: false });
		expect(customModelGaps(result.providers)).toEqual([]);
	});
	it("leaves only unresolved fields for an unknown model, without guessing defaults or another version", () => {
		const result = inferModelCapabilities(source({ id: "gpt-test-3" }), new Map([["gateway", [{ id: "gpt-test-3", contextWindow: 256000, vision: false }]]]), catalog);
		expect(models(result)[0]).toEqual({ id: "gpt-test-3", contextWindow: 256000, input: ["text"] });
		expect(customModelGaps(result.providers)[0].missing).toEqual(["maxTokens", "reasoning"]);
	});
	it("isolates providers and is idempotent after persistence/restart", () => {
		const original = source({ id: "unknown" });
		const unchanged = inferModelCapabilities(original, new Map([["another", [{ id: "unknown", maxTokens: 999 }]]]), catalog);
		expect(unchanged.providers).toEqual(original);
		const first = inferModelCapabilities(source(), new Map(), catalog);
		const restarted = inferModelCapabilities(JSON.parse(JSON.stringify(first.providers)), new Map(), []);
		expect(restarted).toEqual({ providers: first.providers, filled: 0 });
		expect(source()).toEqual({ gateway: { models: [{ id: "gpt-test-1" }] } });
	});
});
