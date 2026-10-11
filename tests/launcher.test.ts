import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http, { type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLaunchPlan, isLoopback, isPiWebRunning, localUrl, parseLauncherArgs, probePort, runLauncher, tokenLoginUrl, warmFirstPaint, FIRST_PAINT_ROUTES } from "../scripts/launcher.mjs";
import { runDev } from "../scripts/dev.mjs";
import { resolveBuildOutput, selectProductionBuild } from "../scripts/build-output.mjs";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function installation() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-launcher-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "pi-web", version: "1.0.0" }));
	// Mark it as a development checkout (test dev dependencies present) so the
	// launcher does not try to prepare an install-time production build.
	await fs.mkdir(path.join(root, "node_modules", "vitest"), { recursive: true });
	await fs.writeFile(path.join(root, "node_modules", "vitest", "package.json"), "{}");
	return root;
}

async function productionBuild(root: string, buildDir = ".next", buildId = "build-id") {
	const files = ["BUILD_ID", "routes-manifest.json", "build-manifest.json", "prerender-manifest.json", "server/app-paths-manifest.json"];
	for (const file of files) {
		const full = path.join(root, buildDir, file);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, file === "BUILD_ID" ? buildId : "{}");
	}
	await fs.writeFile(path.join(root, buildDir, "required-server-files.json"), JSON.stringify({
		version: 1, config: { distDir: buildDir }, files: files.map((file) => `${buildDir}/${file}`),
	}));
}

async function fakeHttp(handler: (headers: IncomingHttpHeaders, response: ServerResponse) => void) {
	const server = http.createServer((request, response) => handler(request.headers, response));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	cleanups.push(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	const address = server.address() as { port: number };
	return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}

const health = JSON.stringify({ success: true, data: { ok: true, service: "piweb" } });

describe("credential-free launcher health", () => {
	it("does not send a password, cookie, or follow a forged PiWeb authentication challenge", async () => {
		const seen: IncomingHttpHeaders[] = [];
		const server = await fakeHttp((headers, response) => {
			seen.push(headers);
			response.writeHead(401, { "www-authenticate": 'Basic realm="PiWeb"' });
			response.end(health);
		});
		const prior = process.env.PI_WEB_PASSWORD;
		try {
			process.env.PI_WEB_PASSWORD = "secret-that-must-not-leave-the-launcher";
			expect(await isPiWebRunning(server.url)).toBe(false);
			expect(seen).toHaveLength(1);
			expect(seen[0].authorization).toBeUndefined();
			expect(seen[0].cookie).toBeUndefined();
		} finally {
			if (prior === undefined) delete process.env.PI_WEB_PASSWORD;
			else process.env.PI_WEB_PASSWORD = prior;
		}
	});

	it("accepts only the minimal service signature and never upgrades it to authenticated probing", async () => {
		const seen: IncomingHttpHeaders[] = [];
		const server = await fakeHttp((headers, response) => { seen.push(headers); response.end(health); });
		expect(await isPiWebRunning(server.url)).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0].authorization).toBeUndefined();
		const old = await fakeHttp((_headers, response) => response.end(JSON.stringify({ success: true, data: { ok: true, piWeb: "anything" } })));
		expect(await isPiWebRunning(old.url)).toBe(false);
	});

	it("does not follow redirects and rejects oversized, malformed or slow responses", async () => {
		let targetHits = 0;
		const target = await fakeHttp((_headers, response) => { targetHits += 1; response.end(health); });
		const redirect = await fakeHttp((_headers, response) => { response.writeHead(302, { location: target.url }); response.end(); });
		expect(await isPiWebRunning(redirect.url)).toBe(false);
		expect(targetHits).toBe(0);
		const large = await fakeHttp((_headers, response) => response.end(`${" ".repeat(4096)}${health}`));
		expect(await isPiWebRunning(large.url)).toBe(false);
		const invalid = await fakeHttp((_headers, response) => response.end("not-json"));
		expect(await isPiWebRunning(invalid.url)).toBe(false);
		const slow = await fakeHttp(() => {});
		expect(await isPiWebRunning(slow.url, { timeoutMs: 30 })).toBe(false);
	});
});

