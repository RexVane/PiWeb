import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";
import { DELETE, GET, POST } from "../src/app/api/web-auth/route";
import { GET as health } from "../src/app/api/health/route";

const PASSWORD = "test-password";
const saved = process.env.PI_WEB_PASSWORD;

beforeEach(() => {
	process.env.PI_WEB_PASSWORD = PASSWORD;
});
afterEach(() => {
	if (saved === undefined) delete process.env.PI_WEB_PASSWORD;
	else process.env.PI_WEB_PASSWORD = saved;
});

function pageRequest(path: string, headers: Record<string, string> = {}) {
	return new NextRequest(new URL(`http://127.0.0.1:30141${path}`), { headers });
}

function basicHeader(password = PASSWORD, user = "pi") {
	return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function sessionCookie(): Promise<string> {
	const response = await POST(
		new Request("http://127.0.0.1:30141/api/web-auth", {
			method: "POST",
			headers: { "Content-Type": "application/json", host: "127.0.0.1:30141" },
			body: JSON.stringify({ password: PASSWORD }),
		}),
	);
	expect(response.status).toBe(200);
	const setCookie = response.headers.get("set-cookie") ?? "";
	const match = /piweb_session=([^;]+)/.exec(setCookie);
	expect(match).not.toBeNull();
	return `piweb_session=${match![1]}`;
}

describe("proxy authentication gate", () => {
	it("passes everything through when no password is configured", () => {
		delete process.env.PI_WEB_PASSWORD;
		const response = proxy(pageRequest("/"));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});

	it("redirects anonymous page requests to the login page with a next target", () => {
		const response = proxy(pageRequest("/settings?tab=models"));
		expect(response.status).toBe(307);
		const location = new URL(response.headers.get("location")!);
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("next")).toBe("/settings?tab=models");
	});

	it("answers anonymous API requests with 401 and a Basic challenge", async () => {
		const response = proxy(pageRequest("/api/version"));
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain('realm="PiWeb"');
	});

	it("exposes only a minimal health signature without credentials", async () => {
		for (const method of ["GET", "HEAD"]) {
			const request = new NextRequest("http://127.0.0.1:30141/api/health", { method });
			expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
		}
		expect(await health().json()).toEqual({ success: true, data: { ok: true, service: "piweb" } });
		const mutation = new NextRequest("http://127.0.0.1:30141/api/health", { method: "POST" });
		expect(proxy(mutation).status).toBe(401);
		delete process.env.PI_WEB_PASSWORD;
		expect(proxy(pageRequest("/api/health", { host: "untrusted.example" })).status).toBe(403);
	});

	it("keeps the login page and auth API reachable without credentials", () => {
		for (const path of ["/login", "/api/web-auth"]) {
			const response = proxy(pageRequest(path));
			expect(response.headers.get("x-middleware-next"), path).toBe("1");
		}
	});

	it("lets static assets load without credentials (dev assetPrefix and production _next)", () => {
		// 回归：dev 的资源前缀是 /_piweb-dev/<id>，被拦会导致登录页 JS 不加载、表单不水合
		for (const path of ["/_piweb-dev/abc123/_next/static/chunks/main-app.js", "/_next/static/chunks/main-app.js", "/icon.svg"]) {
			const response = proxy(pageRequest(path));
			expect(response.headers.get("x-middleware-next"), path).toBe("1");
		}
	});

	it("accepts Basic credentials for API clients", () => {
		const response = proxy(pageRequest("/api/version", { authorization: basicHeader(), host: "127.0.0.1:30141" }));
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});

	it("accepts a valid session cookie for page and API requests", async () => {
		const cookie = await sessionCookie();
		for (const path of ["/", "/api/version"]) {
			const response = proxy(pageRequest(path, { cookie, host: "127.0.0.1:30141" }));
			expect(response.headers.get("x-middleware-next"), path).toBe("1");
		}
	});

	it("rejects a tampered session cookie", async () => {
		const cookie = await sessionCookie();
		const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
		expect(proxy(pageRequest("/", { cookie: tampered, host: "127.0.0.1:30141" })).status).toBe(307);
	});

	it("rejects malformed cookies without throwing", () => {
		expect(proxy(pageRequest("/api/version", { cookie: "piweb_session=%" })).status).toBe(401);
	});

	it("still rejects cross-origin mutations", () => {
		const request = new NextRequest(new URL("http://127.0.0.1:30141/api/web-auth"), {
			method: "POST",
			headers: { origin: "https://evil.test", host: "127.0.0.1:30141" },
		});
		expect(proxy(request).status).toBe(403);
	});
});

describe("web-auth route", () => {
	it("reports enabled + authenticated state", async () => {
		const anonymous = await GET(new Request("http://127.0.0.1:30141/api/web-auth", { headers: { host: "127.0.0.1:30141" } }));
		expect(await anonymous.json()).toMatchObject({ success: true, data: { enabled: true, authenticated: false } });

		const cookie = await sessionCookie();
		const signed = await GET(new Request("http://127.0.0.1:30141/api/web-auth", { headers: { host: "127.0.0.1:30141", cookie } }));
		expect(await signed.json()).toMatchObject({ success: true, data: { enabled: true, authenticated: true } });
	});

	it("rejects wrong passwords with 401", async () => {
		const response = await POST(
			new Request("http://127.0.0.1:30141/api/web-auth", {
				method: "POST",
				headers: { "Content-Type": "application/json", host: "127.0.0.1:30141" },
				body: JSON.stringify({ password: "wrong" }),
			}),
		);
		expect(response.status).toBe(401);
	});

	it("rejects oversized unauthenticated login bodies", async () => {
		const response = await POST(new Request("http://127.0.0.1:30141/api/web-auth", {
			method: "POST", headers: { "Content-Type": "application/json", host: "127.0.0.1:30141" },
			body: JSON.stringify({ password: "x".repeat(16 * 1024) }),
		}));
		expect(response.status).toBe(413);
	});

	it("rejects null and non-object login payloads", async () => {
		for (const body of ["null", "[]", "true", "\"password\""]) {
			const response = await POST(new Request("http://127.0.0.1:30141/api/web-auth", {
				method: "POST", headers: { "Content-Type": "application/json", host: "127.0.0.1:30141" }, body,
			}));
			expect(response.status).toBe(400);
		}
	});

	it("sanitizes the next target in the login response", async () => {
		const response = await POST(
			new Request("http://127.0.0.1:30141/api/web-auth", {
				method: "POST",
				headers: { "Content-Type": "application/json", host: "127.0.0.1:30141" },
				body: JSON.stringify({ password: PASSWORD, next: "//evil.test" }),
			}),
		);
		expect(await response.json()).toMatchObject({ data: { next: "/" } });
	});

	it("clears the session cookie on logout", async () => {
		const response = await DELETE(new Request("http://127.0.0.1:30141/api/web-auth", { method: "DELETE", headers: { host: "127.0.0.1:30141" } }));
		const setCookie = response.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("piweb_session=");
		expect(setCookie.toLowerCase()).toContain("max-age=0");
	});

	it("404s login attempts when no password is configured", async () => {
		delete process.env.PI_WEB_PASSWORD;
		const response = await POST(
			new Request("http://127.0.0.1:30141/api/web-auth", {
				method: "POST",
				headers: { "Content-Type": "application/json", host: "127.0.0.1:30141" },
				body: JSON.stringify({ password: "x" }),
			}),
		);
		expect(response.status).toBe(404);
	});
});
