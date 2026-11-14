/**
 * 启动令牌（借鉴 deepseek-harness 的 launch token）。
 *
 * 每个进程启动时生成一次 32 字节随机值，由启动器在浏览器里打开 `?token=…` 链接。
 * 浏览器用它换一张签名 Cookie，之后不再需要令牌。
 * 令牌不接受出现在 API 路径上，也不接受走 Authorization 头 —— 只有根路径的
 * GET 能消费它，这样令牌不会因为某个 API 客户端的日志而泄漏。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { launchTokenIpcPath, launchIpcProof, validLaunchIpcProof } from "../../scripts/web-auth-protocol.mjs";
import { agentDir, loadSessionRevocations } from "./web-secret";

export const TOKEN_QUERY = "token";
export const LAUNCH_TOKEN_TTL_MS = 5 * 60_000;
interface LaunchState { token: string; expiresAt: number; cutoff: number }
const launchGlobal = globalThis as typeof globalThis & {
	__piwebLaunchTokens?: Map<string, LaunchState>;
	__piwebLaunchIpc?: Map<string, net.Server>;
	__piwebLaunchRotation?: ReturnType<typeof setInterval>;
};
const tokens = launchGlobal.__piwebLaunchTokens ??= new Map();
const ipcServers = launchGlobal.__piwebLaunchIpc ??= new Map();

/** Actual exchange is bounded and consumes the token; pure equality alone never authorizes login. */
export function consumeLaunchToken(candidate: string, expected: string | undefined, now = Date.now(), cutoff = 0): boolean {
	if (!expected) return false;
	const key = `${agentDir()}:${process.env.PIWEB_PORT ?? ""}`;
	let current = tokens.get(key);
	if (!current) { current = { token: expected, expiresAt: now + LAUNCH_TOKEN_TTL_MS, cutoff }; tokens.set(key, current); }
	if (cutoff > current.cutoff || now >= current.expiresAt) {
		current = { token: randomBytes(32).toString("base64url"), expiresAt: now + LAUNCH_TOKEN_TTL_MS, cutoff };
		tokens.set(key, current); publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: current.token, PIWEB_PORT: process.env.PIWEB_PORT });
		return false;
	}
	if (!validLaunchToken(candidate, current.token)) return false;
	const fresh = { token: randomBytes(32).toString("base64url"), expiresAt: now + LAUNCH_TOKEN_TTL_MS, cutoff };
	tokens.set(key, fresh); publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: fresh.token, PIWEB_PORT: process.env.PIWEB_PORT });
	return true;
}

export function invalidateLaunchTokens(cutoff = Date.now()): void {
	const stateKey = `${agentDir()}:${process.env.PIWEB_PORT ?? ""}`;
	const current = tokens.get(stateKey);
	const fresh = { token: randomBytes(32).toString("base64url"), expiresAt: Date.now() + LAUNCH_TOKEN_TTL_MS, cutoff: Math.max(cutoff, current?.cutoff ?? 0) };
	tokens.set(stateKey, fresh);
	publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: fresh.token, PIWEB_PORT: process.env.PIWEB_PORT });
}

export function resetLaunchTokenState(): void {
	tokens.clear();
	if (launchGlobal.__piwebLaunchRotation) { clearInterval(launchGlobal.__piwebLaunchRotation); launchGlobal.__piwebLaunchRotation = undefined; }
	for (const server of ipcServers.values()) server.close();
	ipcServers.clear();
}
export function currentLaunchToken(): string | undefined {
	return tokens.get(`${agentDir()}:${process.env.PIWEB_PORT ?? ""}`)?.token;
}

/** 恒定时间比较；两边任一为空（没配令牌）时一律无效 */
export function validLaunchToken(candidate: string | undefined, expected: string | undefined): boolean {
	if (!candidate || !expected) return false;
	const actual = Buffer.from(candidate, "utf8");
	const wanted = Buffer.from(expected, "utf8");
	return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted);
}

/**
 * 正在运行的实例把自己的启动令牌留在 `<agentDir>/web-launch/<端口>.token`。
 *
 * 用途只有一个：再次运行启动器、发现这个端口上已有 PiWeb 时，能直接打开带令牌的登录链接，
 * 而不是把用户扔到一个他手里没有凭据的登录页。文件和 web-secret 放在同一个目录、同样 0600：
 * 读得到它的人本来就读得到签名密钥，不额外扩大暴露面。路径规则与 scripts/launcher.mjs 一致。
 */
export function launchTokenFile(port: number | string): string {
	return path.join(agentDir(), "web-launch", `${port}.token`);
}

export function launchTokenSocketPath(port: number | string): string { return launchTokenIpcPath(agentDir(), String(port)); }