describe("loopback-only development", () => {
	it.each(["0.0.0.0", "::", "192.168.1.5", "example.test", "::ffff:127.0.0.1"])("rejects dev on %s even with a password", async (hostname) => {
		const root = await installation();
		const options = parseLauncherArgs(["--dev", "--hostname", hostname], {});
		expect(() => createLaunchPlan(root, options, { PI_WEB_PASSWORD: "configured" })).toThrow(/开发模式/);
		expect(() => createLaunchPlan(root, options, {})).toThrow(/开发模式/);
	});

	it("enables token auth for a public bind instead of refusing to start", async () => {
		const root = await installation();
		const options = parseLauncherArgs(["-H", "0.0.0.0"], {});
		// 仍然拒绝在没有生产构建时对外回退到 dev
		expect(() => createLaunchPlan(root, options, {})).toThrow(/build:release/);
		await productionBuild(root);
		const plan = createLaunchPlan(root, options, {});
		expect(plan.command).toBe("start");
		expect(plan.env.PI_WEB_AUTH).toBe("1");
		expect(plan.env.PI_WEB_LAUNCH_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(plan.env.PIWEB_BUILD_DIR).toBe(".next");
		// 设了密码就不必再开令牌认证
		const withPassword = createLaunchPlan(root, options, { PI_WEB_PASSWORD: "password" });
		expect(withPassword.env.PI_WEB_AUTH).toBeUndefined();
	});

	it("derives the Host allowlist and the login link from --public-url", async () => {
		const root = await installation();
		await productionBuild(root);
		const options = parseLauncherArgs(["--public-url", "https://pi.example.com/ui/"], {});
		// 配了对外地址就等于暴露，即使绑的是回环也要开认证
		const plan = createLaunchPlan(root, options, { PI_WEB_TRUSTED_HOSTS: "other.example.com" });
		expect(plan.env.PI_WEB_AUTH).toBe("1");
		expect(plan.env.PI_WEB_TRUSTED_HOSTS).toBe("other.example.com,pi.example.com");
		expect(tokenLoginUrl(options.publicUrl, "tok")).toBe("https://pi.example.com/ui/?token=tok");
	});

	it("rejects malformed public URLs", () => {
		for (const value of ["ftp://x.test", "https://user:pw@x.test", "not a url"]) {
			expect(() => parseLauncherArgs(["--public-url", value], {}), value).toThrow();
		}
		expect(parseLauncherArgs([], {}).publicUrl).toBeNull();
		expect(parseLauncherArgs(["--public-url", "https://a.test/"], {}).publicUrl).toBe("https://a.test");
	});

	it("allows local fallback only without a failed release and creates isolated dev asset IDs", async () => {
		const root = await installation();
		const options = parseLauncherArgs([], {});
		const plan = createLaunchPlan(root, options, {});
		expect(plan.command).toBe("dev");
		expect(plan.env.PIWEB_DEV_ASSET_ID).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
		expect(plan.env.PIWEB_BUILD_DIR).toBeUndefined();
		for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "0:0:0:0:0:0:0:1"]) expect(isLoopback(host)).toBe(true);
		expect(isLoopback("127.500.1.2")).toBe(false);
		expect(localUrl("::", 30141)).toBe("http://[::1]:30141");
		expect(localUrl("0.0.0.0", 30141)).toBe("http://127.0.0.1:30141");
	});

	it("dev entry rejects environment and CLI overrides before any network or process action", async () => {
		const root = await installation();
		const start = vi.fn();
		const probe = vi.fn();
		const dependencies = { spawn: start, probePort: probe };
		await expect(runDev({ root, args: [], env: { PI_WEB_HOSTNAME: "0.0.0.0", PI_WEB_PASSWORD: "secret" }, dependencies })).rejects.toThrow(/开发模式/);
		await expect(runDev({ root, args: ["--hostname=0.0.0.0"], env: { PI_WEB_PASSWORD: "secret" }, dependencies })).rejects.toThrow(/开发模式/);
		expect(start).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(() => parseLauncherArgs(["--hostname", "localhost@evil.test"], {})).toThrow();
		expect(() => parseLauncherArgs(["--hostname", "localhost&whoami"], {})).toThrow();
		expect(() => parseLauncherArgs(["--hostname"], {})).toThrow();
		expect(() => parseLauncherArgs(["--port", "0"], {})).toThrow();
		expect(() => parseLauncherArgs(["--unknown"], {})).toThrow();
	});
});

