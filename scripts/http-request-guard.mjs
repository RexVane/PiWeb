/** Request head/body admission before Next clones the incoming stream. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { cookieNameForAuthority, validCookieValue } from "./web-auth-protocol.mjs";

export const MAX_BODY_BYTES = 12 * 1024 * 1024;
export const PUBLIC_BODY_BYTES = 64 * 1024;
export const MAX_UPLOAD_BODY_BYTES = 101 * 1024 * 1024;
export const MAX_INFLIGHT_BYTES = 128 * 1024 * 1024;
const MAX_JSON_INFLIGHT_BYTES = 48 * 1024 * 1024;
const GUARDED = Symbol("piweb-request-guard");
const authFiles = new Map();
function readAuthFile(file, maximum) {
	const stat = fs.statSync(file);
	if (!stat.isFile() || stat.size > maximum) throw new Error("invalid authentication file");
	const stamp = [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size].join(":");
	const cached = authFiles.get(file);
	if (cached?.stamp === stamp) return cached.value;
	const handle = fs.openSync(file, "r");
	let value;
	try {
		const data = Buffer.alloc(maximum + 1);
		let length = 0;
		while (length < data.length) {
			const count = fs.readSync(handle, data, length, data.length - length, length);
			if (!count) break;
			length += count;
		}
		if (length > maximum) throw new Error("invalid authentication file");
		value = data.toString("utf8", 0, length);
	} finally { fs.closeSync(handle); }
	authFiles.set(file, { stamp, value });
	if (authFiles.size > 64) authFiles.delete(authFiles.keys().next().value);
	return value;
}
function agentDir(env) {
	const raw = env.PI_CODING_AGENT_DIR;
	return !raw ? path.join(os.homedir(), ".pi", "agent") : raw === "~" ? os.homedir()
		: /^~[\\/]/.test(raw) ? path.join(os.homedir(), raw.slice(2)) : path.resolve(raw);
}
function authSecret(env) {
	const raw = env.PI_WEB_SECRET ?? readAuthFile(env.PI_WEB_SECRET_FILE || path.join(agentDir(env), "web-secret"), 1024).trim();
	const secret = Buffer.from(raw, "base64url");
	if (secret.length !== 32 || secret.toString("base64url") !== raw) throw new Error("invalid authentication secret");
	return secret;
}
function authRevocations(env) {
	let revocations = { notBefore: 0, revoked: new Map() };
	try {
		const pathname = path.join(agentDir(env), "web-revocations.json");
		const raw = readAuthFile(pathname, 4 * 1024 * 1024);
		const cached = authFiles.get(pathname);
		if (cached?.parsed) return cached.parsed;
		const file = JSON.parse(raw);
		if (!Number.isSafeInteger(file.notBefore) || file.notBefore < 0 || !file.revoked || typeof file.revoked !== "object" || Array.isArray(file.revoked)
			|| Object.values(file.revoked).some((expiresAt) => !Number.isSafeInteger(expiresAt) || expiresAt < 0)) throw new Error("invalid revocations");
		revocations = { notBefore: file.notBefore, revoked: new Map(Object.entries(file.revoked)) };
		if (cached) cached.parsed = revocations;
	} catch (error) { if (error.code !== "ENOENT") throw error; }
	return revocations;
}
function cookie(header, name) {
	for (const part of String(header ?? "").split(";")) {
		const split = part.indexOf("=");
		if (part.slice(0, split).trim() !== name) continue;
		try { return decodeURIComponent(part.slice(split + 1).trim()); } catch { return undefined; }
	}
}
function authorityFor(req, env) {
	const host = req.headers.host;
	if (typeof host !== "string") return undefined;
	try {
		const url = new URL(`http://${host}`);
		if (url.username || url.password || url.host.toLowerCase() !== host.toLowerCase()) return undefined;
		const name = url.hostname.toLowerCase();
		const trusted = `${env.PI_WEB_TRUSTED_HOSTS ?? ""},${env.PI_WEB_ALLOWED_HOSTS ?? ""}`.split(",").map((value) => value.trim().toLowerCase());
		if (!(name === "localhost" || name.endsWith(".localhost") || net.isIP(name.replace(/^\[|\]$/g, "")) || trusted.includes(name))) return undefined;
		return url.host.toLowerCase();
	} catch { return undefined; }
}
function reject(req, res, status, error) {
	if (res.headersSent) { req.destroy(); return false; }
	res.shouldKeepAlive = false;
	res.writeHead(status, { "content-type": "application/json", connection: "close", "cache-control": "no-store" });
	// Flush the small rejection without reading an unbounded peer body.
	res.once("finish", () => req.socket?.destroy());
	res.end(JSON.stringify({ success: false, error }));
	return false;
}
/** Injectable gate also supports isolated HTTP regression servers. */
export function createRequestGuard({ env = process.env, maxBodyBytes = MAX_BODY_BYTES, maxUploadBodyBytes = MAX_UPLOAD_BODY_BYTES, maxInflightBytes = MAX_INFLIGHT_BYTES, bodyTimeoutMs = 15_000 } = {}) {
	let reservedBytes = 0;
	let jsonReservedBytes = 0;
	let inflightUploads = 0;
	let inflightRequests = 0;
	let publicRequests = 0;
	let publicReservedBytes = 0;
	return function admit(req, res) {
		if (req[GUARDED]) return true;
		const authority = authorityFor(req, env);
		if (!authority) return reject(req, res, 403, "untrusted host");
		const readOnly = req.method === "GET" || req.method === "HEAD";
		if (!readOnly) {
			const origin = req.headers.origin;
			let safe = req.headers["sec-fetch-site"] !== "cross-site";
			if (origin) { try { safe &&= new URL(origin).host.toLowerCase() === authority; } catch { safe = false; } }
			if (!safe) return reject(req, res, 403, "cross-origin request");
		}
		let pathname;
		try { pathname = new URL(req.url, `http://${authority}`).pathname; } catch { return reject(req, res, 400, "invalid request URL"); }
		const publicRoute = pathname === "/api/web-auth" || pathname === "/login" || pathname === "/pair";
		const uploadRoute = pathname === "/api/files/upload";
		const hasBody = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) > 0 || !readOnly;
		if (hasBody && !publicRoute && String(env.PI_WEB_AUTH ?? "1").trim() !== "0") {
			const candidate = cookie(req.headers.cookie, cookieNameForAuthority(authority));
			if (!candidate || candidate.length > 4096 || !candidate.startsWith("v1.")) return reject(req, res, 401, "authentication required");
			let authorized = false;
			try {
				const secret = authSecret(env);
				authorized = validCookieValue(candidate, authority, secret) && validCookieValue(candidate, authority, secret, Date.now(), authRevocations(env));
			} catch { /* Unavailable credentials fail closed before receiving the body. */ }
			if (!authorized) return reject(req, res, 401, "authentication required");
		}
		if (!hasBody) { req[GUARDED] = true; return true; }
		const limit = publicRoute ? PUBLIC_BODY_BYTES : uploadRoute ? maxUploadBodyBytes : maxBodyBytes;
		const rawLength = req.headers["content-length"];
		if (rawLength !== undefined && (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength)))) return reject(req, res, 400, "invalid content length");
		const length = rawLength === undefined ? limit : Number(rawLength);
		if (length > limit) return reject(req, res, 413, "request body is too large");
		if (publicRoute ? publicRequests >= 8 || publicReservedBytes + length > PUBLIC_BODY_BYTES * 8
			: reservedBytes + length > maxInflightBytes || inflightRequests >= 32 || (uploadRoute ? inflightUploads >= 1 : jsonReservedBytes + length > MAX_JSON_INFLIGHT_BYTES)) return reject(req, res, 503, "too many requests; retry shortly");
		if (publicRoute) { publicRequests += 1; publicReservedBytes += length; }
		else { reservedBytes += length; if (uploadRoute) inflightUploads += 1; else jsonReservedBytes += length; inflightRequests += 1; }
		let received = 0;
		let released = false;
		let blocked = false;
		const release = () => { if (!released) { released = true; if (publicRoute) { publicRequests -= 1; publicReservedBytes -= length; } else { reservedBytes -= length; inflightRequests -= 1; if (uploadRoute) inflightUploads -= 1; else jsonReservedBytes -= length; } clearTimeout(timer); } };
		const emit = req.emit;
		const abortBody = (status, reason) => {
			if (blocked) return false;
			blocked = true;
			req.pause();
			reject(req, res, status, reason);
			if (!req.aborted) { req.aborted = true; emit.call(req, "aborted"); }
			if (req.listenerCount("error")) emit.call(req, "error", Object.assign(new Error(reason), { code: "ERR_HTTP_BODY_REJECTED" }));
			return false;
		};
		const timer = setTimeout(() => abortBody(408, "request body timed out"), uploadRoute ? Math.max(bodyTimeoutMs, 120_000) : bodyTimeoutMs);
		timer.unref?.();
		res.once("close", release);
		res.once("finish", release);
		req.once("aborted", release);
		req.once("end", () => clearTimeout(timer));
		req.emit = function (event, ...args) {
			if (blocked && (event === "data" || event === "end")) return false;
			if (event === "data") {
				received += args[0].length;
				if (received > limit) return abortBody(413, "request body is too large");
			}
			return emit.call(this, event, ...args);
		};
		req[GUARDED] = true;
		return true;
	};
}
export function installRequestGuard({ env = process.env, ...options } = {}) {
	const installed = Symbol.for("piweb.http-request-guard-installed");
	if (http.Server.prototype[installed]) return;
	const port = Number(env.PIWEB_PORT);
	if (!Number.isInteger(port) || port < 1) return;
	http.Server.prototype[installed] = { port };
	const admit = createRequestGuard({ env, ...options });
	for (const Server of [http.Server, https.Server]) {
		const originalEmit = Server.prototype.emit;
		Server.prototype.emit = function (event, ...args) {
			if ((event === "request" || event === "checkContinue") && this.address()?.port === port && !admit(args[0], args[1])) return true;
			return originalEmit.call(this, event, ...args);
		};
	}
	for (const module of [http, https]) {
		const originalCreate = module.createServer;
		module.createServer = function (...args) {
			const server = originalCreate.apply(this, args);
			server.on("checkContinue", (req, res) => {
				// A downstream proxy may own its own guard/Expect handler. Let it handle
				// this event once instead of sending an automatic 100 before its check.
				if (server.listenerCount("checkContinue") > 1) return;
				if (server.address()?.port !== port || admit(req, res)) { res.writeContinue(); server.emit("request", req, res); }
			});
			server.on("checkExpectation", (req, res) => { if (server.listenerCount("checkExpectation") === 1) reject(req, res, 417, "unsupported expectation"); });
			return server;
		};
	}
	syncBuiltinESMExports();
}
if (process.env.PIWEB_HTTP_GUARD === "1") installRequestGuard();

export function requestGuardInstalled(port) {
	const guard = http.Server.prototype[Symbol.for("piweb.http-request-guard-installed")];
	return Boolean(guard && (port === undefined || guard.port === Number(port)));
}
