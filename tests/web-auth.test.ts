import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_SECONDS, authEnabled, cookieNameForAuthority, createSessionCookie, decodeSessionCookie, readCookieHeader, requestAuthority, safeNextPath, validPassword, validSessionCookie } from "../src/lib/web-auth";

const AUTHORITY = "127.0.0.1:30141";
const SECRET = Buffer.alloc(32, 7);
const OTHER_SECRET = Buffer.alloc(32, 9);

function request(path: string, headers: Record<string, string> = {}) {
	return new Request(`http://${AUTHORITY}${path}`, { headers });
}

function cookieHeader(name: string, value: string) {
	return `${name}=${value}`;
}

/** 改动最后一个字符，保证与原值不同 */
function flipLastChar(value: string): string {
	const last = value.slice(-1);
	return value.slice(0, -1) + (last === "A" ? "B" : "A");
}

describe("session cookies", () => {
	it("round-trips a cookie for the same authority and secret", () => {
		const cookie = createSessionCookie(AUTHORITY, SECRET);
		expect(validSessionCookie(request("/", { cookie: cookieHeader(cookie.name, cookie.value) }), SECRET)).toBe(true);
	});

	it("rejects a cookie signed with another secret", () => {
		const cookie = createSessionCookie(AUTHORITY, SECRET);
		expect(validSessionCookie(request("/", { cookie: cookieHeader(cookie.name, cookie.value) }), OTHER_SECRET)).toBe(false);
	});

	it("binds the cookie to the authority", () => {
		const cookie = createSessionCookie(AUTHORITY, SECRET);
		// 换主机后 Cookie 名对不上，连取都取不到
		const otherHost = new Request("http://evil.test:30141/", { headers: { host: "evil.test:30141", cookie: cookieHeader(cookie.name, cookie.value) } });
		expect(validSessionCookie(otherHost, SECRET)).toBe(false);
		// 就算把 Cookie 改成新主机对应的名字，载荷里的权威对不上也拒
		const renamed = new Request("http://evil.test:30141/", {
			headers: { host: "evil.test:30141", cookie: cookieHeader(cookieNameForAuthority("evil.test:30141"), cookie.value) },
		});
		expect(validSessionCookie(renamed, SECRET)).toBe(false);
	});

	it("rejects expired cookies and accepts them right up to expiry", () => {
		const issued = 1_000_000;
		const cookie = createSessionCookie(AUTHORITY, SECRET, issued);
		const header = cookieHeader(cookie.name, cookie.value);
		const expiry = issued + SESSION_MAX_AGE_SECONDS * 1000;
		expect(validSessionCookie(request("/", { cookie: header }), SECRET, expiry - 1)).toBe(true);
		expect(validSessionCookie(request("/", { cookie: header }), SECRET, expiry)).toBe(false);
	});

	it("rejects tampered payloads and malformed values", () => {
		const cookie = createSessionCookie(AUTHORITY, SECRET);
		const [version, body, signature] = cookie.value.split(".");
		expect(decodeSessionCookie(cookie.value, SECRET)).toBeDefined();
		expect(decodeSessionCookie(`${version}.${body}.${flipLastChar(signature)}`, SECRET)).toBeUndefined();
		expect(decodeSessionCookie(`${version}.${body}`, SECRET)).toBeUndefined();
		expect(decodeSessionCookie(`${version}.${body}.${signature}.extra`, SECRET)).toBeUndefined();
		expect(decodeSessionCookie("v2.x.y", SECRET)).toBeUndefined();
		expect(decodeSessionCookie("", SECRET)).toBeUndefined();
		expect(decodeSessionCookie("not-a-cookie", SECRET)).toBeUndefined();
		// 伪造一个远期载荷但沿用旧签名
		const forged = Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: 0, expiresAt: 9e15 }), "utf8").toString("base64url");
		expect(decodeSessionCookie(`${version}.${forged}.${signature}`, SECRET)).toBeUndefined();
	});

	it("derives a stable, authority-specific cookie name", () => {
		expect(cookieNameForAuthority("a.test")).toBe(cookieNameForAuthority("a.test"));
		expect(cookieNameForAuthority("a.test")).not.toBe(cookieNameForAuthority("b.test"));
		expect(cookieNameForAuthority("a.test").startsWith("piweb_session_")).toBe(true);
	});

	it("ignores cookies that are absent or malformed", () => {
		expect(validSessionCookie(request("/"), SECRET)).toBe(false);
		expect(validSessionCookie(request("/", { cookie: "piweb_session_zzz=%" }), SECRET)).toBe(false);
	});
});

