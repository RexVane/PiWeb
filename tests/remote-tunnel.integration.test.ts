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
import { afterAll, describe, expect, it } from "vitest";
import { managedEnginePath, resetRemoteSupervisor, startLan, startPublic, stopAll } from "../src/lib/remote/supervisor";

const RUN = process.env.PIWEB_TEST_TUNNEL === "1";
const LAN_PORT = 30155;
const UPSTREAM_PORT = 30156;
const PAGE = "<!doctype html><html><head><title>upstream</title></head><body>UPSTREAM-OK</body></html>";

let upstream: http.Server | null = null;

afterAll(async () => {
	if (RUN) await stopAll();
	if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
});

/** 用 node:http(s) 而不是 fetch —— 只有它能自定义 Host 头，也避开 fetch 的代理行为差异 */
function get(url: string, host?: string, timeoutMs = 25_000) {
	const target = new URL(url);
	const mod = target.protocol === "https:" ? https : http;
	return new Promise<{ status: number; body: string; error?: string }>((resolve) => {
		const request = mod.request({
			host: target.hostname,
			port: target.port || (target.protocol === "https:" ? 443 : 80),
			path: `${target.pathname}${target.search}`,
			method: "GET",
			headers: { accept: "text/html", ...(host ? { host } : {}) },
			timeout: timeoutMs,
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
		});
		request.on("timeout", () => { request.destroy(); resolve({ status: 0, body: "", error: "timeout" }); });
		request.on("error", (error) => resolve({ status: 0, body: "", error: error.message }));
		request.end();
	});
}

describe("real cloudflared tunnel", () => {
	it.runIf(RUN)("serves the LAN entry through a public https URL with the mobile CSS injected", async () => {
		resetRemoteSupervisor();
		process.env.PIWEB_CLOUDFLARED = managedEnginePath();

		upstream = http.createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(PAGE);
		});
		await new Promise<void>((resolve) => upstream!.listen(UPSTREAM_PORT, "127.0.0.1", resolve));

		const lan = await startLan(LAN_PORT, "127.0.0.1", UPSTREAM_PORT);
		expect(lan.running, `局域网入口没起来：${lan.error}`).toBe(true);

		// 第一步：本地就验证「代理 + 注入」是通的（不带 Host 或回环 Host 都不该注入）
		const loopback = await get(`http://127.0.0.1:${LAN_PORT}/`);
		expect(loopback.body).toContain("UPSTREAM-OK");
		expect(loopback.body, "回环 Host 不该被注入").not.toContain("piweb-mobile-fit");

		const foreign = await get(`http://127.0.0.1:${LAN_PORT}/`, "pi.example.com");
		expect(foreign.body).toContain("UPSTREAM-OK");
		expect(foreign.body, "非回环 Host 必须注入").toContain('id="piweb-mobile-fit"');

		// 第二步：起真隧道，域名必须已并进 Host 白名单
		const pub = await startPublic();
		expect(pub.error, `隧道失败：${pub.error}`).toBeNull();
		expect(pub.url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
		expect((process.env.PI_WEB_TRUSTED_HOSTS ?? "").split(",")).toContain(new URL(pub.url!).hostname);
		console.log("tunnel url:", pub.url);

		// 第三步：从公网地址真拉一次
		let html = "";
		for (let attempt = 0; attempt < 14 && !html; attempt += 1) {
			const result = await get(pub.url!, undefined, 30_000);
			if (result.status === 200) html = result.body;
			else console.log(`attempt ${attempt + 1}: status=${result.status} error=${result.error ?? "-"} body=${result.body.slice(0, 160)}`);
			if (!html) await new Promise((resolve) => setTimeout(resolve, 4_000));
		}
		expect(html, "公网地址没拉到页面").not.toBe("");
		expect(html).toContain("UPSTREAM-OK");
		expect(html, "公网路径也必须注入").toContain('id="piweb-mobile-fit"');
	}, 300_000);
});