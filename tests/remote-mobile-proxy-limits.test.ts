import http from "node:http";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMobileProxy,
	DEFAULT_MAX_DECODED_BYTES,
	DEFAULT_MAX_HTML_BYTES,
	DEFAULT_RESPONSE_TIMEOUT_MS,
	decodeBody,
	injectAssets,
	isSupportedEncoding,
	mobileProxyMaxDecodedBytes,
	mobileProxyMaxHtmlBytes,
	mobileProxyTimeoutMs,
} from "../src/lib/remote/mobile-proxy";

/**
 * I4：手机排版注入代理的三道上限与编码兜底。
 * 正常页面路径必须与改动前一致（小 HTML 照常注入），只有触达上限/超时/不支持的编码时才降级。
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});

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
	return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

/** 上游：按 handler 返回响应；记录的请求头用于断言 accept-encoding 等 */
async function upstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
	const requests: http.IncomingHttpHeaders[] = [];
	const server = http.createServer((req, res) => {
		requests.push(req.headers);
		handler(req, res);
	});
	return { port: await listen(server), requests };
}

function proxyFor(targetPort: number, options: Partial<Parameters<typeof createMobileProxy>[0]> = {}) {
	return listen(createMobileProxy({ targetPort, css: "CSS{}", js: "JS()", ...options }));
}

const page = (padding = 0) => `<html><head></head><body>hi${"x".repeat(padding)}</body></html>`;

describe("mobile proxy limits configuration", () => {
	it("uses generous defaults that keep the current behavior", () => {
		expect(mobileProxyMaxHtmlBytes({})).toBe(16 * 1024 * 1024);
		expect(mobileProxyMaxDecodedBytes({})).toBe(64 * 1024 * 1024);
		expect(mobileProxyTimeoutMs({})).toBe(30_000);
		expect(mobileProxyMaxHtmlBytes({})).toBe(DEFAULT_MAX_HTML_BYTES);
		expect(mobileProxyMaxDecodedBytes({})).toBe(DEFAULT_MAX_DECODED_BYTES);
		expect(mobileProxyTimeoutMs({})).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
	});

	it("reads overrides from env and falls back for invalid values", () => {
		expect(mobileProxyMaxHtmlBytes({ PIWEB_MOBILE_PROXY_MAX_HTML_BYTES: "1024" })).toBe(1024);
		expect(mobileProxyMaxDecodedBytes({ PIWEB_MOBILE_PROXY_MAX_DECODED_BYTES: "2048" })).toBe(2048);
		expect(mobileProxyTimeoutMs({ PIWEB_MOBILE_PROXY_TIMEOUT_MS: "250" })).toBe(250);
		for (const bad of ["0", "-1", "abc", "1.5", "NaN"]) {
			expect(mobileProxyMaxHtmlBytes({ PIWEB_MOBILE_PROXY_MAX_HTML_BYTES: bad })).toBe(DEFAULT_MAX_HTML_BYTES);
			expect(mobileProxyMaxDecodedBytes({ PIWEB_MOBILE_PROXY_MAX_DECODED_BYTES: bad })).toBe(DEFAULT_MAX_DECODED_BYTES);
			expect(mobileProxyTimeoutMs({ PIWEB_MOBILE_PROXY_TIMEOUT_MS: bad })).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
		}
	});

	it("recognizes only the encodings it can safely decode", () => {
		for (const encoding of [undefined, "", "identity", "gzip", "GZIP", "x-gzip", "deflate", "br"]) expect(isSupportedEncoding(encoding), String(encoding)).toBe(true);
		for (const encoding of ["zstd", "compress", "unknown"]) expect(isSupportedEncoding(encoding), encoding).toBe(false);
	});
});

describe("decodeBody output cap", () => {
	it("refuses to inflate a gzip bomb past the configured output limit", () => {
		const expanded = Buffer.alloc(1024 * 1024, 7);
		const gzipped = zlib.gzipSync(expanded);
		expect(decodeBody(gzipped, "gzip").byteLength).toBe(expanded.byteLength);
		let code: string | undefined;
		try {
			decodeBody(gzipped, "gzip", 4096);
		} catch (error) {
			code = (error as NodeJS.ErrnoException).code;
		}
		expect(code).toBe("ERR_BUFFER_TOO_LARGE");
	});
});

describe("mobile injection proxy limits", () => {
	it("still injects into small HTML (normal path unchanged)", async () => {
		const up = await upstream((_req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(page());
		});
		const port = await proxyFor(up.port);
		const res = await call(port, "/", { host: "pi.example.com", accept: "text/html" });
		expect(res.status).toBe(200);
		expect(res.body.toString("utf8")).toContain('id="piweb-mobile-fit"');
		expect(res.body.toString("utf8")).toContain("CSS{}");
	});

	it("streams oversized HTML straight through without injecting", async () => {
		const html = page(4096);
		const up = await upstream((_req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			// 分块发送：第一块就超过 64 字节上限，代理应在中途切换到透传并保留剩余字节
			res.write(html.slice(0, 100));
			setTimeout(() => { res.write(html.slice(100, 2000)); res.end(html.slice(2000)); }, 20);
		});
		const port = await proxyFor(up.port, { maxHtmlBytes: 64 });
		const res = await call(port, "/", { host: "pi.example.com", accept: "text/html" });
		expect(res.status).toBe(200);
		expect(res.body.toString("utf8")).toBe(html);
		expect(res.body.toString("utf8")).not.toContain("piweb-mobile-fit");
	});

	it("answers 502 with a readable error when decompressed HTML exceeds the decoded limit", async () => {
		const bomb = zlib.gzipSync(Buffer.from(page(256 * 1024)));
		const up = await upstream((_req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
			res.end(bomb);
		});
		const port = await proxyFor(up.port, { maxDecodedBytes: 4096 });
		const res = await call(port, "/", { host: "pi.example.com", accept: "text/html" });
		expect(res.status).toBe(502);
		expect(res.headers["content-encoding"]).toBeUndefined();
		expect(res.body.toString("utf8")).toContain("解压后超过上限");
		expect(res.body.toString("utf8")).toContain("4096");
	});

	it("passes unsupported encodings through with the original content-encoding intact", async () => {
		const raw = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03, 0xff]);
		const up = await upstream((_req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "zstd" });
			res.end(raw);
		});
		const port = await proxyFor(up.port);
		const res = await call(port, "/", { host: "pi.example.com", accept: "text/html" });
		expect(res.status).toBe(200);
		// 以前这里会删掉 content-encoding 再把压缩字节当明文返回，页面乱码；现在原样保留
		expect(res.headers["content-encoding"]).toBe("zstd");
		expect(res.body.equals(raw)).toBe(true);
	});

	it("streams through instead of buffering forever when the upstream response is slow", async () => {
		const html = page(2048);
		const up = await upstream((_req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.write(html.slice(0, 64));
			setTimeout(() => res.end(html.slice(64)), 150);
		});
		const port = await proxyFor(up.port, { responseTimeoutMs: 30 });
		const res = await call(port, "/", { host: "pi.example.com", accept: "text/html" });
		expect(res.status).toBe(200);
		expect(res.body.toString("utf8")).toBe(html);
		expect(res.body.toString("utf8")).not.toContain("piweb-mobile-fit");
	});

	it("keeps injecting when the HTML is under the limit and includes a trailing doctype-less fragment", () => {
		// injectAssets 的兜底仍在（无 head/body 时前置），配合上限不改变结果
		expect(injectAssets("plain", { css: "a{}" })).toMatch(/^<style/);
	});
});
