/**
 * 真实端到端验证：本地上游 → 局域网注入代理 → 真 cloudflared 隧道 → 从公网地址拉回来。
 *
 * 为什么不用 fetch：fetch 不允许改 Host 头，而注入与否正是由 Host 决定的。
 * 为什么自带上游：这样测的是「代理 + 注入 + 隧道」本身，
 * 不依赖另一个进程里那个 PiWeb（跨进程改 process.env 是无效的，别那么写测试）。
 *
 * 默认跳过（要联网、要几十秒）。手动跑：
 *   $env:PIWEB_TEST_TUNNEL='1'; npx vitest run tests/remote-tunnel.integration.test.ts
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { POST as issuePair } from "../src/app/api/remote/pair/route";
import { GET as redeemPair } from "../src/app/pair/route";
import { resetPairingState } from "../src/lib/remote/pairing";
import { ensureRemoteAccess, managedEnginePath, refreshPublicStatus, remoteStatus, resetRemoteSupervisor, startLan, stopAll } from "../src/lib/remote/supervisor";
import { proxy } from "../src/proxy";

const RUN = process.env.PIWEB_TEST_TUNNEL === "1";
const PAGE = "<!doctype html><html><head><title>upstream</title></head><body>UPSTREAM-OK</body></html>";

let upstream: http.Server | null = null;
let upstreamPort = 0;

async function freePort() {
	const probe = net.createServer();
	await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
	const port = (probe.address() as net.AddressInfo).port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

afterAll(async () => {
	if (RUN) await stopAll();
	if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
	resetPairingState();
	vi.unstubAllEnvs();
});

/** 用 node:http(s) 而不是 fetch —— 只有它能自定义 Host 头，也避开 fetch 的代理行为差异 */
function get(url: string, host?: string, timeoutMs = 25_000, extraHeaders: http.OutgoingHttpHeaders = {}) {
	const target = new URL(url);
	const mod = target.protocol === "https:" ? https : http;
	return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders; error?: string }>((resolve) => {
		const agent = mod === https ? new https.Agent({ proxyEnv: process.env.NODE_USE_ENV_PROXY === "1" ? { ...process.env } : undefined }) : new http.Agent({ proxyEnv: { NODE_ENV: "test" } });
		const finish = (result: { status: number; body: string; headers?: http.IncomingHttpHeaders; error?: string }) => { agent.destroy(); resolve({ headers: {}, ...result }); };
		const request = mod.request({
			host: target.hostname,
			port: target.port || (target.protocol === "https:" ? 443 : 80),
			path: `${target.pathname}${target.search}`,
			method: "GET",
			agent,
			headers: { accept: "text/html", ...extraHeaders, ...(host ? { host } : {}) },
			timeout: timeoutMs,
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => finish({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
			response.on("error", (error) => finish({ status: 0, body: "", error: error.message }));
		});
		request.on("timeout", () => { request.destroy(); finish({ status: 0, body: "", error: "timeout" }); });
		request.on("error", (error) => finish({ status: 0, body: "", error: error.message }));
		request.end();
	});
}

describe("real cloudflared tunnel", () => {
	it.runIf(RUN)("serves the LAN entry through a public https URL with the mobile CSS injected", async () => {
		const engine = process.env.PIWEB_CLOUDFLARED || managedEnginePath();
		resetRemoteSupervisor();
		resetPairingState();
		vi.stubEnv("PIWEB_CLOUDFLARED", engine);
		vi.stubEnv("PI_CODING_AGENT_DIR", process.env.PIWEB_TEST_TUNNEL_DIR || path.join(os.tmpdir(), `piweb-remote-network-${randomUUID()}`));
		vi.stubEnv("PI_WEB_SECRET", randomBytes(32).toString("base64url"));
		vi.stubEnv("PI_WEB_AUTH", "1");
		vi.stubEnv("PIWEB_REMOTE_LAN", "1");
		vi.stubEnv("PI_WEB_TRUSTED_HOSTS", "");
		// This intentional foreign Host exercises mobile injection without bypassing
		// the production request guard's host allowlist.
		vi.stubEnv("PI_WEB_ALLOWED_HOSTS", "pi.example.com");

		upstream = http.createServer((request, response) => {
			if (request.url === "/api/health") {
				response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
				response.end(JSON.stringify({ success: true, data: { ok: true, service: "piweb" } }));
				return;
			}
			// 只提供隔离的配对处理和验证页，绝不启动或转发真实工作区。
			const headers = new Headers();
			for (const [name, value] of Object.entries(request.headers)) {
				if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
			}
			const incoming = new NextRequest(`http://127.0.0.1:${upstreamPort}${request.url}`, { headers });
			if (incoming.nextUrl.pathname === "/pair") {
				void redeemPair(incoming).then((result) => {
					response.writeHead(result.status, Object.fromEntries(result.headers));
					response.end();
				}).catch(() => { response.writeHead(500); response.end(); });
				return;
			}
			if (incoming.nextUrl.pathname === "/authenticated") {
				const accepted = proxy(incoming).headers.get("x-middleware-next") === "1";
				response.writeHead(accepted ? 200 : 401, { "content-type": "text/plain" });
				response.end(accepted ? "SIGNED-IN" : "SIGN-IN-REQUIRED");
				return;
			}
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(PAGE);
		});
		await new Promise<void>((resolve, reject) => { upstream!.once("error", reject); upstream!.listen(0, "127.0.0.1", resolve); });
		upstreamPort = (upstream.address() as net.AddressInfo).port;
		vi.stubEnv("PIWEB_PORT", String(upstreamPort));
		const lanPort = await freePort();
		vi.stubEnv("PIWEB_REMOTE_LAN_PORT", String(lanPort));

		const lan = await startLan(lanPort, "127.0.0.1", upstreamPort);
		expect(lan.running, `局域网入口没起来：${lan.error}`).toBe(true);

		// 第一步：本地就验证「代理 + 注入」是通的（不带 Host 或回环 Host 都不该注入）
		const loopback = await get(`http://127.0.0.1:${lanPort}/`);
		expect(loopback.body).toContain("UPSTREAM-OK");
		expect(loopback.body, "回环 Host 不该被注入").not.toContain("piweb-mobile-fit");

		const foreign = await get(`http://127.0.0.1:${lanPort}/`, "pi.example.com");
		expect(foreign.body).toContain("UPSTREAM-OK");
		expect(foreign.body, "非回环 Host 必须注入").toContain('id="piweb-mobile-fit"');

		// 第二步：走自动连接流程；网络失败时允许后台重建，但必须真实探测成功。
		await ensureRemoteAccess();
		const deadline = Date.now() + 240_000;
		while (!remoteStatus().public.ready && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			await refreshPublicStatus();
		}
		const pub = remoteStatus().public;
		expect(pub.error, `隧道失败：${pub.error}`).toBeNull();
		expect(pub.ready).toBe(true);
		expect(pub.url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
		expect((process.env.PI_WEB_TRUSTED_HOSTS ?? "").split(",")).toContain(new URL(pub.url!).hostname);

		// 第三步：从公网地址真拉一次
		let html = "";
		const pageDeadline = Date.now() + 60_000;
		for (let attempt = 0; Date.now() < pageDeadline && !html; attempt += 1) {
			const result = await get(pub.url!, undefined, 15_000);
			if (result.status === 200) html = result.body;
			else console.log(`attempt ${attempt + 1}: status=${result.status} error=${result.error ?? "-"} body=${result.body.slice(0, 160)}`);
			if (!html) await new Promise((resolve) => setTimeout(resolve, 4_000));
		}
		expect(html, "公网地址没拉到页面").not.toBe("");
		expect(html).toContain("UPSTREAM-OK");
		expect(html, "公网路径也必须注入").toContain('id="piweb-mobile-fit"');

		// 第四步：实际发码 → 经公网兑换 → 同地址登录，旧码不能再换出 Cookie。
		const issued = await issuePair(new Request("http://localhost/api/remote/pair", { method: "POST", body: "{}" }));
		expect(issued.status).toBe(200);
		const pair = (await issued.json()).data;
		expect(new URL(pair.url).origin).toBe(pub.url);
		const signedIn = await get(pair.url);
		expect(signedIn.status).toBe(303);
		expect(new URL(signedIn.headers.location!, pair.url).href).toBe(`${pub.url}/`);
		const setCookie = signedIn.headers["set-cookie"]?.[0];
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
		const authenticated = await get(`${pub.url}/authenticated`, undefined, 25_000, { cookie: setCookie!.split(";")[0] });
		expect(authenticated).toMatchObject({ status: 200, body: "SIGNED-IN" });
		expect((await get(pair.url)).headers["set-cookie"]).toBeUndefined();
	}, 480_000);
});
