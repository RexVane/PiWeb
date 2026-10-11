import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";
import { DELETE, GET, POST } from "../src/app/api/web-auth/route";
import { GET as health } from "../src/app/api/health/route";
import { AUTH_THROTTLE_RESET_AFTER_MS, backoffDelayMs, createAuthThrottleState, getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess, resetAuthThrottle } from "../src/lib/auth-throttle";
import { cookieNameForAuthority } from "../src/lib/web-auth";

// NextRequest 会把 127.0.0.1 归一成 localhost，权威必须按归一后的值断言
const HOST = "localhost:30141";
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const LAUNCH_TOKEN = "launch-token-for-tests";
const ENV_NAMES = ["PI_WEB_AUTH", "PI_WEB_SECRET", "PI_WEB_LAUNCH_TOKEN", "PI_WEB_TRUSTED_HOSTS", "PI_WEB_ALLOWED_HOSTS"] as const;
const saved = new Map<string, string | undefined>(ENV_NAMES.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.PI_WEB_AUTH = "1";
	process.env.PI_WEB_SECRET = SECRET;
	process.env.PI_WEB_LAUNCH_TOKEN = LAUNCH_TOKEN;
	delete process.env.PI_WEB_TRUSTED_HOSTS;
	delete process.env.PI_WEB_ALLOWED_HOSTS;
	resetAuthThrottle();
});

