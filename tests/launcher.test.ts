import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http, { type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLaunchPlan, isLoopback, isPiWebRunning, localUrl, parseLauncherArgs, probePort, runLauncher } from "../scripts/launcher.mjs";
import { runDev } from "../scripts/dev.mjs";
import { resolveBuildOutput, selectProductionBuild } from "../scripts/build-output.mjs";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function installation() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-launcher-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "pi-web", version: "1.0.0" }));
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

	it("rejects public production without a password and does not silently fall back without a build", async () => {
		const root = await installation();
		const options = parseLauncherArgs(["-H", "0.0.0.0"], {});
		expect(() => createLaunchPlan(root, options, {})).toThrow(/无密码/);
		expect(() => createLaunchPlan(root, options, { PI_WEB_PASSWORD: "password" })).toThrow(/build:release/);
		await productionBuild(root);
		const plan = createLaunchPlan(root, options, { PI_WEB_PASSWORD: "password" });
		expect(plan.command).toBe("start");
		expect(plan.env.PIWEB_BUILD_DIR).toBe(".next");
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
});
