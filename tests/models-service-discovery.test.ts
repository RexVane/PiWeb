import { afterEach, describe, expect, it, vi } from "vitest";
import {
	discoverModels,
	preserveCustomProviderApiKeys,
	redactCustomProviderSecrets,
} from "../src/lib/models-service";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("provider model discovery", () => {
	it("loads, normalizes, and deduplicates an OpenAI-compatible model catalog", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{ id: "alpha", name: "Alpha" },
						{ id: "alpha", name: "Duplicate" },
						"beta",
						{ id: "" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			discoverModels({ baseUrl: "https://api.example.com/v1/", api: "openai-responses", apiKey: "test-key" }),
		).resolves.toEqual([{ id: "alpha", name: "Alpha" }, { id: "beta" }]);

		const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(url.toString()).toBe("https://api.example.com/v1/models");
		expect(options.headers).toMatchObject({ Accept: "application/json", Authorization: "Bearer test-key" });
	});

	it("uses Anthropic headers and preserves an existing models endpoint", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ models: [{ id: "claude-test" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await discoverModels({
			baseUrl: "https://api.example.com/v1/models",
			api: "anthropic-messages",
			apiKey: "anthropic-key",
		});

		const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(url.toString()).toBe("https://api.example.com/v1/models");
		expect(options.headers).toMatchObject({
			Accept: "application/json",
			"x-api-key": "anthropic-key",
			"anthropic-version": "2023-06-01",
		});
		expect(options.headers).not.toHaveProperty("Authorization");
	});

	it("returns actionable errors for invalid URLs, failed requests, and empty catalogs", async () => {
		await expect(discoverModels({ baseUrl: "file:///tmp/models" })).rejects.toThrow("http 或 https");

		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 401 })));
		await expect(discoverModels({ baseUrl: "https://api.example.com/v1" })).rejects.toThrow("HTTP 401");

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ data: [{ name: "missing-id" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		await expect(discoverModels({ baseUrl: "https://api.example.com/v1" })).rejects.toThrow("没有可识别的模型 ID");
	});
});

describe("custom provider credential boundaries", () => {
	it("redacts inline API keys before returning models.json to the browser", () => {
		const result = redactCustomProviderSecrets(JSON.stringify({
			providers: {
				gateway: { baseUrl: "https://example.test/v1", apiKey: "secret", models: [{ id: "model-a" }] },
				public: { baseUrl: "http://localhost:11434/v1", models: [{ id: "local" }] },
			},
		}));

		expect(result.secretProviderIds).toEqual(["gateway"]);
		expect(result.content).not.toContain("secret");
		expect(JSON.parse(result.content).providers.gateway.apiKey).toBeUndefined();
	});

	it("preserves an existing inline key when the redacted editor saves other fields", () => {
		const previous = JSON.stringify({ providers: { gateway: { apiKey: "secret", baseUrl: "https://old.test/v1" } } });
		const incoming = JSON.stringify({ providers: { gateway: { baseUrl: "https://new.test/v1" } } });
		const merged = JSON.parse(preserveCustomProviderApiKeys(incoming, previous));

		expect(merged.providers.gateway).toEqual({ baseUrl: "https://new.test/v1", apiKey: "secret" });
	});

	it("does not restore credentials for a deleted provider", () => {
		const previous = JSON.stringify({ providers: { gateway: { apiKey: "secret" } } });
		const merged = JSON.parse(preserveCustomProviderApiKeys('{"providers":{}}', previous));

		expect(merged.providers).toEqual({});
	});

	it("removes an inline key on explicit null instead of resurrecting it", () => {
		const previous = JSON.stringify({ providers: { gateway: { apiKey: "secret", baseUrl: "https://old.test/v1" } } });
		const incoming = JSON.stringify({ providers: { gateway: { apiKey: null, baseUrl: "https://new.test/v1" } } });
		const merged = JSON.parse(preserveCustomProviderApiKeys(incoming, previous));

		expect(merged.providers.gateway).toEqual({ baseUrl: "https://new.test/v1" });
	});
});
