import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { POST } from "@/app/api/remote/pair/route";
import { GET as redeem, HEAD as probe } from "@/app/pair/route";
import { proxy } from "@/proxy";
import { pendingPairCount, resetPairingState, verifyPairCode } from "@/lib/remote/pairing";
import { flushWebDevices, listWebDevices } from "@/lib/web-devices";
import { recycleFixture } from "./lib/sandbox/fixtures";

const store = vi.hoisted(() => ({ agentDir: "", notBefore: 0, unavailable: false }));

const remote = vi.hoisted(() => ({
	blocked: null as "auth" | "dev" | null,
	lan: { running: true, urls: ["http://192.168.1.10:30142"] },
	public: { running: true, ready: true, url: "https://pair-fixture.trycloudflare.com" as string | null },
}));
vi.mock("@/lib/remote/supervisor", () => ({
	refreshPublicStatus: vi.fn(async () => {}),
	remoteBlocked: () => remote.blocked,
	remoteStatus: () => remote,
}));
vi.mock("@/lib/web-secret", () => ({
	agentDir: () => store.agentDir,
	loadWebSecret: () => Buffer.alloc(32, 11),
	loadSessionRevocations: () => ({ notBefore: store.notBefore, revoked: new Map(), unavailable: store.unavailable }),
}));

const pair = async (body: object = {}) => POST(new Request("http://localhost/api/remote/pair", { method: "POST", body: JSON.stringify(body) }));
beforeEach(async () => {
	store.agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-pair-route-"));
	store.notBefore = 0;
	store.unavailable = false;
	resetPairingState();
	vi.stubEnv("PI_WEB_AUTH", "1");
	vi.stubEnv("PI_WEB_TRUSTED_HOSTS", "pair-fixture.trycloudflare.com");
	remote.blocked = null;
	remote.lan.running = true;
	remote.public = { running: true, ready: true, url: "https://pair-fixture.trycloudflare.com" };
});
afterEach(async () => {
	await flushWebDevices();
	resetPairingState(); vi.unstubAllEnvs();
	await recycleFixture(store.agentDir);
});

describe("unified remote pairing", () => {
	it("replaces another instance's revoked pending QR before returning it to the panel", async () => {
		const previous = (await (await pair()).json()).data;
		// An external commit advances the shared file, leaving this map untouched.
		store.notBefore = Date.now() + 1;
		const refreshed = (await (await pair({ previousCode: previous.code })).json()).data;
		expect(refreshed.code).not.toBe(previous.code);
		expect((await (await pair()).json()).data.code).toBe(refreshed.code);
		expect((await redeem(new NextRequest(refreshed.url))).headers.get("set-cookie")).not.toBeNull();
		expect((await redeem(new NextRequest(previous.url))).headers.get("set-cookie")).toBeNull();
		store.unavailable = true;
		expect((await pair()).status).toBe(503);
	});
	it("issues one universal QR, waits for its address to be ready, and replaces a consumed code", async () => {
		const firstResponse = await pair();
		expect(firstResponse.headers.get("cache-control")).toBe("no-store");
		const first = (await firstResponse.json()).data;
		expect(first).toMatchObject({ base: "public", remainingMs: expect.any(Number) });
		expect(first.url).toBe(`https://pair-fixture.trycloudflare.com/pair?code=${first.code}`);
		remote.public.ready = false;
		expect((await pair({ previousCode: first.code })).status).toBe(409);
		const fallback = (await (await pair({ base: "lan", previousCode: first.code })).json()).data;
		expect(fallback).toMatchObject({ base: "lan", code: first.code, expiresAt: first.expiresAt });
		expect(fallback.url).toBe(`http://192.168.1.10:30142/pair?code=${first.code}`);
		expect(verifyPairCode(first.code)).toEqual({ ok: true });
		remote.public.ready = true;
		const next = (await (await pair({ previousCode: first.code })).json()).data;
		expect(next.code).not.toBe(first.code);
		expect(pendingPairCount()).toBe(1);
	});

	it("answers a link-preview HEAD without spending the one-time code", async () => {
		const data = (await (await pair({ base: "lan" })).json()).data;
		const response = probe();
		expect(response.status).toBe(405);
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(pendingPairCount()).toBe(1);
		expect((await redeem(new NextRequest(data.url))).headers.get("set-cookie")).not.toBeNull();
	});

	it("does not issue credentials for an unavailable requested network or a blocked instance", async () => {
		remote.public.ready = false;
		expect((await pair({ base: "public" })).status).toBe(409);
		remote.lan.running = false;
		expect((await pair()).status).toBe(409);
		remote.blocked = "dev";
		expect((await pair()).status).toBe(409);
		vi.stubEnv("PI_WEB_AUTH", "0");
		expect((await pair()).status).toBe(409);
		expect(pendingPairCount()).toBe(0);
	});

	it("signs in from either network once and binds the resulting cookie to that entry", async () => {
		for (const base of ["lan", "public"]) {
			const data = (await (await pair({ base })).json()).data;
			const response = await redeem(new NextRequest(data.url));
			expect(response.status).toBe(303);
			const cookie = response.headers.get("set-cookie")!.split(";")[0];
			const origin = new URL(data.url).origin;
			const accepted = proxy(new NextRequest(`${origin}/api/settings`, { headers: { cookie } }));
			expect(accepted.headers.get("x-middleware-next")).toBe("1");
			const otherOrigin = base === "lan" ? "https://pair-fixture.trycloudflare.com" : "http://192.168.1.10:30142";
			expect(proxy(new NextRequest(`${otherOrigin}/api/settings`, { headers: { cookie } })).status).toBe(401);
			const repeated = await redeem(new NextRequest(data.url));
			expect(repeated.headers.get("set-cookie")).toBeNull();
		}
		expect(await listWebDevices()).toHaveLength(2);
	});

	it("returns a retry interval for repeated invalid attempts", async () => {
		for (let index = 0; index < 30; index += 1) await redeem(new Request("http://localhost/pair?code=000000"));
		const response = await redeem(new Request("http://localhost/pair?code=000001"));
		expect(response.status).toBe(429);
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	it("keeps redirects on the scanned origin when Next supplies an internal request URL", async () => {
		const data = (await (await pair()).json()).data;
		const scanned = new URL(data.url);
		const request = () => new NextRequest(`http://127.0.0.1:30141${scanned.pathname}${scanned.search}`, {
			headers: { host: scanned.host, "x-forwarded-proto": "https" },
		});
		const accepted = await redeem(request());
		expect(accepted.status).toBe(303);
		expect(new URL(accepted.headers.get("location")!, scanned.origin).href).toBe(`${scanned.origin}/`);
		expect(accepted.headers.get("set-cookie")).toContain("Secure");
		const cookie = accepted.headers.get("set-cookie")!.split(";")[0];
		expect(proxy(new NextRequest(`${scanned.origin}/api/settings`, { headers: { cookie } })).headers.get("x-middleware-next")).toBe("1");
		const expired = await redeem(request());
		expect(new URL(expired.headers.get("location")!, scanned.origin).href).toBe(`${scanned.origin}/login?pair=unknown`);
		expect(expired.headers.get("cache-control")).toBe("no-store");
	});
});
