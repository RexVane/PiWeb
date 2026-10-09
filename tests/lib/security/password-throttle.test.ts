/**
 * 密码防爆破：单元行为（注入时钟）+ 经过 proxy（Basic）与登录接口的整条路径。
 * proxy 与路由的限速状态在模块里，整条路径的用例每次都重新加载模块。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createPasswordThrottle } from "@/lib/security/password-throttle";
import { createSessionToken } from "@/lib/security/web-auth";

describe("password throttle", () => {
	function setup(burst = 3, refillMs = 1000) {
		let clock = 0;
		const log = vi.fn();
		const throttle = createPasswordThrottle({ burst, refillMs, now: () => clock, log });
		const isRight = vi.fn((candidate: string) => candidate === "secret");
		return { throttle, isRight, log, tick: (ms: number) => { clock += ms; } };
	}

	it("allows a burst of new wrong passwords, then refuses to check any password until a try comes back", () => {
		const { throttle, isRight, log, tick } = setup();
		expect(throttle.check("secret", isRight)).toBe("right");
		for (const guess of ["a", "b", "c"]) expect(throttle.check(guess, isRight)).toBe("wrong");
		expect(log).toHaveBeenCalledTimes(1);
		isRight.mockClear();
		expect(throttle.check("secret", isRight)).toEqual({ retryAfterMs: 1000 });
		expect(throttle.check("d", isRight)).toEqual({ retryAfterMs: 1000 });
		expect(isRight).not.toHaveBeenCalled();

		tick(400);
		expect(throttle.check("secret", isRight)).toEqual({ retryAfterMs: 600 });
		tick(600);
		expect(throttle.check("e", isRight)).toBe("wrong");
		expect(throttle.check("secret", isRight)).toEqual({ retryAfterMs: 1000 });
		tick(1000);
		expect(throttle.check("secret", isRight)).toBe("right");
		expect(log).toHaveBeenCalledTimes(2);
	});

	it("does not spend the budget on a wrong password it has just seen, so a stale saved password locks no one out", () => {
		const { throttle, isRight } = setup();
		// 50 次同一个旧密码只算一次，再加一个新错误密码，3 次额度还剩 1 次
		for (let i = 0; i < 50; i += 1) expect(throttle.check("old-password", isRight)).toBe("wrong");
		expect(throttle.check("x", isRight)).toBe("wrong");
		expect(throttle.check("secret", isRight)).toBe("right");
		expect(throttle.check("y", isRight)).toBe("wrong");
		expect(throttle.check("z", isRight)).toEqual({ retryAfterMs: 1000 });
		// 额度用完后，见过的错误密码照样答“错误”，不是“稍后再试”
		expect(throttle.check("old-password", isRight)).toBe("wrong");
	});

	it("refills to the full burst after a long quiet time, not beyond", () => {
		const { throttle, isRight, tick } = setup();
		for (const guess of ["a", "b", "c"]) throttle.check(guess, isRight);
		tick(60_000);
		for (const guess of ["d", "e", "f"]) expect(throttle.check(guess, isRight)).toBe("wrong");
		expect(throttle.check("g", isRight)).toEqual({ retryAfterMs: 1000 });
	});
});

describe("throttled password checks through the app", () => {
	const PASSWORD = "test-password";
	const saved = process.env.PI_WEB_PASSWORD;
	const host = "127.0.0.1:30141";
	beforeEach(() => {
		process.env.PI_WEB_PASSWORD = PASSWORD;
		vi.resetModules();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.PI_WEB_PASSWORD;
		else process.env.PI_WEB_PASSWORD = saved;
		vi.restoreAllMocks();
	});

	const basic = (password: string) => `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
	const apiRequest = (path: string, headers: Record<string, string>) => new NextRequest(new URL(`http://${host}${path}`), { headers: { host, ...headers } });

	it("pauses HTTP Basic after ten new wrong passwords, also on the public auth API, but keeps signed-in browsers working", async () => {
		const { proxy } = await import("../../../src/proxy");
		for (let i = 0; i < 10; i += 1) expect(proxy(apiRequest("/api/version", { authorization: basic(`guess-${i}`) })).status).toBe(401);

		for (const path of ["/api/version", "/api/web-auth"]) {
			const refused = proxy(apiRequest(path, { authorization: basic(PASSWORD) }));
			expect(refused.status, path).toBe(429);
			expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
		}
		expect(proxy(apiRequest("/api/version", { authorization: basic("guess-0") })).status).toBe(401);
		const cookie = `piweb_session=${createSessionToken(PASSWORD)}`;
		expect(proxy(apiRequest("/api/version", { cookie, authorization: basic("guess-new") })).headers.get("x-middleware-next")).toBe("1");
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	it("pauses the login form after ten new wrong passwords, without checking the password it refuses", async () => {
		const { POST } = await import("../../../src/app/api/web-auth/route");
		const login = (password: string) => POST(new Request(`http://${host}/api/web-auth`, {
			method: "POST",
			headers: { "Content-Type": "application/json", host },
			body: JSON.stringify({ password }),
		}));
		for (let i = 0; i < 10; i += 1) expect((await login(`guess-${i}`)).status).toBe(401);
		const refused = await login(PASSWORD);
		expect(refused.status).toBe(429);
		expect(refused.headers.get("set-cookie")).toBeNull();
		expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(await refused.json()).toMatchObject({ success: false, error: expect.stringMatching(/too many wrong passwords/) });
		expect((await login("guess-3")).status).toBe(401);
	});
});
