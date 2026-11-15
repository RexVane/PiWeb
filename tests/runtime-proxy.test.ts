import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRuntimeProxy, type UndiciModule } from "../src/lib/runtime-proxy";
import { runtimeRequire } from "../scripts/runtime-require.mjs";

const cleanups: Array<() => Promise<void> | void> = [];
let savedEnv: NodeJS.ProcessEnv;

async function startHttpProxy(label: string, targetPort: number) {
	let hits = 0;
	const server = http.createServer((req, res) => {
		hits += 1;
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end(`${label}:${req.url}`);
	});
	server.on("connect", (_req, clientSocket, head) => {
		hits += 1;
		const upstream = net.connect(targetPort, "127.0.0.1", () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
		upstream.on("error", () => clientSocket.destroy());
		clientSocket.on("error", () => upstream.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected tcp address");
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { url: `http://127.0.0.1:${address.port}`, hits: () => hits };
}

function getHttpOverProxy(targetUrl: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = http.get(targetUrl, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { body += chunk; });
			res.on("end", () => resolve(body));
		});
		req.on("error", reject);
	});
}

function loadGlobalDispatcherName(): string | undefined {
	const require = runtimeRequire(import.meta.url);
	try {
		const undici = require("undici") as UndiciModule;
		return undici.getGlobalDispatcher?.()?.constructor?.name;
	} catch {
		const root = process.env.PI_WEB_ROOT ? path.resolve(process.env.PI_WEB_ROOT) : process.cwd();
		const { pathToFileURL } = require("node:url") as typeof import("node:url");
		const undici = runtimeRequire(pathToFileURL(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")).href)("undici") as UndiciModule;
		return undici.getGlobalDispatcher?.()?.constructor?.name;
	}
}

beforeEach(() => {
	savedEnv = { ...process.env };
});

afterEach(() => {
	applyRuntimeProxy("", { env: process.env, readSystemProxy: () => null });
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnv)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

afterAll(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("runtime proxy live switching", () => {
	it("switches fetch and node:http between proxies immediately and clears back to direct without restart", async () => {
		const target = http.createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(`target:${req.url}`);
		});
		await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
		const targetAddr = target.address();
		if (!targetAddr || typeof targetAddr === "string") throw new Error("expected target address");
		cleanups.push(() => new Promise<void>((resolve) => target.close(() => resolve())));

		const proxyA = await startHttpProxy("proxy-a", targetAddr.port);
		const proxyB = await startHttpProxy("proxy-b", targetAddr.port);

		delete process.env.HTTP_PROXY;
		delete process.env.HTTPS_PROXY;
		delete process.env.http_proxy;
		delete process.env.https_proxy;
		delete process.env.NO_PROXY;
		delete process.env.no_proxy;
		delete process.env.PIWEB_INHERITED_HTTP_PROXY;
		delete process.env.PIWEB_INHERITED_HTTPS_PROXY;
		delete process.env.PIWEB_PROXY_SOURCE;

		expect(applyRuntimeProxy(proxyA.url, { readSystemProxy: () => null })).toEqual({
			proxy: proxyA.url, source: "settings", supported: true, activeInProcess: true,
		});
		expect(loadGlobalDispatcherName()).toBe("EnvHttpProxyAgent");
		expect(await (await fetch("http://example.invalid/one")).text()).toBe("target:/one");
		expect(await getHttpOverProxy("http://example.invalid/two")).toBe("proxy-a:http://example.invalid/two");
		expect(proxyA.hits()).toBe(2);
		expect(await (await fetch(`http://127.0.0.1:${targetAddr.port}/local`)).text()).toBe("target:/local");
		expect(proxyA.hits()).toBe(2);

		expect(applyRuntimeProxy(proxyB.url, { readSystemProxy: () => null })).toEqual({
			proxy: proxyB.url, source: "settings", supported: true, activeInProcess: true,
		});
		expect(await (await fetch("http://example.invalid/three")).text()).toBe("target:/three");
		expect(await getHttpOverProxy("http://example.invalid/four")).toBe("proxy-b:http://example.invalid/four");
		expect(proxyB.hits()).toBe(2);
		expect(proxyA.hits()).toBe(2);

		expect(applyRuntimeProxy("", { readSystemProxy: () => null })).toEqual({
			proxy: null, source: "none", supported: true, activeInProcess: true,
		});
		expect(loadGlobalDispatcherName()).toBe("Agent");
		expect((http.globalAgent as unknown as { options?: { proxyEnv?: unknown } }).options?.proxyEnv).toBeUndefined();
		expect(process.env.HTTP_PROXY).toBeUndefined();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
		expect(process.env.PIWEB_PROXY_SOURCE).toBe("none");
	});

	it("restores inherited env proxy or system proxy when manual httpProxy is cleared", () => {
		const envWithInherited: Record<string, string | undefined> = { HTTP_PROXY: "http://inherited:3128" };
		const fakeHttp = { Agent: http.Agent, globalAgent: new http.Agent() };
		const fakeHttps = { Agent: https.Agent, globalAgent: new https.Agent() };

		expect(applyRuntimeProxy("http://127.0.0.1:7890", { env: envWithInherited, readSystemProxy: () => null, httpModule: fakeHttp, httpsModule: fakeHttps })).toMatchObject({
			proxy: "http://127.0.0.1:7890", source: "settings", activeInProcess: true,
		});
		expect(envWithInherited.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
		expect((fakeHttp.globalAgent as unknown as { options?: { proxyEnv?: Record<string, string | undefined> } }).options?.proxyEnv?.HTTP_PROXY).toBe("http://127.0.0.1:7890");

		expect(applyRuntimeProxy("", { env: envWithInherited, readSystemProxy: () => ({ http: "http://system:8080", https: "http://system:8443", noProxy: "*.corp" }), httpModule: fakeHttp, httpsModule: fakeHttps })).toMatchObject({
			proxy: "http://inherited:3128", source: "env", activeInProcess: true,
		});
		expect(envWithInherited.HTTP_PROXY).toBe("http://inherited:3128");
		expect(envWithInherited.HTTPS_PROXY).toBeUndefined();

		const envSystemOnly: Record<string, string | undefined> = {};
		expect(applyRuntimeProxy("http://127.0.0.1:7890", { env: envSystemOnly, readSystemProxy: () => null, httpModule: fakeHttp, httpsModule: fakeHttps }).activeInProcess).toBe(true);
		expect(applyRuntimeProxy("", { env: envSystemOnly, readSystemProxy: () => ({ http: "http://system:8080", https: "http://system:8443", noProxy: "*.internal.example" }), httpModule: fakeHttp, httpsModule: fakeHttps })).toMatchObject({
			proxy: "http://system:8443", source: "system", activeInProcess: true,
		});
		expect(envSystemOnly.NO_PROXY).toBe("localhost,127.0.0.1,::1,*.internal.example");
	});

	it("reports unsupported Node versions or missing undici without crashing", () => {
		const fakeHttp = { Agent: http.Agent, globalAgent: new http.Agent() };
		const fakeHttps = { Agent: https.Agent, globalAgent: new https.Agent() };
		const oldNodeEnv: Record<string, string | undefined> = {};
		expect(applyRuntimeProxy("http://127.0.0.1:7890", { env: oldNodeEnv, nodeVersion: "22.19.0", httpModule: fakeHttp, httpsModule: fakeHttps })).toEqual({
			proxy: "http://127.0.0.1:7890", source: "settings", supported: false, activeInProcess: false,
		});
		expect(oldNodeEnv.HTTP_PROXY).toBe("http://127.0.0.1:7890");

		expect(applyRuntimeProxy("http://127.0.0.1:7890", { env: {}, loadUndici: () => null, httpModule: fakeHttp, httpsModule: fakeHttps })).toEqual({
			proxy: "http://127.0.0.1:7890", source: "settings", supported: true, activeInProcess: false,
		});
	});
});