describe("first-paint warm-up", () => {
	/** 记录 (路径, 认证头) 后交给真实 fetch：既能断言顺序，也能断言凭据只发给确认过的服务。 */
	function recordingFetch(log: Array<{ path: string; authorization?: string }>): typeof fetch {
		return async (input, init) => {
			const headers = new Headers(init?.headers);
			log.push({ path: new URL(String(input)).pathname, authorization: headers.get("authorization") ?? undefined });
			return fetch(input, init);
		};
	}

	it("confirms the service without credentials, then warms the pipeline and the first-paint routes", async () => {
		const server = await fakeHttp((_headers, response) => response.end(health));
		const log: Array<{ path: string; authorization?: string }> = [];
		expect(await warmFirstPaint(server.url, { fetchImpl: recordingFetch(log), password: "secret" })).toBe(true);
		expect(log[0]).toEqual({ path: "/api/health", authorization: undefined });
		expect(log[1].path).toBe("/api/version");
		for (const route of FIRST_PAINT_ROUTES) expect(log.map((entry) => entry.path)).toContain(route);
		// 密码模式下非公开路由要带 Basic，否则预热全是 401，等于没预热
		const basic = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
		expect(log.slice(1).every((entry) => entry.authorization === basic)).toBe(true);
	});

	it("never sends credentials to a port occupant that does not prove it is PiWeb", async () => {
		const seen: IncomingHttpHeaders[] = [];
		const server = await fakeHttp((headers, response) => {
			seen.push(headers);
			response.end(JSON.stringify({ success: true, data: { ok: true, service: "other" } }));
		});
		expect(await warmFirstPaint(server.url, { password: "secret", waitMs: 60, pollMs: 10 })).toBe(false);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((headers) => headers.authorization === undefined)).toBe(true);
	});

	it("gives up silently when nothing ever answers", async () => {
		expect(await warmFirstPaint("http://127.0.0.1:1", { password: "secret", waitMs: 80, pollMs: 20 })).toBe(false);
	});

	it("exchanges the launch token for a cookie instead of sending Basic", async () => {
		const log: Array<{ path: string; cookie?: string; authorization?: string }> = [];
		const server = await fakeHttp((headers, response) => {
			if (headers.cookie === "piweb_session_x=signed") {
				response.end(health);
				return;
			}
			response.writeHead(303, { "set-cookie": "piweb_session_x=signed; Path=/; HttpOnly", location: "/" });
			response.end();
		});
		const fetchImpl: typeof fetch = async (input, init) => {
			const headers = new Headers(init?.headers);
			log.push({
				path: new URL(String(input)).pathname,
				cookie: headers.get("cookie") ?? undefined,
				authorization: headers.get("authorization") ?? undefined,
			});
			return fetch(input, init);
		};
		expect(await warmFirstPaint(server.url, { fetchImpl, token: "launch-token", check: async () => true })).toBe(true);
		// 第一步是令牌换 Cookie，此时还没有凭据可带
		expect(log[0]).toMatchObject({ path: "/", cookie: undefined, authorization: undefined });
		expect(log.map((entry) => entry.path)).toContain("/api/version");
		// 之后每条路由都带换来的 Cookie，且绝不带 Basic
		expect(log.slice(1).every((entry) => entry.cookie === "piweb_session_x=signed" && entry.authorization === undefined)).toBe(true);
	});
});

