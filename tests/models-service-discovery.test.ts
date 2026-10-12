import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	apisByUsage,
	catalogCapabilities,
	builtinCatalogModelIds,
	discoverModels,
	isPublicModelDiscoveryAddress,
	isTrustedCredentialEndpoint,
	preserveCustomProviderApiKeys,
	redactCustomProviderSecrets,
} from "../src/lib/models-service";

afterEach(() => {
	delete process.env.PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY;
});

async function withCatalogServer<T>(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (baseUrl: string) => Promise<T>): Promise<T> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const port = (server.address() as AddressInfo).port;
		return await run(`http://127.0.0.1:${port}/v1`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

describe("provider default API", () => {
	it("puts the protocol most models use first, ties alphabetical", () => {
		// 回归：以前取字母序第一个，大部分模型走 responses 的 provider 会给新模型配上 completions
		const models = [{ api: "openai-responses" }, { api: "openai-completions" }, { api: "openai-responses" }, { api: "" }, {}];
		expect(apisByUsage(models)).toEqual(["openai-responses", "openai-completions"]);
		expect(apisByUsage([{ api: "b" }, { api: "a" }])).toEqual(["a", "b"]);
		expect(apisByUsage([])).toEqual([]);
	});
});

describe("built-in catalog model IDs", () => {
	it("covers the static catalog and remote/extension models, but not models[] definitions", async () => {
		const staticRuntime = await ModelRuntime.create({
			modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
			credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		});
		const builtin = staticRuntime.getModels("anthropic")[0].id;
		const content = JSON.stringify({ providers: {
			anthropic: { models: [{ id: builtin, name: "Same ID" }, { id: "proxy-only-model" }] },
			gateway: { baseUrl: "https://gateway.invalid", api: "openai-completions", models: [{ id: "m" }] },
		} });
		const ids = await builtinCatalogModelIds(content, [
			{ provider: "anthropic", id: builtin },
			{ provider: "anthropic", id: "proxy-only-model" },
			{ provider: "anthropic", id: "remote-catalog-model" },
			{ provider: "gateway", id: "m" },
		]);
		// 同 ID 的 models[] 定义不能把内置模型挤出目录，否则下次编辑又会写回 models[]
		expect(ids.anthropic).toContain(builtin);
		expect(ids.anthropic).toContain("remote-catalog-model");
		expect(ids.anthropic).not.toContain("proxy-only-model");
		expect(ids.anthropic).toEqual([...ids.anthropic].sort());
		expect(ids).not.toHaveProperty("gateway");
	});
});

describe("provider model discovery", () => {
	it("reuses stored credentials only for a configured provider endpoint", () => {
		const configured = ["https://api.example.com/v1"];
		expect(isTrustedCredentialEndpoint(new URL("https://api.example.com/v1/models"), configured)).toBe(true);
		expect(isTrustedCredentialEndpoint(new URL("https://api.example.com/other/models"), configured)).toBe(false);
		expect(isTrustedCredentialEndpoint(new URL("https://api.example.com/v1/models?tenant=other"), configured)).toBe(false);
		expect(isTrustedCredentialEndpoint(new URL("https://attacker.test/v1/models"), configured)).toBe(false);
		expect(isTrustedCredentialEndpoint(new URL("http://api.example.com/v1/models"), configured)).toBe(false);
	});

	it("loads, normalizes, and deduplicates an OpenAI-compatible model catalog", async () => {
		process.env.PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY = "1";
		await withCatalogServer((request, response) => {
			expect(request.url).toBe("/v1/models");
			expect(request.headers.authorization).toBe("Bearer test-key");
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({
					data: [
						{ id: "alpha", name: "Alpha" },
						{ id: "alpha", name: "Duplicate" },
						"beta",
						{ id: "" },
					],
			}));
		}, async (baseUrl) => {
			await expect(discoverModels({ baseUrl: `${baseUrl}/`, api: "openai-responses", apiKey: "test-key" }))
				.resolves.toEqual([{ id: "alpha", name: "Alpha" }, { id: "beta" }]);
		});
	});

	it("uses Anthropic headers and preserves an existing models endpoint", async () => {
		process.env.PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY = "1";
		await withCatalogServer((request, response) => {
			expect(request.url).toBe("/v1/models");
			expect(request.headers["x-api-key"]).toBe("anthropic-key");
			expect(request.headers["anthropic-version"]).toBe("2023-06-01");
			expect(request.headers.authorization).toBeUndefined();
			response.end(JSON.stringify({ models: [{ id: "claude-test" }] }));
		}, async (baseUrl) => {
			await discoverModels({ baseUrl: `${baseUrl}/models`, api: "anthropic-messages", apiKey: "anthropic-key" });
		});
	});

	it("returns actionable errors for invalid URLs, failed requests, and empty catalogs", async () => {
		await expect(discoverModels({ baseUrl: "file:///tmp/models" })).rejects.toThrow("http 或 https");

		process.env.PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY = "1";
		await withCatalogServer((_request, response) => {
			response.writeHead(401).end("denied");
		}, async (baseUrl) => {
			await expect(discoverModels({ baseUrl })).rejects.toThrow("HTTP 401");
		});
		await withCatalogServer((_request, response) => {
			response.end(JSON.stringify({ data: [{ name: "missing-id" }] }));
		}, async (baseUrl) => {
			await expect(discoverModels({ baseUrl })).rejects.toThrow("没有可识别的模型 ID");
		});
	});

	it("rejects oversized model catalogs even without a content-length header", async () => {
		process.env.PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY = "1";
		await withCatalogServer((_request, response) => {
			response.end("x".repeat(4 * 1024 * 1024 + 1));
		}, async (baseUrl) => {
			await expect(discoverModels({ baseUrl })).rejects.toThrow("模型目录响应过大");
		});
		await withCatalogServer((_request, response) => {
			response.setHeader("content-length", String(4 * 1024 * 1024 + 1));
			response.end("{}");
		}, async (baseUrl) => {
			await expect(discoverModels({ baseUrl })).rejects.toThrow("模型目录响应过大");
		});
	});

	it("does not follow a model catalog redirect", async () => {
		process.env.PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY = "1";
		await withCatalogServer((_request, response) => {
			response.writeHead(302, { Location: "http://127.0.0.1:1/private" }).end();
		}, async (baseUrl) => {
			await expect(discoverModels({ baseUrl })).rejects.toThrow("不允许重定向");
		});
	});

	it("blocks private and reserved targets unless explicitly enabled", async () => {
		expect(isPublicModelDiscoveryAddress("8.8.8.8")).toBe(true);
		expect(isPublicModelDiscoveryAddress("127.0.0.1")).toBe(false);
		expect(isPublicModelDiscoveryAddress("169.254.169.254")).toBe(false);
		expect(isPublicModelDiscoveryAddress("192.168.1.2")).toBe(false);
		expect(isPublicModelDiscoveryAddress("100.100.100.200")).toBe(false);
		expect(isPublicModelDiscoveryAddress("::1")).toBe(false);
		expect(isPublicModelDiscoveryAddress("::ffff:127.0.0.1")).toBe(false);
		await expect(discoverModels({ baseUrl: "http://127.0.0.1:11434/v1" })).rejects.toThrow("私有网络");
		await expect(discoverModels({ baseUrl: "http://localhost:11434/v1" })).rejects.toThrow("私有网络");
	});

	it("allows loopback discovery with the explicit allowPrivate flag (local gateways)", async () => {
		// 本地网关场景：显式勾选放行，不需要环境变量
		await withCatalogServer((_request, response) => {
			response.end(JSON.stringify({ data: [{ id: "llama-local" }] }));
		}, async (baseUrl) => {
			await expect(discoverModels({ baseUrl, allowPrivate: true })).resolves.toEqual([{ id: "llama-local" }]);
		});
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

describe("模型目录里的能力字段", () => {
	it("各家命名都能读出来，读不到就留空", () => {
		// 本机中转：context_window + modalities.input
		expect(catalogCapabilities({ context_window: 1_000_000, max_output_tokens: 32_000, modalities: { input: ["text", "image"], output: ["text"] } }))
			.toEqual({ contextWindow: 1_000_000, maxTokens: 32_000, vision: true });
		// OpenRouter：context_length + architecture.input_modalities + top_provider
		expect(catalogCapabilities({ context_length: 200_000, top_provider: { max_completion_tokens: 8192 }, architecture: { input_modalities: ["text"] } }))
			.toEqual({ contextWindow: 200_000, maxTokens: 8192, vision: false });
		// llama.cpp 风格：顶层 input_modalities + max_input_tokens，modalities 也可能是数组
		expect(catalogCapabilities({ max_input_tokens: 4096, input_modalities: ["text", "image"] })).toEqual({ contextWindow: 4096, vision: true });
		expect(catalogCapabilities({ modalities: ["text", "image"] })).toEqual({ vision: true });
		// 什么都没给就留空，让表单补缺省（不能自己编一个数）
		expect(catalogCapabilities({})).toEqual({});
		expect(catalogCapabilities({ context_window: 0, max_output_tokens: -1 })).toEqual({});
	});

	it("发现模型时把容量与视觉一起带回来", async () => {
		process.env.PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY = "1";
		await withCatalogServer((_request, response) => {
			response.end(JSON.stringify({ data: [
				{ id: "with-all", name: "全部都有", context_window: 1_000_000, max_output_tokens: 32_000, modalities: { input: ["text", "image"] } },
				{ id: "partial", context_length: 200_000, architecture: { input_modalities: ["text"] } },
				{ id: "plain" },
			] }));
		}, async (baseUrl) => {
			expect(await discoverModels({ baseUrl })).toEqual([
				{ id: "with-all", name: "全部都有", contextWindow: 1_000_000, maxTokens: 32_000, vision: true },
				{ id: "partial", contextWindow: 200_000, vision: false },
				{ id: "plain" },
			]);
		});
	});
});
