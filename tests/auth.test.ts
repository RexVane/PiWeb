import { describe, expect, it } from "vitest";
import { isLoopbackHostname, isSafeHost, isSafeOrigin } from "../src/lib/auth";

describe("loopback hostnames", () => {
	it("recognizes loopback bind targets", () => {
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("::1")).toBe(true);
		expect(isLoopbackHostname("localhost")).toBe(true);
		expect(isLoopbackHostname("0.0.0.0")).toBe(false);
	});
});

describe("origin validation", () => {
	it("accepts same-origin and non-browser requests", () => {
		expect(isSafeOrigin(new Request("http://localhost:30141/api/test"))).toBe(true);
		expect(
			isSafeOrigin(new Request("http://localhost:30141/api/test", { headers: { origin: "http://localhost:30141" } })),
		).toBe(true);
	});

	it("rejects cross-origin browser mutations", () => {
		const request = new Request("http://localhost:30141/api/test", { headers: { origin: "https://example.com" } });
		expect(isSafeOrigin(request)).toBe(false);
	});

	it("does not trust a caller-supplied forwarded host", () => {
		const request = new Request("http://localhost:30141/api/test", {
			headers: { host: "localhost:30141", origin: "http://attacker.test:30141", "x-forwarded-host": "attacker.test:30141" },
		});
		expect(isSafeOrigin(request)).toBe(false);
	});

	it("rejects DNS-rebinding hostnames", () => {
		const rebound = new Request("http://attacker.test:30141/api/test", { headers: { host: "attacker.test:30141" } });
		expect(isSafeHost(rebound)).toBe(false);
		// 反代转发的域名进白名单才放行
		expect(isSafeHost(rebound, ["attacker.test"])).toBe(true);
		// 本机名与 IP 字面量不需要配置：IP 不可能被 rebinding 利用
		expect(isSafeHost(new Request("http://127.0.0.1:30141/api/test"))).toBe(true);
		expect(isSafeHost(new Request("http://192.168.1.5:30141/api/test"))).toBe(true);
		expect(isSafeHost(new Request("http://evil.localhost:30141/api/test"))).toBe(true);
		expect(isSafeHost(new Request("http://127.0.0.1:30141/api/test", { headers: { host: "user:pw@127.0.0.1:30141" } }))).toBe(false);
	});
});
