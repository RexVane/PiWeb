/**
 * L2：`configuredCredentialFor` 的 getAuth 与 checkAuth 必须共享同一个 20s 超时 signal，
 * 不能只给第一条认证查询传 signal 而让 checkAuth 无上限挂起。
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getModelRuntime: vi.fn() }));
vi.mock("../src/lib/pi", () => ({
	getModelRuntime: mocks.getModelRuntime,
	getAgentDir: () => { throw new Error("credential lookups must go through the SDK"); },
	refreshModelRuntime: vi.fn(),
}));

import { discoverModels } from "../src/lib/models-service";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function withCatalog<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
	const server = createServer((_request, response) => {
		response.statusCode = 200;
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ data: [{ id: "remote-model" }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

describe("configured credential lookup timeout", () => {
	it("passes the same abort signal to getAuth and checkAuth", async () => {
		await withCatalog(async (baseUrl) => {
			const getAuth = vi.fn(async () => ({ auth: { apiKey: "resolved-key", baseUrl } }));
			const checkAuth = vi.fn(async () => ({ type: "oauth" as const }));
			mocks.getModelRuntime.mockResolvedValue({
				getAuth,
				checkAuth,
				getProviders: () => [{ id: "signal-provider", baseUrl }],
				getModels: () => [],
			});
			const models = await discoverModels({ baseUrl, providerId: "signal-provider", allowPrivate: true });
			expect(models).toEqual([{ id: "remote-model" }]);
			expect(getAuth).toHaveBeenCalledTimes(1);
			expect(checkAuth).toHaveBeenCalledTimes(1);
			const getAuthOptions = getAuth.mock.calls[0] as unknown as [string, { signal?: AbortSignal }];
			const checkAuthOptions = checkAuth.mock.calls[0] as unknown as [string, { signal?: AbortSignal }];
			expect(getAuthOptions[0]).toBe("signal-provider");
			expect(checkAuthOptions[0]).toBe("signal-provider");
			expect(getAuthOptions[1]?.signal).toBeInstanceOf(AbortSignal);
			expect(checkAuthOptions[1]?.signal).toBeInstanceOf(AbortSignal);
			// 复用同一个控制器：两条认证查询共享 20s 总预算，而不是各自重置。
			expect(checkAuthOptions[1]?.signal).toBe(getAuthOptions[1]?.signal);
		});
	});
});

// 仅为类型检查保留 headers 类型引用（IncomingHttpHeaders 在其它模型目录测试里使用）。
export type CatalogHeaders = IncomingHttpHeaders;
