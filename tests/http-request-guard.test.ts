import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/web-auth";
import { recycleFixture } from "./fixtures/recycle";
import { createRequestGuard } from "../scripts/http-request-guard.mjs";
import { cookieNameForAuthority, encodeSessionCookie } from "../scripts/web-auth-protocol.mjs";
import { TLS_KEY, TLS_CERT } from "./fixtures/localhost-tls";
import { createMobileProxy } from "../src/lib/remote/mobile-proxy";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function server(options = {}) {
	const guard = createRequestGuard({ env: { PI_WEB_AUTH: "0" }, ...options });
	let calls = 0;
	let completed = 0;
	const srv = http.createServer((req, res) => {
		if (!guard(req, res)) return;
		calls += 1;
		let bytes = 0;
		req.on("data", (chunk) => { bytes += chunk.length; });
		req.on("end", () => { completed += 1; if (!res.writableEnded) res.end(String(bytes)); });
	});
	await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => { srv.closeAllConnections(); srv.close(() => resolve()); }));
	const port = (srv.address() as net.AddressInfo).port;
	return { port, authority: `127.0.0.1:${port}`, calls: () => calls, completed: () => completed };
}
function raw(port: number, head: string, body = "", secure = false) {
	return new Promise<string>((resolve, reject) => {
		const socket = secure ? tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false }) : net.connect(port, "127.0.0.1");
		let result = "";
		socket.setTimeout(1500, () => { socket.destroy(); reject(new Error("head was not rejected promptly")); });
		socket.on("data", (chunk) => { result += chunk; if (result.includes("\r\n\r\n")) { socket.destroy(); resolve(result); } });
		socket.on("error", reject);
		socket.once(secure ? "secureConnect" : "connect", () => socket.write(head + body));
	});
}
describe("HTTP admission ahead of body consumption", () => {
	it.each(["Content-Length: 10485760", "Transfer-Encoding: chunked"])("rejects an unauthenticated unfinished body from its head: %s", async (framing) => {
		const s = await server({ env: { PI_WEB_AUTH: "1" } });
		const result = await raw(s.port, `POST /api/agent/a HTTP/1.1\r\nHost: ${s.authority}\r\n${framing}\r\n\r\n`);
		expect(result).toContain("401");
		expect(s.calls()).toBe(0);
	});
	it("bounds public login bodies and authorized chunked bodies", async () => {
		const s = await server({ maxBodyBytes: 1024 });
		expect(await raw(s.port, `POST /api/web-auth HTTP/1.1\r\nHost: ${s.authority}\r\nContent-Length: 65537\r\n\r\n`)).toContain("413");
		const body = "x".repeat(1025);
		expect(await raw(s.port, `POST /api/agent/a HTTP/1.1\r\nHost: ${s.authority}\r\nTransfer-Encoding: chunked\r\n\r\n`, `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`)).toContain("413");
	});
	it("limits aggregate in-flight requests and recovers the reservation on disconnect", async () => {
		const s = await server({ maxBodyBytes: 1024, maxInflightBytes: 1024, bodyTimeoutMs: 1000 });
		const first = net.connect(s.port, "127.0.0.1");
		await new Promise<void>((resolve) => first.once("connect", () => { first.write(`POST /api/agent/a HTTP/1.1\r\nHost: ${s.authority}\r\nTransfer-Encoding: chunked\r\n\r\n`); resolve(); }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await raw(s.port, `POST /api/agent/a HTTP/1.1\r\nHost: ${s.authority}\r\nContent-Length: 1\r\n\r\n`)).toContain("503");
		first.destroy();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect((await fetch(`http://${s.authority}/api/agent/a`, { method: "POST", body: "x" })).status).toBe(200);
	});
	it("accepts a current signed cookie and rejects a cookie for another authority", async () => {
		const secret = randomBytes(32);
		const s = await server({ env: { PI_WEB_AUTH: "1", PI_WEB_SECRET: secret.toString("base64url"), PI_CODING_AGENT_DIR: path.join(process.cwd(), ".audit-2026-11-13", "guard-nonexistent-agent") } });
		const now = Date.now();
		const signed = createSessionCookie(s.authority, secret, now);
		expect(signed.maxAgeSeconds).toBe(30 * 24 * 60 * 60);
		const value = signed.value;
		const response = await fetch(`http://${s.authority}/api/agent/a`, { method: "POST", headers: { cookie: `${cookieNameForAuthority(s.authority)}=${value}` }, body: "ok" });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("2");
		const wrong = encodeSessionCookie({ version: 1, authority: "localhost:3", issuedAt: now, expiresAt: now + 10000 }, secret);
		expect((await fetch(`http://${s.authority}/api/agent/a`, { method: "POST", headers: { cookie: `${cookieNameForAuthority(s.authority)}=${wrong}` }, body: "ok" })).status).toBe(401);
	});
	it("does not deliver end or commit a valid prefix after the chunked body exceeds its limit", async () => {
		const s = await server({ maxBodyBytes: 8 });
		expect(await raw(s.port, `POST /api/agent/a HTTP/1.1\r\nHost: ${s.authority}\r\nTransfer-Encoding: chunked\r\n\r\n`, '2\r\n{}\r\n9\r\n123456789\r\n0\r\n\r\n')).toContain("413");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(s.calls()).toBe(1); expect(s.completed()).toBe(0);
	});
	it("lets Node reject conflicting framing before application admission", async () => {
		const s = await server();
		expect(await raw(s.port, `POST /api/agent/a HTTP/1.1\r\nHost: ${s.authority}\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n`, "0\r\n\r\n")).toContain("400");
		expect(s.calls()).toBe(0);
	});
	it("rejects requests without a credential before touching authentication storage", async () => {
		const s = await server({ env: { PI_WEB_AUTH: "1", PI_CODING_AGENT_DIR: "must-not-read-auth" } });
		const reads = vi.spyOn(fs, "readFileSync"); const stats = vi.spyOn(fs, "statSync");
		try {
			expect(await raw(s.port, `POST /api/agent/a HTTP/1.1\r\nHost: ${s.authority}\r\nContent-Length: 1\r\n\r\n`)).toContain("401");
			expect([...reads.mock.calls, ...stats.mock.calls].some(([file]) => String(file).includes("must-not-read-auth"))).toBe(false);
		} finally { reads.mockRestore(); stats.mockRestore(); }
	});
	it("does not load revocation storage for a forged cookie signature", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-guard-forged-")); cleanups.push(() => recycleFixture(root));
		const secret = randomBytes(32);
		const s = await server({ env: { PI_WEB_AUTH: "1", PI_WEB_SECRET: secret.toString("base64url"), PI_CODING_AGENT_DIR: root } });
		const forged = createSessionCookie(s.authority, randomBytes(32));
		const stats = vi.spyOn(fs, "statSync");
		try {
			expect((await fetch(`http://${s.authority}/api/agent/a`, { method: "POST", headers: { cookie: `${forged.name}=${forged.value}` }, body: "x" })).status).toBe(401);
			expect(stats.mock.calls.some(([file]) => String(file) === path.join(root, "web-revocations.json"))).toBe(false);
		} finally { stats.mockRestore(); }
	});
	it("does not let slow public login requests consume the authenticated request budget", async () => {
		const secret = randomBytes(32);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-guard-public-")); cleanups.push(() => recycleFixture(root));
		const s = await server({ env: { PI_WEB_AUTH: "1", PI_WEB_SECRET: secret.toString("base64url"), PI_CODING_AGENT_DIR: root } });
		const sockets: net.Socket[] = [];
		try {
			for (let i = 0; i < 8; i += 1) {
				const socket = net.connect(s.port, "127.0.0.1"); sockets.push(socket);
				await new Promise<void>((resolve) => socket.once("connect", () => { socket.write(`POST /api/web-auth HTTP/1.1\r\nHost: ${s.authority}\r\nTransfer-Encoding: chunked\r\n\r\n`); resolve(); }));
			}
			await vi.waitFor(() => expect(s.calls()).toBe(8));
			expect(await raw(s.port, `POST /api/web-auth HTTP/1.1\r\nHost: ${s.authority}\r\nContent-Length: 1\r\n\r\n`)).toContain("503");
			const signed = createSessionCookie(s.authority, secret);
			expect((await fetch(`http://${s.authority}/api/agent/a`, { method: "POST", headers: { cookie: `${signed.name}=${signed.value}` }, body: "x" })).status).toBe(200);
		} finally { for (const socket of sockets) socket.destroy(); }
	});
	it("invalidates cached authentication data when revocations change", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-guard-revocations-")); cleanups.push(() => recycleFixture(root));
		const secret = randomBytes(32); fs.writeFileSync(path.join(root, "web-secret"), secret.toString("base64url"));
		const s = await server({ env: { PI_WEB_AUTH: "1", PI_CODING_AGENT_DIR: root } });
		const signed = createSessionCookie(s.authority, secret);
		const request = () => fetch(`http://${s.authority}/api/agent/a`, { method: "POST", headers: { cookie: `${signed.name}=${signed.value}` }, body: "x" });
		expect((await request()).status).toBe(200);
		fs.writeFileSync(path.join(root, "web-revocations.json"), JSON.stringify({ notBefore: Date.now() + 1, revoked: {} }));
		expect((await request()).status).toBe(401);
	});
	it("rejects an exchange from the previous revocation generation even if signed after the logout cutoff", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-guard-epoch-")); cleanups.push(() => recycleFixture(root));
		const secret = randomBytes(32); const cutoff = Date.now() - 10;
		fs.writeFileSync(path.join(root, "web-revocations.json"), JSON.stringify({ notBefore: cutoff, revoked: {} }));
		const s = await server({ env: { PI_WEB_AUTH: "1", PI_WEB_SECRET: secret.toString("base64url"), PI_CODING_AGENT_DIR: root } });
		const stale = createSessionCookie(s.authority, secret, Date.now(), "browser", 0);
		const fresh = createSessionCookie(s.authority, secret, Date.now(), "browser", cutoff);
		for (const [cookie, status] of [[stale, 401], [fresh, 200]] as const) {
			expect((await fetch(`http://${s.authority}/api/agent/a`, { method: "POST", headers: { cookie: `${cookie.name}=${cookie.value}` }, body: "x" })).status).toBe(status);
		}
	});
	it.each(["http", "https"] as const)("preloads ahead of native %s request listeners and blocks Expect: 100-continue", async (protocol) => {
		const reserve = net.createServer();
		await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
		const port = (reserve.address() as net.AddressInfo).port;
		await new Promise<void>((resolve) => reserve.close(() => resolve()));
		const tlsOptions = protocol === "https" ? `${JSON.stringify({ key: TLS_KEY, cert: TLS_CERT })},` : "";
		const child = spawn(process.execPath, ["--import", pathToFileURL(path.resolve("scripts/http-request-guard.mjs")).href, "--input-type=module", "-e", `import http from 'node:${protocol}';http.createServer(${tlsOptions}(req,res)=>{req.on('data',()=>{});req.on('end',()=>res.end('unexpected handler'));}).listen(${port},'127.0.0.1',()=>console.log('ready'));`], { env: { ...process.env, PIWEB_HTTP_GUARD: "1", PIWEB_PORT: String(port), PI_WEB_AUTH: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
		cleanups.push(() => child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); }));
		await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", (code) => reject(new Error(`guard fixture exited ${code}: ${stderr}`))); });
		const response = await raw(port, `POST /api/agent/a HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nExpect: 100-continue\r\nContent-Length: 10485760\r\n\r\n`, "", protocol === "https");
		expect(response).toContain("401");
		expect(response).not.toContain("100 Continue");
		const ordinary = await raw(port, `POST /api/agent/a HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 10485760\r\n\r\n`, "", protocol === "https");
		expect(ordinary).toContain("401");
	});
	it("keeps a separate proxy port's own Expect guard ahead of the preload fallback", async () => {
		const reserve = net.createServer();
		await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
		const port = (reserve.address() as net.AddressInfo).port;
		await new Promise<void>((resolve) => reserve.close(() => resolve()));
		const moduleUrl = pathToFileURL(path.resolve("scripts/http-request-guard.mjs")).href;
		const fixture = `import http from 'node:http';import {createRequestGuard} from ${JSON.stringify(moduleUrl)};const admit=createRequestGuard({env:{PI_WEB_AUTH:'1'}});const server=http.createServer((req,res)=>{if(admit(req,res))res.end('unexpected handler')});server.on('checkContinue',(req,res)=>{if(admit(req,res)){res.writeContinue();server.emit('request',req,res)}});server.listen(${port},'127.0.0.1',()=>console.log('ready'));`;
		const child = spawn(process.execPath, ["--import", moduleUrl, "--input-type=module", "-e", fixture], { env: { ...process.env, PIWEB_HTTP_GUARD: "1", PIWEB_PORT: String(port === 65535 ? port - 1 : port + 1), PI_WEB_AUTH: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
		cleanups.push(() => child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); }));
		await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", (code) => reject(new Error(`proxy guard fixture exited ${code}: ${stderr}`))); });
		const response = await raw(port, `POST /api/agent/a HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nExpect: 100-continue\r\nContent-Length: 10485760\r\n\r\n`);
		expect(response).toContain("401"); expect(response).not.toContain("100 Continue");
	});
	it("keeps bounded multipart uploads on their own authenticated channel", async () => {
		const s = await server({ maxBodyBytes: 1024, maxUploadBodyBytes: 2048 });
		expect((await fetch(`http://${s.authority}/api/files/upload`, { method: "POST", body: "x".repeat(2048) })).status).toBe(200);
		expect(await raw(s.port, `POST /api/files/upload HTTP/1.1\r\nHost: ${s.authority}\r\nContent-Length: 2049\r\n\r\n`)).toContain("413");
		expect(await raw(s.port, `POST /api/files HTTP/1.1\r\nHost: ${s.authority}\r\nContent-Length: 2048\r\n\r\n`)).toContain("413");
		const protectedServer = await server({ env: { PI_WEB_AUTH: "1" } });
		expect(await raw(protectedServer.port, `POST /api/files/upload HTTP/1.1\r\nHost: ${protectedServer.authority}\r\nContent-Length: 104857600\r\n\r\n`)).toContain("401");
	});
	it.each(["Content-Length: 10485760", "Transfer-Encoding: chunked", "Expect: 100-continue\r\nContent-Length: 10485760"])("rejects remote proxy requests from the head without contacting the upstream: %s", async (framing) => {
		const proxy = createMobileProxy({ targetPort: 1, admitRequest: createRequestGuard({ env: { PI_WEB_AUTH: "1" } }) });
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => new Promise<void>((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
		const port = (proxy.address() as net.AddressInfo).port;
		const response = await raw(port, `POST /api/agent/a HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${framing}\r\n\r\n`);
		expect(response).toContain("401"); expect(response).not.toContain("100 Continue"); expect(response).not.toContain("502");
	});
});
