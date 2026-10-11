import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMobileProxy, injectAssets, isLoopbackHost } from "../src/lib/remote/mobile-proxy";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function listen(server: http.Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	cleanups.push(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	return (server.address() as { port: number }).port;
}

function call(port: number, path: string, headers: Record<string, string> = {}) {
	return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end();
	});
}

describe("isLoopbackHost", () => {
	it("recognizes loopback with and without a port, and bare IPv6", () => {
		for (const host of ["localhost", "localhost:8443", "127.0.0.1", "127.0.0.1:30141", "127.9.9.9:1", "[::1]:8443", "::1", "[0:0:0:0:0:0:0:1]:8443", "x.localhost"]) {
			expect(isLoopbackHost(host), host).toBe(true);
		}
		for (const host of ["pi.example.com", "192.168.5.44:30141", "pi.example.com:8443", ""]) {
			expect(isLoopbackHost(host), host).toBe(false);
		}
	});
});

describe("injectAssets", () => {
	const page = "<html><head><title>t</title></head><body>hi</body></html>";

	it("inserts before </head>", () => {
		const out = injectAssets(page, { css: "a{}", js: "b()" });
		expect(out.indexOf('id="piweb-mobile-fit"')).toBeGreaterThan(out.indexOf("<title>"));
		expect(out.indexOf('id="piweb-mobile-fit"')).toBeLessThan(out.indexOf("</head>"));
		expect(out.indexOf('id="piweb-mobile-fit-js"')).toBeGreaterThan(out.indexOf("</style>"));
		expect(out).toContain("</body>");
	});

	it("falls back to just after <body ...> and then to prepending", () => {
		expect(injectAssets("<body class=\"x\">hi", { css: "a{}" })).toContain('id="piweb-mobile-fit"');
		const afterBody = injectAssets("<body class=\"x\">hi", { css: "a{}" });
		expect(afterBody.indexOf('id="piweb-mobile-fit"')).toBeGreaterThan(afterBody.indexOf("<body"));
		expect(injectAssets("plain", { css: "a{}" })).toMatch(/^<style/);
	});

	it("is idempotent and returns the input untouched when there is nothing to inject", () => {
		const once = injectAssets(page, { css: "a{}" });
		expect(injectAssets(once, { css: "a{}" })).toBe(once);
		expect(injectAssets(page, {})).toBe(page);
		expect(injectAssets(page, { css: null, js: null })).toBe(page);
	});

	it("injects only the script when only the script is given", () => {
		const out = injectAssets(page, { js: "b()" });
		expect(out).not.toContain("<style");
		expect(out).toContain("<script");
	});
});

describe("mobile injection proxy", () => {
	/** 上游：记录收到的 Host 头，按路径给出不同响应 */
	async function upstream() {
		const seen: Array<string | undefined> = [];
		const server = http.createServer((req, res) => {
			seen.push(req.headers.host);
			if (req.url === "/sse") {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				res.write("data: one\n\n");
				setTimeout(() => res.end("data: two\n\n"), 20);
				return;
			}
			if (req.url === "/json") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"success":true}');
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"v1"', "cache-control": "public" });
			res.end("<html><head></head><body>hi</body></html>");
		});
		return { port: await listen(server), seen };
	}

	async function proxyFor(targetPort: number) {
		return listen(createMobileProxy({ targetPort, css: "CSS{}", js: "JS()" }));
	}

	it("injects into HTML for a non-loopback host and rewrites the framing headers", async () => {
		const up = await upstream();
		const port = await proxyFor(up.port);
		const res = await call(port, "/", { host: "pi.example.com", accept: "text/html" });
		expect(res.status).toBe(200);
		expect(res.body).toContain('id="piweb-mobile-fit"');
		expect(res.body).toContain("CSS{}");
		expect(res.body).toContain("JS()");
		expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(res.body)));
		expect(res.headers.etag).toBeUndefined();
		expect(res.headers["transfer-encoding"]).toBeUndefined();
		expect(res.headers["cache-control"]).toBe("no-store");
	});

	it("leaves loopback requests byte-identical", async () => {
		const up = await upstream();
		const port = await proxyFor(up.port);
		const res = await call(port, "/", { host: "127.0.0.1:30141", accept: "text/html" });
		expect(res.body).toBe("<html><head></head><body>hi</body></html>");
		expect(res.headers.etag).toBe('"v1"');
	});

	it("forwards the original Host header upstream", async () => {
		const up = await upstream();
		const port = await proxyFor(up.port);
		await call(port, "/", { host: "pi.example.com", accept: "text/html" });
		expect(up.seen).toContain("pi.example.com");
	});

	it("passes JSON through untouched", async () => {
		const up = await upstream();
		const port = await proxyFor(up.port);
		const res = await call(port, "/json", { host: "pi.example.com" });
		expect(res.body).toBe('{"success":true}');
		expect(res.headers["content-type"]).toContain("application/json");
	});

	it("streams SSE instead of buffering it", async () => {
		const up = await upstream();
		const port = await proxyFor(up.port);
		const res = await call(port, "/sse", { host: "pi.example.com" });
		expect(res.body).toBe("data: one\n\ndata: two\n\n");
		// 没有被换成定长：SSE 必须保持流式
		expect(res.headers["content-length"]).toBeUndefined();
	});

	it("reports 502 when PiWeb is not reachable", async () => {
		const port = await listen(createMobileProxy({ targetPort: 1, css: "CSS{}" }));
		const res = await call(port, "/", { host: "pi.example.com" });
		expect(res.status).toBe(502);
		expect(res.body).toContain("连不上 PiWeb");
	});
});
