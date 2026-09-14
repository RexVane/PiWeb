import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
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