afterEach(() => {
	for (const name of ENV_NAMES) {
		const value = saved.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	resetAuthThrottle();
});

function pageRequest(path: string, headers: Record<string, string> = {}) {
	return new NextRequest(new URL(`http://${HOST}${path}`), { headers });
}

function apiRequest(path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("host", HOST);
	return new Request(`http://${HOST}${path}`, { ...init, headers });
}

/** 唯一的登录路径：根路径 GET 带启动令牌换一张会话 Cookie */
function sessionCookie(): string {
	const response = proxy(pageRequest(`/?token=${LAUNCH_TOKEN}`));
	expect(response.status).toBe(303);
	const match = /^(piweb_session_[A-Za-z0-9_-]+=[^;]+)/.exec(response.headers.get("set-cookie") ?? "");
	expect(match).not.toBeNull();
	return match![1];
}

describe("proxy authentication gate", () => {
	it("passes everything through when authentication is disabled", () => {
		delete process.env.PI_WEB_AUTH;
		const response = proxy(pageRequest("/"));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});

	it("enforces the Host allowlist even when authentication is disabled", () => {
		delete process.env.PI_WEB_AUTH;
		expect(proxy(pageRequest("/", { host: "attacker.test" })).status).toBe(403);
		expect(proxy(pageRequest("/", { host: "pi.example.com" })).status).toBe(403);
		process.env.PI_WEB_TRUSTED_HOSTS = "pi.example.com";
		expect(proxy(pageRequest("/", { host: "pi.example.com" })).headers.get("x-middleware-next")).toBe("1");
	});

	it("accepts PI_WEB_ALLOWED_HOSTS too (upstream name)", () => {
		expect(proxy(pageRequest("/", { host: "pi.example.com" })).status).toBe(403);
		process.env.PI_WEB_ALLOWED_HOSTS = "pi.example.com";
		// 放行指的是不再判 untrusted host（改成跳登录页），而不是直接给内容
		expect(proxy(pageRequest("/", { host: "pi.example.com" })).status).toBe(307);
	});

	it("enables authentication from PI_WEB_AUTH alone (the only switch)", () => {
		expect(proxy(pageRequest("/api/version")).status).toBe(401);
		expect(proxy(pageRequest("/")).status).toBe(307);
	});

	it("redirects anonymous page requests to the login page with a next target", () => {
		const response = proxy(pageRequest("/settings?tab=models"));
		expect(response.status).toBe(307);
		const location = new URL(response.headers.get("location")!);
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("next")).toBe("/settings?tab=models");
	});

	it("answers anonymous API requests with 401 and no Basic challenge", async () => {
		const response = proxy(pageRequest("/api/version"));
		expect(response.status).toBe(401);
		// 没有 Basic 了，再发挑战头只会骗脚本去试一条不存在的路
		expect(response.headers.get("www-authenticate")).toBeNull();
	});

	it("exposes only a minimal health signature without credentials", async () => {
		for (const method of ["GET", "HEAD"]) {
			const request = new NextRequest(`http://${HOST}/api/health`, { method });
			expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
		}
		expect(await health().json()).toEqual({ success: true, data: { ok: true, service: "piweb" } });
		const mutation = new NextRequest(`http://${HOST}/api/health`, { method: "POST" });
		expect(proxy(mutation).status).toBe(401);
		expect(proxy(pageRequest("/api/health", { host: "untrusted.example" })).status).toBe(403);
	});

	it("keeps the login page and auth API reachable without credentials", () => {
		for (const path of ["/login", "/api/web-auth"]) {
			const response = proxy(pageRequest(path));
			expect(response.headers.get("x-middleware-next"), path).toBe("1");
		}
	});

	it("lets static assets load without credentials (dev assetPrefix and production _next)", () => {
		// 回归：dev 的资源前缀是 /_piweb-dev/<id>，被拦会导致登录页 JS 不加载、提示不水合
		for (const path of ["/_piweb-dev/abc123/_next/static/chunks/main-app.js", "/_next/static/chunks/main-app.js", "/icon.svg"]) {
			const response = proxy(pageRequest(path));
			expect(response.headers.get("x-middleware-next"), path).toBe("1");
		}
	});

	it("does not accept an Authorization header as a credential", () => {
		expect(proxy(pageRequest("/api/version", { authorization: `Bearer ${LAUNCH_TOKEN}`, host: HOST })).status).toBe(401);
		expect(proxy(pageRequest("/api/version", { authorization: "Basic cGk6c2VjcmV0", host: HOST })).status).toBe(401);
	});

	it("accepts a valid session cookie for page and API requests", () => {
		const cookie = sessionCookie();
		for (const path of ["/", "/api/version"]) {
			const response = proxy(pageRequest(path, { cookie, host: HOST }));
			expect(response.headers.get("x-middleware-next"), path).toBe("1");
		}
	});

	it("rejects a tampered session cookie", () => {
		const cookie = sessionCookie();
		const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
		expect(proxy(pageRequest("/", { cookie: tampered, host: HOST })).status).toBe(307);
	});

	it("rejects a cookie that was issued for another host", () => {
		const cookie = sessionCookie();
		const value = cookie.slice(cookie.indexOf("=") + 1);
		process.env.PI_WEB_TRUSTED_HOSTS = "evil.test";
		const renamed = `${cookieNameForAuthority("evil.test:30141")}=${value}`;
		expect(proxy(pageRequest("/", { cookie: renamed, host: "evil.test:30141" })).status).toBe(307);
	});

	it("rejects malformed cookies without throwing", () => {
		expect(proxy(pageRequest("/api/version", { cookie: "piweb_session_zzz=%" })).status).toBe(401);
	});

	it("still rejects cross-origin mutations", () => {
		const request = new NextRequest(new URL(`http://${HOST}/api/web-auth`), {
			method: "POST",
			headers: { origin: "https://evil.test", host: HOST },
		});
		expect(proxy(request).status).toBe(403);
	});

	it("rejects a mutation the browser reports as cross-site even when the Origin matches", () => {
		const request = new NextRequest(new URL(`http://${HOST}/api/web-auth`), {
			method: "POST",
			headers: { origin: `http://${HOST}`, host: HOST, "sec-fetch-site": "cross-site" },
		});
		expect(proxy(request).status).toBe(403);
	});
});

