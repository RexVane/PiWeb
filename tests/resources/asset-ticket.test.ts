import { describe, expect, it, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createResourceAssetTicket, resourceAssetTicketView } from "../../src/lib/resources/asset-ticket";
import { createSessionCookie, decodeSessionCookie, sessionCookieId } from "../../src/lib/web-auth";
import { proxy } from "../../src/proxy";

const secret = Buffer.alloc(32, 7);
const now = Date.now();
const authority = "localhost:30141";
const minted = createSessionCookie(authority, secret, now, "test", 0);
const cookie = { id: sessionCookieId(minted.value), payload: decodeSessionCookie(minted.value, secret)! };
const view = Buffer.from(JSON.stringify({ cwd: "/workspace", source: "npm:resource", scope: "user", view: "main" })).toString("base64url");
const revocations = { notBefore: 0, revoked: new Map<string, number>() };
afterEach(() => vi.unstubAllEnvs());

describe("resource static-asset capability", () => {
	it("is signed, authority-bound, short-lived and inherits single-device revocation", () => {
		const ticket = createResourceAssetTicket(view, cookie, secret, now);
		expect(resourceAssetTicketView(ticket, authority, secret, revocations, now)).toBe(view);
		expect(resourceAssetTicketView(ticket, "another.example", secret, revocations, now)).toBeUndefined();
		expect(resourceAssetTicketView(ticket, authority, Buffer.alloc(32, 8), revocations, now)).toBeUndefined();
		expect(resourceAssetTicketView(ticket, authority, secret, revocations, now + 60 * 60_000)).toBeUndefined();
		expect(resourceAssetTicketView(ticket, authority, secret, { notBefore: 1, revoked: new Map() }, now)).toBeUndefined();
		expect(resourceAssetTicketView(ticket, authority, secret, { notBefore: 0, revoked: new Map([[cookie.id, cookie.payload.expiresAt]]) }, now)).toBeUndefined();
	});
	it("allows an opaque-origin script request only inside the one static view namespace", () => {
		vi.stubEnv("PI_WEB_AUTH", "1"); vi.stubEnv("PI_WEB_SECRET", secret.toString("base64url"));
		// No real agent data/revocation files can be consulted by this test.
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/piweb-no-resource-test-store");
		const ticket = createResourceAssetTicket(view, cookie, secret, now);
		const request = (path: string, method = "GET") => new NextRequest(`http://${authority}${path}`, { method, headers: { host: authority, ...(method === "GET" ? {} : { origin: `http://${authority}` }) } });
		expect(proxy(request(`/api/resources/views/${ticket}/assets/client.js`)).headers.get("x-middleware-next")).toBe("1");
		expect(proxy(request(`/api/resources/views/${ticket}/assets/client.js`, "POST")).status).toBe(401);
		expect(proxy(request(`/api/resources?ticket=${ticket}`)).status).toBe(401);
		expect(proxy(request(`/api/sessions?ticket=${ticket}`)).status).toBe(401);
		expect(proxy(request(`/api/resources/views/${view}/assets/client.js`)).status).toBe(401);
	});
});