describe("validated build output selection", () => {
	it("selects only a ready manifest build and rejects incomplete, failed, replaced and overridden output", async () => {
		const root = await installation();
		await productionBuild(root, ".next", "old");
		const buildDir = ".next-releases/test-release";
		await productionBuild(root, buildDir, "new");
		const manifest = path.join(root, ".next-releases", "active.json");
		const ready = { schema: 1, state: "ready", buildDir, buildId: "new" };
		await fs.writeFile(manifest, JSON.stringify(ready));
		expect(selectProductionBuild(root)).toEqual({ buildDir, buildId: "new" });
		expect(() => selectProductionBuild(root, ".next")).toThrow(/conflicts/);
		expect(createLaunchPlan(root, parseLauncherArgs([], {}), {}).env.PIWEB_BUILD_DIR).toBe(buildDir);
		await fs.writeFile(path.join(root, buildDir, "BUILD_ID"), "replaced");
		expect(() => selectProductionBuild(root)).toThrow(/BUILD_ID changed/);
		for (const state of ["building", "failed", "unknown"]) {
			await fs.writeFile(manifest, JSON.stringify({ ...ready, state }));
			expect(() => selectProductionBuild(root)).toThrow(/no stale-build fallback/);
			expect(() => selectProductionBuild(root, ".next")).toThrow(/no stale-build fallback/);
		}
		await fs.writeFile(manifest, "{broken");
		expect(() => selectProductionBuild(root)).toThrow(/invalid release manifest/);
	});

	it("rejects build-ID-only stale output and unpromoted releases", async () => {
		const root = await installation();
		await fs.mkdir(path.join(root, ".next"));
		await fs.writeFile(path.join(root, ".next", "BUILD_ID"), "old");
		expect(() => selectProductionBuild(root)).toThrow();
		expect(() => selectProductionBuild(root, ".next-releases/unfinished")).toThrow(/not been promoted/);
	});

	it("rejects traversal, absolute paths, backslashes, empty values and linked output", async () => {
		const root = await installation();
		expect(resolveBuildOutput(root, undefined)).toBe(".next");
		expect(resolveBuildOutput(root, ".next-releases/abc_123-def")).toBe(".next-releases/abc_123-def");
		for (const bad of ["", "..", "../outside", "/tmp/out", "C:/out", ".next/../src", ".next-releases/../src", ".next-releases/a/b", ".next-releases\\id", ".next-releases/.hidden", ".next-releases/id "]) {
			expect(() => resolveBuildOutput(root, bad), bad).toThrow();
		}
		const outside = await installation();
		await fs.symlink(outside, path.join(root, ".next-releases"), process.platform === "win32" ? "junction" : "dir");
		expect(() => resolveBuildOutput(root, ".next-releases/id")).toThrow(/linked/);
	});
});

