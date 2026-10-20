/** 真实远程 API + 子进程；仅把 Cloudflare 网络边界接到本地故障响应服务器。 */
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/remote/route";
import { resetRemoteSupervisor, startLan, startPublic, stopAll, stopPublic } from "@/lib/remote/supervisor";

describe.skipIf(process.platform === "win32")("tunnel status through API, process and HTTP", () => {
	let root: string;
	let edge: http.Server;
	let reply: { status: number; body: string; headers?: Record<string, string> };
	let requests: number;
	let hold: ((response: http.ServerResponse) => void) | undefined;
	let now: number;
	let advanceOnRequest: number;
	const health = () => ({ status: 200, body: JSON.stringify({ success: true, data: { ok: true, service: "piweb" } }) });
	const read = async () => (await (await GET()).json()).data.public;
	const nextCheck = () => { now += 6_000; };

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-tunnel-status-"));
		resetRemoteSupervisor();
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		vi.stubEnv("PI_WEB_TRUSTED_HOSTS", "");
		const executable = path.join(root, "cloudflared-fixture");
		await fs.writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
const root = process.env.PI_CODING_AGENT_DIR;
fs.appendFileSync(root + "/starts", "started\\n");
fs.writeFileSync(root + "/pid", String(process.pid));
if (!fs.existsSync(root + "/no-url")) console.log("https://status-fixture.trycloudflare.com");
setInterval(() => { if (fs.existsSync(root + "/exit")) process.exit(7); }, 20);
`, { mode: 0o755 });
		vi.stubEnv("PIWEB_CLOUDFLARED", executable);
		reply = health();
		requests = 0;
		hold = undefined;
		advanceOnRequest = 0;
		edge = http.createServer((request, response) => {
			requests += 1;
			now += advanceOnRequest;
			expect(request.url).toBe("/api/health");
			expect(request.method).toBe("GET");
			if (hold) { hold(response); return; }
			response.writeHead(reply.status, reply.headers);
			response.end(reply.body);
		});
		await new Promise<void>((resolve) => edge.listen(0, "127.0.0.1", resolve));
		const port = (edge.address() as net.AddressInfo).port;
		vi.spyOn(https, "request").mockImplementation(((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
			http.request({ ...options, host: "127.0.0.1", port }, callback)) as typeof https.request);
		now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const socket = net.createServer();
		await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
		const lanPort = (socket.address() as net.AddressInfo).port;
		await new Promise<void>((resolve) => socket.close(() => resolve()));
		await startLan(lanPort, "127.0.0.1", port);
	});
	afterEach(async () => {
		await stopAll();
		edge?.closeAllConnections();
		if (edge) await new Promise<void>((resolve) => edge.close(() => resolve()));
		resetRemoteSupervisor();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("detects 1033 after readiness and recovers on the same URL without respawning", async () => {
		const started = await startPublic();
		expect(started).toMatchObject({ ready: true, running: true, error: null });
		reply = { status: 530, body: "<html><h1>Error 1033</h1>Cloudflare Tunnel error</html>" };
		nextCheck();
		expect(await read()).toMatchObject({ ready: false, running: true, url: started.url, error: expect.stringContaining("1033") });
		reply = health();
		nextCheck();
		expect(await read()).toMatchObject({ ready: true, running: true, url: started.url, error: null });
		expect((await fs.readFile(path.join(root, "starts"), "utf8")).trim().split("\n")).toHaveLength(1);
	});

	it("keeps checking after the initial readiness deadline instead of remaining pending forever", async () => {
		reply = { status: 530, body: "Error 1033" };
		advanceOnRequest = 61_000;
		expect(await startPublic()).toMatchObject({ running: true, ready: false, error: expect.stringContaining("1033") });
		advanceOnRequest = 0;
		reply = health();
		nextCheck();
		expect(await read()).toMatchObject({ running: true, ready: true, error: null });
	});

	it("concurrent starts wait for the same completed readiness check", async () => {
		const started = await Promise.all([startPublic(), startPublic()]);
		for (const status of started) expect(status).toMatchObject({ running: true, ready: true, error: null });
		expect(requests).toBe(1);
		expect((await fs.readFile(path.join(root, "starts"), "utf8")).trim().split("\n")).toHaveLength(1);
	});

	it.each([
		{ status: 403, body: "forbidden" },
		{ status: 200, body: "<html>error page</html>" },
		{ status: 200, body: '{"success":true,"data":{"ok":true,"service":"other"}}' },
		{ status: 502, body: "Bad Gateway" },
		{ status: 403, headers: { "cf-mitigated": "challenge" }, body: "challenge" },
	])("does not mark %j as a working tunnel", async (response) => {
		await startPublic();
		reply = response;
		nextCheck();
		expect(await read()).toMatchObject({ ready: false, running: true, error: expect.any(String) });
	});

	it("reports a crash after startup and removes the expired address", async () => {
		await startPublic();
		await fs.writeFile(path.join(root, "exit"), "yes");
		await vi.waitFor(async () => expect(await read()).toMatchObject({ running: false, ready: false, url: null, error: expect.stringContaining("code 7") }));
		expect(process.env.PI_WEB_TRUSTED_HOSTS).toBe("");
	});

	it("coalesces checks and discards an in-flight failure after stopping", async () => {
		await startPublic();
		const previous = requests;
		let pending: http.ServerResponse | undefined;
		hold = (response) => { pending = response; };
		nextCheck();
		const checks = [read(), read()];
		await vi.waitFor(() => expect(pending).toBeTruthy());
		expect(requests).toBe(previous + 1);
		await stopPublic();
		pending?.end("Error 1033");
		for (const status of await Promise.all(checks)) expect(status).toMatchObject({ running: false, ready: false, url: null, error: null });
	});

	it("can stop while waiting for an address and start a fresh tunnel", async () => {
		await fs.writeFile(path.join(root, "no-url"), "yes");
		const starting = startPublic();
		await vi.waitFor(async () => expect(await fs.readFile(path.join(root, "pid"), "utf8")).toMatch(/^\d+$/));
		await stopPublic();
		expect(await starting).toMatchObject({ running: false, ready: false, url: null, error: null });
		await fs.unlink(path.join(root, "no-url"));
		expect(await startPublic()).toMatchObject({ running: true, ready: true, error: null });
	});
});
