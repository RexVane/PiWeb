import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_SECONDS, createSessionToken, readCookieHeader, safeNextPath, validPassword, validSessionToken } from "../src/lib/web-auth";

describe("session tokens", () => {
	const password = "hunter2";

	it("round-trips a token created for the same password", () => {
		const token = createSessionToken(password);
		expect(validSessionToken(token, password)).toBe(true);
	});

	it("rejects tokens signed with a different password", () => {
		const token = createSessionToken(password);
		expect(validSessionToken(token, "other")).toBe(false);
	});

	it("rejects expired tokens", () => {
		const issued = 1_000_000;
		const token = createSessionToken(password, issued);
		const justBeforeExpiry = issued + SESSION_MAX_AGE_SECONDS * 1000 - 1;
		expect(validSessionToken(token, password, justBeforeExpiry)).toBe(true);
		expect(validSessionToken(token, password, issued + SESSION_MAX_AGE_SECONDS * 1000)).toBe(false);
	});

	it("rejects tampered payloads and malformed values", () => {
		const token = createSessionToken(password);
		const [, signature] = token.split(".");
		const forgedExpiry = token.split(".")[0].replace(/^\d/, (digit) => (digit === "9" ? "8" : "9"));
		expect(validSessionToken(`${forgedExpiry}.${signature}`, password)).toBe(false);
		expect(validSessionToken(undefined, password)).toBe(false);
		expect(validSessionToken("", password)).toBe(false);
		expect(validSessionToken("not-a-token", password)).toBe(false);
		expect(validSessionToken(".only-signature", password)).toBe(false);
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
		const header = "other=1; piweb_session=abc.def; malformed; spaced = x";
		expect(readCookieHeader(header, "piweb_session")).toBe("abc.def");
		expect(readCookieHeader(header, "other")).toBe("1");
		expect(readCookieHeader(header, "missing")).toBeUndefined();
		expect(readCookieHeader(null, "piweb_session")).toBeUndefined();
	});

	it("treats malformed percent encoding as an invalid cookie", () => {
		expect(readCookieHeader("piweb_session=%E0%A4%A", "piweb_session")).toBeUndefined();
		expect(readCookieHeader("piweb_session=%", "piweb_session")).toBeUndefined();
	});

	it("decodes percent-encoded values", () => {
		expect(readCookieHeader("piweb_session=a%2Eb", "piweb_session")).toBe("a.b");
	});
});
