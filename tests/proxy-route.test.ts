import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ automatic: vi.fn(), test: vi.fn() }));
vi.mock("../src/lib/proxy-status", async (original) => ({ ...await original<typeof import("../src/lib/proxy-status")>(), automaticProxy: mocks.automatic, testProxyConnection: mocks.test }));
import { GET, POST } from "../src/app/api/proxy/route";

describe("proxy diagnostic route", () => {
	it("returns uncached detected addresses without proxy credentials", async () => {
		mocks.automatic.mockReturnValue({ source: "system", http: "http://alice:password@proxy.local:8080", https: "http://alice:password@proxy.local:8080" });
		const response = await GET();
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(JSON.stringify(await response.json())).not.toMatch(/alice|password/);
	});

	it("rejects malformed input and arbitrary target URLs before starting a test", async () => {
		mocks.test.mockClear();
		for (const body of ["{", "[]", '{"proxy":123}', '{"proxy":"","target":"http://localhost/private"}']) {
			const response = await POST(new Request("http://localhost/api/proxy", { method: "POST", body }));
			expect(response.status).toBe(400);
		}
		expect(mocks.test).not.toHaveBeenCalled();
	});

	it("tests the requested address without writing any settings", async () => {
		mocks.test.mockResolvedValue({ ok: true, latencyMs: 15 });
		const response = await POST(new Request("http://localhost/api/proxy", { method: "POST", body: '{"proxy":"http://manual:8080"}' }));
		expect(mocks.test).toHaveBeenCalledWith("http://manual:8080", expect.objectContaining({ automatic: expect.any(Object) }));
		expect((await response.json()).data.test).toEqual({ ok: true, latencyMs: 15 });
	});
});
