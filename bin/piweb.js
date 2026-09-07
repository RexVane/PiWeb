#!/usr/bin/env node
/**
 * Pi Web 启动器：解析参数 → 端口被占自动 +1 → 起 Next.js → 探活后自动打开浏览器。
 */
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
let port = Number(process.env.PORT || 30141);
let hostname = process.env.PI_WEB_HOSTNAME || "127.0.0.1";
let noOpen = process.env.PI_WEB_NO_OPEN === "1";

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "-p" || a === "--port") port = Number(args[++i]);
	else if (a === "-H" || a === "--hostname") hostname = args[++i];
	else if (a === "--no-open") noOpen = true;
	else if (a === "-h" || a === "--help") {
		console.log(`Usage: piweb [-p, --port <port>] [-H, --hostname <host>] [--no-open]`);
		console.log(`  -p, --port <port>      监听端口（默认 30141，env PORT；被占用自动 +1）`);
		console.log(`  -H, --hostname <host>  绑定地址（默认 127.0.0.1，env PI_WEB_HOSTNAME）`);
		console.log(`  --no-open              不自动打开浏览器（env PI_WEB_NO_OPEN=1）`);
		console.log(`  -h, --help             帮助`);
		console.log(`环境变量 PI_WEB_PASSWORD 启用 Basic Auth（用户名 pi）`);
		process.exit(0);
	}
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
	console.error(`[piweb] 无效端口：${String(port)}`);
	process.exit(1);
}
if (!hostname || /[\s/]/.test(hostname)) {
	console.error(`[piweb] 无效监听地址：${hostname || "(empty)"}`);
	process.exit(1);
}

function isLoopback(host) {
	const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
	return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

const pw = process.env.PI_WEB_PASSWORD;
if (!isLoopback(hostname) && !pw) {
	console.error("[piweb] 拒绝无密码的非本机监听。请设置 PI_WEB_PASSWORD，或绑定 127.0.0.1。");
	process.exit(1);
}

function isPortFree(p, host) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once("error", () => resolve(false));
		srv.once("listening", () => srv.close(() => resolve(true)));
		srv.listen(p, host === "0.0.0.0" || host === "::" ? undefined : host);
	});
}

for (;;) {
	if (await isPortFree(port, hostname)) break;
	console.log(`[piweb] 端口 ${port} 被占用，尝试 ${port + 1}`);
	port += 1;
}

if (pw) console.log(`[piweb] 已启用 Basic Auth（用户名 pi）`);

const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
console.log(`[piweb] 启动 http://${hostname}:${port}`);
const child = spawn(process.execPath, [next, "start", "-p", String(port), "-H", hostname], {
	cwd: root,
	stdio: "inherit",
	env: process.env,
});

const url = `http://${hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname}:${port}`;
async function probe(attempt = 0) {
	if (attempt > 120) return;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(1200) });
		if (res.ok || res.status === 401 || res.status === 307 || res.status === 308) {
			console.log(`[piweb] 就绪：${url}`);
			if (!noOpen) {
				const { default: open } = await import("open").catch(() => ({ default: null }));
				if (open) await open(url).catch(() => {});
				else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true });
				else if (process.platform === "darwin") spawn("open", [url], { detached: true });
				else spawn("xdg-open", [url], { detached: true });
			}
			return;
		}
	} catch {
		/* not ready */
	}
	setTimeout(() => probe(attempt + 1), 500);
}
probe();

child.on("exit", (code) => process.exit(code ?? 0));
