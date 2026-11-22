#!/usr/bin/env node
/** Exercise the SDK and production startup inside the freshly installed artifact. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import next from "next";
import { isMainModule } from "../entrypoint.mjs";
import { PI_RUNTIME_PACKAGES, verifyPiRuntimePins } from "./pi-packages.mjs";
import { installRequestGuard, MAX_BODY_BYTES, MAX_UPLOAD_BODY_BYTES } from "../http-request-guard.mjs";
import { readCurrentLaunchToken } from "../launcher.mjs";
import { decodeSessionCookie } from "../web-auth-protocol.mjs";

function requestHead(port, route, headers) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1");
		let response = "";
		let settled = false;
		const fail = (error) => { if (!settled) { settled = true; reject(error); socket.destroy(); } };
		socket.setTimeout(2000, () => fail(new Error(`${route} did not reject an unfinished body promptly`)));
		socket.once("connect", () => socket.write(`POST ${route} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}\r\n\r\n`));
		socket.on("data", (chunk) => { response += chunk.toString(); if (!settled && response.includes("\r\n\r\n")) { settled = true; resolve(response); socket.destroy(); } });
		socket.once("error", fail);
		socket.once("close", () => fail(new Error(`${route} closed before returning an HTTP response`)));
	});
}

export async function checkInstalledRuntime(root = process.cwd()) {
	if (!process.env.PI_CODING_AGENT_DIR) throw new Error("set PI_CODING_AGENT_DIR to an isolated verification directory before checking an installed runtime");
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const version = verifyPiRuntimePins(manifest);
	for (const name of PI_RUNTIME_PACKAGES) {
		let dir = path.dirname(fileURLToPath(import.meta.resolve(name)));
		while (!fs.existsSync(path.join(dir, "package.json"))) {
			const parent = path.dirname(dir);
			if (parent === dir) throw new Error("package.json missing: " + name);
			dir = parent;
		}
		const actual = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
		if (actual !== version) throw new Error(name + " resolved to " + actual + ", expected " + version);
	}
	await import("@earendil-works/pi-coding-agent");
	await import("@earendil-works/pi-ai");

	const reserved = net.createServer();
	await new Promise((resolve, reject) => { reserved.once("error", reject); reserved.listen(0, "127.0.0.1", resolve); });
	const port = reserved.address().port;
	await new Promise((resolve) => reserved.close(resolve));
	process.env.PORT = process.env.PIWEB_PORT = String(port);
	process.env.PI_WEB_AUTH = "1";
	installRequestGuard();
	const app = next({ dev: false, dir: root });
	const server = http.createServer(app.getRequestHandler());
	const routes = ["/api/health", "/api/version", "/api/models", "/api/sessions", "/api/workspaces", "/api/pi-settings"];
	try {
		await app.prepare();
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", resolve);
		});
		const base = "http://127.0.0.1:" + server.address().port;
		const token = await readCurrentLaunchToken(port);
		if (!token) throw new Error("the installed server did not publish a verified local launch credential");
		const exchange = await fetch(base + "/?token=" + encodeURIComponent(token), { redirect: "manual", signal: AbortSignal.timeout(30_000) });
		const session = exchange.headers.getSetCookie().find((value) => value.startsWith("piweb_session_"))?.split(";")[0];
		if (exchange.status !== 303 || !session) throw new Error("production launch-token exchange failed");
		const secretPath = process.env.PI_WEB_SECRET_FILE || path.join(process.env.PI_CODING_AGENT_DIR, "web-secret");
		const secret = Buffer.from(process.env.PI_WEB_SECRET ?? fs.readFileSync(secretPath, "utf8").trim(), "base64url");
		const payload = decodeSessionCookie(session.slice(session.indexOf("=") + 1), secret);
		if (typeof payload?.sessionId !== "string" || typeof payload?.deviceType !== "string") throw new Error("production session-cookie device metadata is missing");
		const reused = await fetch(base + "/?token=" + encodeURIComponent(token), { redirect: "manual", signal: AbortSignal.timeout(30_000) });
		if (reused.status !== 307) throw new Error("a consumed launch token was accepted again");
		for (const framing of ["Content-Length: 20971520", "Transfer-Encoding: chunked", "Expect: 100-continue\r\nContent-Length: 20971520"]) {
			const rejected = await requestHead(port, "/api/health", framing);
			if (!rejected.includes(" 401 ") || rejected.includes("100 Continue")) throw new Error("unauthenticated body was admitted before the production authentication check");
		}
		const oversizedJson = await requestHead(port, "/api/health", `Cookie: ${session}\r\nContent-Length: ${MAX_BODY_BYTES + 1}`);
		if (!oversizedJson.includes(" 413 ")) throw new Error("production JSON admission limit was not enforced");
		const oversizedWire = await requestHead(port, "/api/files/upload?name=too-large.bin", `Cookie: ${session}\r\nContent-Length: ${MAX_UPLOAD_BODY_BYTES + 1}`);
		if (!oversizedWire.includes(" 413 ")) throw new Error("production upload wire admission limit was not enforced");
		const oversizedFile = await requestHead(port, "/api/files/upload?name=too-large.bin", `Cookie: ${session}\r\nContent-Length: ${100 * 1024 * 1024 + 1}`);
		if (!oversizedFile.includes(" 400 ")) throw new Error("the production upload route did not reject a declared file over 100 MiB");
		const uploadBytes = Buffer.alloc(32768, 90);
		const uploaded = await fetch(base + "/api/files/upload?name=production-smoke.bin", { method: "POST", headers: { cookie: session, "content-type": "application/octet-stream" }, body: uploadBytes, signal: AbortSignal.timeout(30_000) });
		const uploadResult = await uploaded.json();
		const uploadsRoot = path.join(process.env.PI_CODING_AGENT_DIR, "web-uploads");
		const relativeUpload = path.relative(uploadsRoot, uploadResult.data?.path ?? "");
		if (!uploaded.ok || uploadResult.success !== true || uploadResult.data.size !== uploadBytes.length || relativeUpload.startsWith("..") || path.isAbsolute(relativeUpload)
			|| !fs.readFileSync(uploadResult.data.path).equals(uploadBytes)) throw new Error("authenticated production binary upload failed");
		for (const route of routes) {
			const response = await fetch(base + route, { headers: { cookie: session }, signal: AbortSignal.timeout(30_000) });
			let body;
			try {
				body = await response.json();
			} catch {
				throw new Error(route + " returned invalid JSON (status " + response.status + ", content-type " + response.headers.get("content-type") + ", content-encoding " + response.headers.get("content-encoding") + ")");
			}
			if (!response.ok || body.success !== true) {
				throw new Error(route + " failed: " + response.status + " " + JSON.stringify(body));
			}
		}
		const page = await fetch(base + "/", { headers: { cookie: session }, signal: AbortSignal.timeout(30_000) });
		if (!page.ok || !(page.headers.get("content-type") ?? "").includes("text/html") || (await page.text()).length < 500) {
			throw new Error("production home page failed: " + page.status);
		}
		if (process.platform === "win32") {
			const sessions = path.join(process.env.PI_CODING_AGENT_DIR, "sessions");
			fs.mkdirSync(sessions, { recursive: true });
			const fixture = fs.mkdtempSync(path.join(sessions, "verify-recycle-"));
			const file = path.join(fixture, "verify-recycle.jsonl");
			const record = { type: "session", version: 3, id: path.basename(fixture), cwd: root, timestamp: new Date().toISOString() };
			fs.writeFileSync(file, JSON.stringify(record) + "\n", { flag: "wx" });
			const id = Buffer.from(file, "utf8").toString("base64url");
			const removal = await fetch(`${base}/api/sessions/${id}`, {
				method: "DELETE", headers: { cookie: session, origin: base }, signal: AbortSignal.timeout(70_000),
			});
			const result = await removal.json();
			if (!removal.ok || result.success !== true || fs.existsSync(file)) {
				throw new Error(`installed Windows session recycling failed (${removal.status}, ${result.errorCode ?? "no error code"})`);
			}
		}
		return { version, routes, homePage: true, launchTokenExchange: true, deviceCookieMetadata: true, earlyAuthentication: true, authenticatedUpload: true, uploadContentLimitMiB: 100, uploadWireLimitMiB: 101 };
	} finally {
		if (server.listening) {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
		await app.close();
	}
}

if (isMainModule(import.meta.url)) {
	try {
		console.log(JSON.stringify(await checkInstalledRuntime()));
		process.exit(0);
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}
