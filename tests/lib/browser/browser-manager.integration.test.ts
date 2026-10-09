import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserAvailable, closeBrowserTab, getBrowserTab, shutdownBrowser } from "../../../src/lib/browser/manager";

const PAGE = `<!doctype html><meta charset="utf-8"><title>PiWeb 测试页</title>
<h1 id="t">hello</h1>
<button id="b" onclick="document.getElementById('t').textContent='clicked'">go</button>
<form onsubmit="event.preventDefault(); document.getElementById('t').textContent='submitted:' + document.getElementById('i').value"><input id="i"></form>
<script src="/missing.js"></script>
<script>console.error("boom from page")</script>
<div style="height:3000px"></div>`;

async function listen(server: http.Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return (server.address() as AddressInfo).port;
}

// 本机（或 CI runner）没有 Chrome / Edge / Chromium 时整组跳过
describe.skipIf(!browserAvailable())("browser manager (real headless browser)", () => {
	let server: http.Server;
	let base = "";

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			if (req.url === "/missing.js") {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(PAGE);
		});
		base = `http://127.0.0.1:${await listen(server)}`;
	});

	afterAll(async () => {
		await shutdownBrowser();
		server.close();
	});

	it("opens a page, screenshots it, records console and network errors, clicks and types", async () => {
		const tab = await getBrowserTab("test-session");
		const info = await tab.navigate(`${base}/`);
		expect(info.title).toBe("PiWeb 测试页");

		const shot = await tab.screenshot();
		expect(Buffer.from(shot.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
		expect([shot.width, shot.height]).toEqual([1280, 800]);
		expect(tab.console.some((e) => e.source === "console" && e.text.includes("boom from page"))).toBe(true);
		expect(tab.console.some((e) => e.source === "network" && e.text === "HTTP 404" && e.url?.endsWith("/missing.js"))).toBe(true);

		await tab.click({ selector: "#b" });
		expect(await tab.evaluate("document.getElementById('t').textContent")).toBe("clicked");
		await tab.type("#i", "你好 piweb", true);
		expect(await tab.evaluate("document.getElementById('t').textContent")).toBe("submitted:你好 piweb");

		const full = await tab.screenshot({ fullPage: true });
		expect(full.height).toBeGreaterThan(3000);
		const element = await tab.screenshot({ selector: "#b" });
		expect(element.width).toBeLessThan(200);

		await tab.setDevice("mobile");
		expect((await tab.screenshot()).width).toBe(390);

		// 同一会话复用同一个标签页
		expect(await getBrowserTab("test-session")).toBe(tab);
		await closeBrowserTab("test-session");
		expect(tab.closed).toBe(true);
	}, 90_000);

	it("explains a refused connection instead of hanging", async () => {
		const closed = http.createServer();
		const port = await listen(closed);
		await new Promise<void>((resolve) => closed.close(() => resolve()));
		const tab = await getBrowserTab("refused");
		await expect(tab.navigate(`http://127.0.0.1:${port}/`)).rejects.toThrow(/ERR_CONNECTION_REFUSED[\s\S]*dev server/);
		await closeBrowserTab("refused");
	}, 60_000);
});