describe("launch token exchange", () => {
	it("mints a cookie and redirects to a clean root", () => {
		const response = proxy(pageRequest(`/?token=${LAUNCH_TOKEN}`));
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(`http://${HOST}/`);
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("cache-control")).toBe("no-store");
		const setCookie = (response.headers.get("set-cookie") ?? "").toLowerCase();
		expect(setCookie).toContain("piweb_session_");
		expect(setCookie).toContain("httponly");
		expect(setCookie).toContain("samesite=strict");
	});

	it("mints a cookie that then authenticates", () => {
		const cookie = sessionCookie();
		expect(proxy(pageRequest("/api/version", { cookie, host: HOST })).headers.get("x-middleware-next")).toBe("1");
	});

	it("rejects a wrong token", () => {
		expect(proxy(pageRequest("/?token=wrong")).status).toBe(307);
	});

	it("rejects a repeated token parameter", () => {
		expect(proxy(pageRequest(`/?token=${LAUNCH_TOKEN}&token=${LAUNCH_TOKEN}`)).status).toBe(307);
	});

	it("does not accept the token on API paths", () => {
		expect(proxy(pageRequest(`/api/version?token=${LAUNCH_TOKEN}`)).status).toBe(401);
	});

	it("does not accept the token in the Authorization header", () => {
		expect(proxy(pageRequest("/api/version", { authorization: `Bearer ${LAUNCH_TOKEN}` })).status).toBe(401);
	});

	it("does not exchange tokens when authentication is disabled", () => {
		delete process.env.PI_WEB_AUTH;
		const response = proxy(pageRequest(`/?token=${LAUNCH_TOKEN}`));
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});

	it("clears a leftover token from the URL when the cookie is still valid", () => {
		const cookie = sessionCookie();
		const response = proxy(pageRequest("/?token=stale", { cookie, host: HOST }));
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(`http://${HOST}/`);
	});
});

describe("web-auth route", () => {
	it("reports enabled + authenticated state", async () => {
		const anonymous = await GET(apiRequest("/api/web-auth"));
		expect(await anonymous.json()).toEqual({ success: true, data: { enabled: true, authenticated: false } });

		const cookie = sessionCookie();
		const signed = await GET(apiRequest("/api/web-auth", { headers: { cookie } }));
		expect(await signed.json()).toEqual({ success: true, data: { enabled: true, authenticated: true } });
	});

	it("reports enabled:false when authentication is off", async () => {
		delete process.env.PI_WEB_AUTH;
		const response = await GET(apiRequest("/api/web-auth"));
		expect(await response.json()).toEqual({ success: true, data: { enabled: false, authenticated: true } });
	});

	it("answers password login attempts with 410 Gone", async () => {
		const response = await POST(apiRequest("/api/web-auth", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "x" }),
		}));
		expect(response.status).toBe(410);
		expect(await response.json()).toEqual({
			success: false,
			error: "password login has been removed; use the launch token link printed at startup",
		});
	});

	it("still refuses a cross-origin password attempt (the 410 is a write method)", async () => {
		const response = await POST(apiRequest("/api/web-auth", {
			method: "POST",
			headers: { origin: "https://evil.test", "Content-Type": "application/json" },
			body: JSON.stringify({ password: "x" }),
		}));
		expect(response.status).toBe(403);
	});

	it("clears the session cookie on logout", async () => {
		const response = await DELETE(apiRequest("/api/web-auth", { method: "DELETE" }));
		const setCookie = response.headers.get("set-cookie") ?? "";
		expect(setCookie).toMatch(/^piweb_session_[A-Za-z0-9_-]+=;/);
		expect(setCookie.toLowerCase()).toContain("max-age=0");
	});
});

describe("login throttle", () => {
	it("backs off exponentially and caps at 60 seconds", () => {
		expect(backoffDelayMs(0)).toBe(0);
		expect(backoffDelayMs(1)).toBe(1_000);
		expect(backoffDelayMs(2)).toBe(2_000);
		expect(backoffDelayMs(3)).toBe(4_000);
		expect(backoffDelayMs(20)).toBe(60_000);
	});

	it("forgets the counter after the idle window", () => {
		const state = createAuthThrottleState();
		const now = 1_000_000;
		recordAuthFailure(now, state);
		expect(getAuthRetryAfterMs(now, state)).toBe(1_000);
		expect(getAuthRetryAfterMs(now + AUTH_THROTTLE_RESET_AFTER_MS + 1, state)).toBe(0);
	});

	it("clears the counter after a successful login", () => {
		const state = createAuthThrottleState();
		const now = 1_000_000;
		recordAuthFailure(now, state);
		recordAuthSuccess(state);
		expect(getAuthRetryAfterMs(now, state)).toBe(0);
	});
});
