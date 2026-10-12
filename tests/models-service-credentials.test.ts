import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getModelRuntime: vi.fn() }));
vi.mock("../src/lib/pi", () => ({
	getModelRuntime: mocks.getModelRuntime,
	// 凭证只能经 SDK 解析，不能再自己去读 auth.json / models.json
	getAgentDir: () => { throw new Error("credential lookups must go through the SDK"); },
	refreshModelRuntime: vi.fn(),
}));

import { discoverModels, providerUsage } from "../src/lib/models-service";

let runtime: ModelRuntime;
let credentials: InMemoryCredentialStore;

beforeEach(async () => {
	credentials = new InMemoryCredentialStore();
	runtime = await ModelRuntime.create({
		modelsPath: null, credentials, modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false, refreshOnCreate: false,
	});
	vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
	mocks.getModelRuntime.mockReset().mockResolvedValue(runtime);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function register(id: string, baseUrl: string, auth: Provider["auth"]) {
	runtime.registerNativeProvider({
		id, name: id, baseUrl, getModels: () => [], auth,
		stream: () => { throw new Error("model calls are forbidden"); },
		streamSimple: () => { throw new Error("model calls are forbidden"); },
	});
}

/** 本地假目录：记下收到的请求头，status 决定回什么 */
async function withCatalog<T>(status: number, run: (baseUrl: string, seen: IncomingHttpHeaders[]) => Promise<T>): Promise<T> {
	const seen: IncomingHttpHeaders[] = [];
	const server = createServer((request, response) => {
		seen.push(request.headers);
		response.statusCode = status;
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ data: [{ id: "remote-model" }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

describe("configured credentials follow the SDK's resolution", () => {
	it("uses the key the SDK resolves (env / !command / models.json) only on the provider's own endpoint", async () => {
		await withCatalog(200, async (baseUrl, seen) => {
			register("piweb-cred-env", baseUrl, {
				apiKey: { name: "Test key", resolve: async () => ({ auth: { apiKey: "resolved-key" }, source: "TEST_KEY" }) },
			});
			await expect(discoverModels({ baseUrl, providerId: "piweb-cred-env", allowPrivate: true })).resolves.toEqual([{ id: "remote-model" }]);
			expect(seen[0].authorization).toBe("Bearer resolved-key");
			await expect(discoverModels({ baseUrl: `${baseUrl}/elsewhere`, providerId: "piweb-cred-env", allowPrivate: true }))
				.rejects.toThrow("已配置的凭证只能用于该 Provider 已配置的 API 地址");
			expect(seen).toHaveLength(1);
		});
	});

	it("reads header-only OAuth tokens and sends them the Anthropic OAuth way", async () => {
		await withCatalog(200, async (baseUrl, seen) => {
			register("piweb-cred-oauth", baseUrl, {
				oauth: {
					name: "Test OAuth",
					login: async () => { throw new Error("login is forbidden"); },
					refresh: async () => { throw new Error("refresh is forbidden"); },
					toAuth: async (credential) => ({ headers: { Authorization: `Bearer ${credential.access}` } }),
				},
			});
			await credentials.modify("piweb-cred-oauth", async () => ({ type: "oauth", access: "oauth-token", refresh: "r", expires: Date.now() + 3_600_000 }));
			await discoverModels({ baseUrl, api: "anthropic-messages", providerId: "piweb-cred-oauth", allowPrivate: true });
			expect(seen[0]["x-api-key"]).toBe("oauth-token");
			expect(seen[0]["anthropic-beta"]).toBe("oauth-2025-04-20");
		});
	});

	it("trusts the base URL that comes with the resolved auth (Copilot enterprise style)", async () => {
		await withCatalog(200, async (baseUrl, seen) => {
			register("piweb-cred-auth-url", "https://default.invalid/v1", {
				apiKey: { name: "Test key", resolve: async () => ({ auth: { apiKey: "k", baseUrl } }) },
			});
			await discoverModels({ baseUrl, providerId: "piweb-cred-auth-url", allowPrivate: true });
			expect(seen[0].authorization).toBe("Bearer k");
		});
	});

	it("never surfaces credential resolution errors, which can quote the command", async () => {
		await withCatalog(401, async (baseUrl, seen) => {
			register("piweb-cred-broken", baseUrl, {
				apiKey: { name: "Test key", resolve: async () => { throw new Error("command `!print-secret` failed"); } },
			});
			const error = await discoverModels({ baseUrl, providerId: "piweb-cred-broken", allowPrivate: true }).catch((reason: Error) => reason);
			expect(String(error)).toContain("请先填写 API 密钥");
			expect(String(error)).not.toContain("print-secret");
			expect(seen[0].authorization).toBeUndefined();
		});
	});

	it("lets usage probes use keys that only exist in the environment", async () => {
		// 以前只读 auth.json / models.json 的原文，环境变量里的密钥探测不到余额
		vi.stubEnv("DEEPSEEK_API_KEY", "env-only-key");
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
			balance_infos: [{ currency: "CNY", total_balance: "12.5", granted_balance: "0", topped_up_balance: "12.5" }],
		}), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const usage = await providerUsage("deepseek", true);
		expect(usage).toMatchObject({ kind: "balance", primary: { amount: "12.50", currency: "CNY" } });
		expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer env-only-key");
	});
});