function publishLocalRefreshServer(key: string, port: string): void {
	const endpoint = launchTokenSocketPath(port);
	if (ipcServers.has(endpoint)) return;
	const server = net.createServer((socket) => {
		socket.setTimeout(2_000, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		let input = "";
		let handshake: { token: string; clientNonce: string; serverNonce: string } | undefined;
		let handled = false;
		socket.on("data", (chunk) => {
			if (handled) return;
			input += chunk.toString("utf8");
			if (Buffer.byteLength(input, "utf8") > 1_024) { socket.destroy(); return; }
			while (input.includes("\n") && !handled) try {
				const boundary = input.indexOf("\n");
				const request = JSON.parse(input.slice(0, boundary)) as { clientNonce?: unknown; proof?: unknown };
				input = input.slice(boundary + 1);
				let current = tokens.get(key);
				if (!handshake) {
					if (!current || typeof request.clientNonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(request.clientNonce)) { handled = true; socket.destroy(); return; }
					handshake = { token: current.token, clientNonce: request.clientNonce, serverNonce: randomBytes(32).toString("base64url") };
					socket.write(`${JSON.stringify({ serverNonce: handshake.serverNonce, proof: launchIpcProof(handshake.token, "server", handshake.clientNonce, handshake.serverNonce) })}\n`);
					continue;
				}
				handled = true;
				if (!current || !validLaunchToken(handshake.token, current.token) || !validLaunchIpcProof(request.proof, handshake.token, "client", handshake.clientNonce, handshake.serverNonce)) {
					socket.end(`${JSON.stringify({ error: "invalid_token" })}\n`); return;
				}
				const revocations = loadSessionRevocations();
				if (revocations.unavailable) { socket.end(`${JSON.stringify({ error: "unavailable" })}\n`); return; }
				if (Date.now() >= current.expiresAt || revocations.notBefore > current.cutoff) {
					current = { token: randomBytes(32).toString("base64url"), expiresAt: Date.now() + LAUNCH_TOKEN_TTL_MS, cutoff: revocations.notBefore };
					tokens.set(key, current);
					publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: current.token, PIWEB_PORT: port });
				}
				// Even a relayed authenticated exchange discloses no token: the launcher
				// must read the renewed value from its private file after this proof.
				socket.end(`${JSON.stringify({ proof: launchIpcProof(handshake.token, "ready", handshake.clientNonce, handshake.serverNonce) })}\n`);
			} catch { handled = true; socket.destroy(); }
		});
	});
	ipcServers.set(endpoint, server);
	const ready = () => {
		server.unref();
		if (process.platform !== "win32") { try { fs.chmodSync(endpoint, 0o600); } catch { /* private directory also protects the socket */ } }
	};
	let recovering = false;
	server.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EADDRINUSE" && process.platform !== "win32" && !recovering) {
			recovering = true;
			void recoverStaleSocket(endpoint).then((recovered) => {
				if (recovered && ipcServers.get(endpoint) === server) server.listen(endpoint, ready);
				else if (ipcServers.get(endpoint) === server) ipcServers.delete(endpoint);
			});
		} else if (ipcServers.get(endpoint) === server) ipcServers.delete(endpoint);
	});
	server.listen(endpoint, ready);
}

async function recoverStaleSocket(endpoint: string): Promise<boolean> {
	try {
		const before = fs.lstatSync(endpoint);
		if (!before.isSocket() || before.uid !== process.getuid?.()) return false;
		const dead = await new Promise<boolean>((resolve) => {
			const probe = net.connect(endpoint);
			probe.setTimeout(500, () => { probe.destroy(); resolve(false); });
			probe.once("connect", () => { probe.destroy(); resolve(false); });
			probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"));
		});
		if (!dead) return false;
		const after = fs.lstatSync(endpoint);
		if (!after.isSocket() || before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid) return false;
		fs.unlinkSync(endpoint); // Only this user's generated socket, proven not to have a live listener.
		return true;
	} catch { return false; }
}

/** Publish a complete private token file. Exiting processes never unlink it:
 * another process may have replaced the path after a token/identity check.
 * A stopped server cannot authorize the stale file, and the next start replaces it.
 */
export function publishLaunchToken(env: Record<string, string | undefined> = process.env): void {
	const token = env.PI_WEB_LAUNCH_TOKEN;
	const port = env.PIWEB_PORT;
	if (!token || !port) return;
	const key = `${agentDir()}:${port}`;
	if (!tokens.has(key)) tokens.set(key, { token, expiresAt: Date.now() + LAUNCH_TOKEN_TTL_MS, cutoff: loadSessionRevocations().notBefore });
	if (!launchGlobal.__piwebLaunchRotation) {
		launchGlobal.__piwebLaunchRotation = setInterval(() => {
			for (const [stateKey, current] of tokens) {
				if (Date.now() < current.expiresAt) continue;
				const tokenFile = stateKey.slice(stateKey.lastIndexOf(":") + 1);
				if (!/^\d+$/.test(tokenFile)) continue;
				const fresh = { token: randomBytes(32).toString("base64url"), expiresAt: Date.now() + LAUNCH_TOKEN_TTL_MS, cutoff: current.cutoff };
				tokens.set(stateKey, fresh); publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: fresh.token, PIWEB_PORT: tokenFile });
			}
		}, 30_000);
		launchGlobal.__piwebLaunchRotation.unref?.();
	}
	const file = launchTokenFile(port);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		const handle = fs.openSync(temporary, "wx", 0o600);
		try { fs.writeFileSync(handle, `${token}\n`); fs.fsyncSync(handle); }
		finally { fs.closeSync(handle); }
		fs.renameSync(temporary, file);
	} catch {
		return; // 只是便利功能：写不进去就退回旧行为（打开裸地址）
	}
	publishLocalRefreshServer(key, port);
}
