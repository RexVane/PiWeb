import { describe, expect, it } from "vitest";
import { isLoopbackHostname, isSafeHost, isSafeOrigin, validBasicAuthorization } from "../src/lib/auth";

describe("Basic authentication", () => {
	it("accepts only the pi user with the configured password", () => {
		const good = `Basic ${Buffer.from("pi:correct").toString("base64")}`;
		const wrongUser = `Basic ${Buffer.from("admin:correct").toString("base64")}`;
		const wrongPassword = `Basic ${Buffer.from("pi:wrong").toString("base64")}`;
		expect(validBasicAuthorization(good, "correct")).toBe(true);
		expect(validBasicAuthorization(wrongUser, "correct")).toBe(false);
		expect(validBasicAuthorization(wrongPassword, "correct")).toBe(false);
		expect(validBasicAuthorization(null, "correct")).toBe(false);
	});

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

	it("rejects DNS-rebinding hostnames without a password", () => {
		const rebound = new Request("http://attacker.test:30141/api/test", { headers: { host: "attacker.test:30141" } });
		expect(isSafeHost(rebound, false)).toBe(false);
		expect(isSafeHost(rebound, true)).toBe(true);
		expect(isSafeHost(new Request("http://127.0.0.1:30141/api/test"), false)).toBe(true);
	});
});