describe("request authority", () => {
	it("normalizes the Host header and rejects credentials", () => {
		expect(requestAuthority(request("/", { host: "127.0.0.1:30141" }))).toBe("127.0.0.1:30141");
		expect(requestAuthority(request("/", { host: "EXAMPLE.test:8443" }))).toBe("example.test:8443");
		expect(requestAuthority(request("/", { host: "user:pw@evil.test" }))).toBeUndefined();
		expect(requestAuthority(request("/", { host: "bad host" }))).toBeUndefined();
	});
});

describe("authEnabled", () => {
	it("turns on with a password or an explicit PI_WEB_AUTH", () => {
		expect(authEnabled({})).toBe(false);
		expect(authEnabled({ PI_WEB_PASSWORD: "x" })).toBe(true);
		expect(authEnabled({ PI_WEB_AUTH: "1" })).toBe(true);
		expect(authEnabled({ PI_WEB_AUTH: "TRUE" })).toBe(true);
		expect(authEnabled({ PI_WEB_AUTH: "on" })).toBe(true);
		expect(authEnabled({ PI_WEB_AUTH: "0" })).toBe(false);
		expect(authEnabled({ PI_WEB_AUTH: "" })).toBe(false);
	});
});

describe("password check", () => {
	it("accepts only the exact password", () => {
		expect(validPassword("correct", "correct")).toBe(true);
		expect(validPassword("wrong", "correct")).toBe(false);
		expect(validPassword("", "correct")).toBe(false);
		expect(validPassword("correct", "")).toBe(false);
	});
});

describe("safeNextPath", () => {
	it("keeps same-origin relative paths", () => {
		expect(safeNextPath("/")).toBe("/");
		expect(safeNextPath("/settings?tab=models")).toBe("/settings?tab=models");
		expect(safeNextPath("/a/b#frag")).toBe("/a/b");
	});

	it("rejects absolute, protocol-relative and backslash paths", () => {
		expect(safeNextPath("https://evil.test/")).toBe("/");
		expect(safeNextPath("//evil.test/")).toBe("/");
		expect(safeNextPath("\\\\evil.test\\share")).toBe("/");
		expect(safeNextPath("relative")).toBe("/");
		expect(safeNextPath(null)).toBe("/");
	});
});

describe("cookie parsing", () => {
	it("reads named cookies and ignores malformed pairs", () => {
		const header = "other=1; piweb_session_abc=abc.def; malformed; spaced = x";
		expect(readCookieHeader(header, "piweb_session_abc")).toBe("abc.def");
		expect(readCookieHeader(header, "other")).toBe("1");
		expect(readCookieHeader(header, "missing")).toBeUndefined();
		expect(readCookieHeader(null, "piweb_session_abc")).toBeUndefined();
	});

	it("treats malformed percent encoding as an invalid cookie", () => {
		expect(readCookieHeader("piweb_session_abc=%E0%A4%A", "piweb_session_abc")).toBeUndefined();
		expect(readCookieHeader("piweb_session_abc=%", "piweb_session_abc")).toBeUndefined();
	});

	it("decodes percent-encoded values", () => {
		expect(readCookieHeader("piweb_session_abc=a%2Eb", "piweb_session_abc")).toBe("a.b");
	});
});