describe("launcher lifecycle without real child processes", () => {
	it("skips unknown occupied ports and spawns the validated build on the next one", async () => {
		const root = await installation();
		await productionBuild(root);
		const child = Object.assign(new EventEmitter(), { kill: vi.fn((_signal?: NodeJS.Signals | number) => true) });
		const start = vi.fn(() => { setImmediate(() => child.emit("exit", 0)); return child; });
		const checkHealth = vi.fn(async () => false);
		const checkPort = vi.fn().mockResolvedValueOnce("busy").mockResolvedValueOnce("free");
		const result = await runLauncher({ root, args: ["--no-open"], env: { PI_WEB_PASSWORD: "secret" }, dependencies: { spawn: start, probePort: checkPort, isPiWebRunning: checkHealth, log: vi.fn() } });
		expect(result).toBe(0);
		expect(start).toHaveBeenCalledWith(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", "30142", "-H", "127.0.0.1"], expect.objectContaining({ cwd: root, env: expect.objectContaining({ PIWEB_BUILD_DIR: ".next" }) }));
		expect(checkHealth.mock.calls[0]).toEqual(["http://127.0.0.1:30141"]);
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("reuses only a public signature and treats permission errors as fatal, not another port", async () => {
		const root = await installation();
		const start = vi.fn();
		const dependencies = { spawn: start, probePort: vi.fn<typeof probePort>(async () => "busy"), isPiWebRunning: vi.fn(async () => true), log: vi.fn() };
		expect(await runLauncher({ root, args: ["--no-open"], env: {}, dependencies })).toBe(0);
		expect(start).not.toHaveBeenCalled();
		dependencies.probePort = vi.fn<typeof probePort>(async () => Object.assign(new Error("denied"), { code: "EACCES" }));
		await expect(runLauncher({ root, args: [], env: {}, dependencies })).rejects.toThrow(/EACCES/);
		expect(dependencies.probePort).toHaveBeenCalledTimes(1);
	});

	it("probes local fake HTTP as occupied without disturbing it", async () => {
		const server = await fakeHttp((_headers, response) => response.end(health));
		expect(await probePort(server.port, "127.0.0.1")).toBe("busy");
		expect(await isPiWebRunning(server.url)).toBe(true);
	});

	it("warms the first paint on the chosen port and still reports ready when the warm-up fails", async () => {
		const root = await installation();
		await productionBuild(root);
		const child = Object.assign(new EventEmitter(), { kill: vi.fn((_signal?: NodeJS.Signals | number) => true) });
		const start = vi.fn(() => { setTimeout(() => child.emit("exit", 0), 40); return child; });
		const opened: string[] = [];
		const logs: string[] = [];
		let first = true;
		const warm = vi.fn(async () => { if (first) { first = false; throw new Error("warm-up exploded"); } return true; });
		const result = await runLauncher({
			root,
			args: [],
			env: { PI_WEB_PASSWORD: "secret" },
			dependencies: {
				spawn: start, probePort: vi.fn<typeof probePort>(async () => "free"), isPiWebRunning: vi.fn(async () => true),
				openBrowser: async (url: string) => { opened.push(url); }, warmFirstPaint: warm, log: (message: string) => logs.push(message),
			},
		});
		expect(result).toBe(0);
		expect(warm).toHaveBeenCalledWith("http://127.0.0.1:30141", expect.objectContaining({ password: "secret", token: expect.any(String) }));
		// 开了认证就直接开登录链接：用户不知道密码，开裸地址只会撞上登录页
		expect(opened).toHaveLength(1);
		expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:30141\/\?token=[A-Za-z0-9_-]+$/);
		expect(logs.some((line) => line.includes("登录链接"))).toBe(true);
		expect(logs.some((line) => line.includes("预热首屏"))).toBe(true);
		expect(logs.some((line) => line.includes("就绪"))).toBe(true);
	});

	it("turns authentication on by default because the LAN entry is on by default", async () => {
		const root = await installation();
		// 局域网入口默认开 → 同网段可达 → 认证必须默认开，否则等于白送
		expect(createLaunchPlan(root, parseLauncherArgs([], {}), {}).env.PI_WEB_AUTH).toBe("1");
		// 用户显式关掉就尊重它（此时局域网入口会自行跳过）
		expect(createLaunchPlan(root, parseLauncherArgs([], {}), { PI_WEB_AUTH: "0" }).env.PI_WEB_AUTH).toBe("0");
		// 设了密码就不需要令牌认证标记
		expect(createLaunchPlan(root, parseLauncherArgs([], {}), { PI_WEB_PASSWORD: "p" }).env.PI_WEB_AUTH).toBeUndefined();
	});

	it("opens the plain URL when authentication is explicitly off", async () => {
		const root = await installation();
		await productionBuild(root);
		const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
		const opened: string[] = [];
		const logs: string[] = [];
		await runLauncher({
			root,
			args: [],
			env: { PI_WEB_AUTH: "0", PIWEB_REMOTE_LAN: "0" },
			dependencies: {
				spawn: vi.fn(() => { setTimeout(() => child.emit("exit", 0), 40); return child; }),
				probePort: vi.fn<typeof probePort>(async () => "free"), isPiWebRunning: vi.fn(async () => true),
				openBrowser: async (url: string) => { opened.push(url); }, warmFirstPaint: vi.fn(async () => true), log: (message: string) => logs.push(message),
			},
		});
		expect(opened).toEqual(["http://127.0.0.1:30141"]);
		expect(logs.some((line) => line.includes("登录链接"))).toBe(false);
	});

	it("never warms in development mode or when PIWEB_SKIP_WARMUP=1", async () => {
		const devRoot = await installation();
		const warm = vi.fn(async () => true);
		const spawn = vi.fn(() => { const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }); setImmediate(() => child.emit("exit", 0)); return child; });
		const base = { spawn, probePort: vi.fn<typeof probePort>(async () => "free"), isPiWebRunning: vi.fn(async () => true), warmFirstPaint: warm, log: vi.fn() };
		await runLauncher({ root: devRoot, args: ["--dev", "--no-open"], env: {}, dependencies: { ...base } });
		expect(warm).not.toHaveBeenCalled();
		const prodRoot = await installation();
		await productionBuild(prodRoot);
		await runLauncher({ root: prodRoot, args: ["--no-open"], env: { PI_WEB_PASSWORD: "secret", PIWEB_SKIP_WARMUP: "1" }, dependencies: { ...base } });
		expect(warm).not.toHaveBeenCalled();
	});
});
