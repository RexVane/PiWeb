import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireFileLock } from "./file-lock.mjs";
import { terminateProcessTree } from "./process-runner.mjs";
import { assertInstallation, selectProductionBuild } from "./build-output.mjs";
import { ensureInstallBuild, isProductionOnlyInstall } from "./install-build.mjs";
import { readSystemProxy } from "./system-proxy.mjs";
import { launchTokenIpcPath, launchIpcProof, validLaunchIpcProof } from "./web-auth-protocol.mjs";
import { lockChildEnvironment } from "./lock-child-env.mjs";
import { readHttpProxySetting } from "./update-environment.mjs";
export { readHttpProxySetting } from "./update-environment.mjs";
export { isMainModule } from "./entrypoint.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {Record<string, string | undefined>} Environment */
/** @typedef {{port: number, hostname: string, publicUrl: string | null, noOpen: boolean, isDev: boolean, help: boolean}} ParsedOptions */
/** @typedef {import('node:events').EventEmitter & {kill(signal?: NodeJS.Signals | number): boolean}} LauncherChild */
/**
 * @typedef {Object} LauncherOptions
 * @property {string[]} [args]
 * @property {Environment} [env]
 * @property {string} [root]
 * @property {{log?: (message: string) => void, probePort?: typeof probePort,
 * isPiWebRunning?: typeof isPiWebRunning, openBrowser?: (url: string) => Promise<void>,
 * warmFirstPaint?: typeof warmFirstPaint, readCurrentLaunchToken?: typeof readCurrentLaunchToken,
 * readHttpProxySetting?: typeof readHttpProxySetting, readSystemProxy?: typeof readSystemProxy, warn?: (message: string) => void,
 * spawn?: (command: string, args: string[], options: import('node:child_process').SpawnOptions) => LauncherChild}} [dependencies]
 */

export function isLoopback(hostname) {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost") return true;
	if (net.isIP(host) === 4) return host.startsWith("127.");
	return net.isIP(host) === 6 && new URL(`http://[${host}]`).hostname === "[::1]";
}

function normalizeHostname(value) {
	if (typeof value !== "string" || !value) throw new Error("无效监听地址");
	const host = value.toLowerCase().replace(/^\[([^\]]+)\]$/, "$1");
	if (net.isIP(host)) return host;
	if (host.length > 253 || !host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
		throw new Error(`无效监听地址：${value}`);
	}
	return host;
}

/**
 * 对外地址（反代/隧道给用户看的那个 URL）。只用于拼登录链接和补 Host 白名单。
 * 去掉查询串与结尾斜杠，拼接时统一补。
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function normalizePublicUrl(value) {
	if (value === null || value === undefined) return null;
	const trimmed = String(value).trim();
	if (!trimmed) return null;
	let url;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`无效的对外地址：${value}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`对外地址必须是 http/https：${value}`);
	if (url.username || url.password) throw new Error(`对外地址不能带凭据：${value}`);
	url.search = "";
	url.hash = "";
	return url.href.replace(/\/+$/, "");
}

/** 把令牌拼成可直接打开的登录链接 */
export function tokenLoginUrl(base, token) {
	return `${String(base).replace(/\/+$/, "")}/?token=${encodeURIComponent(token)}`;
}

/** agent 目录：`PI_CODING_AGENT_DIR`（支持 `~`），否则 `~/.pi/agent`；规则与 src/lib/web-secret.ts 一致 */
function agentDirOf(env) {
	const raw = env.PI_CODING_AGENT_DIR;
	const home = os.homedir();
	return !raw ? path.join(home, ".pi", "agent")
		: raw === "~" ? home
		: raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(home, raw.slice(2))
		: raw;
}

/**
 * 读某个端口上正在运行的实例留下的启动令牌（服务端 publishLaunchToken 写的，
 * 位置是 `<agentDir>/web-launch/<端口>.token`）。
 * 没有、读不了、内容不像令牌都返回 null —— 调用方退回打开裸地址。
 * @param {number} port
 * @param {Environment} [env]
 * @returns {string | null}
 */
export function readLaunchToken(port, env = process.env) {
	try {
		const token = fs.readFileSync(path.join(agentDirOf(env), "web-launch", `${port}.token`), "utf8").trim();
		return /^[A-Za-z0-9_-]{16,}$/.test(token) ? token : null;
	} catch {
		return null;
	}
}

/**
 * Confirm or renew a local launch credential through the private IPC endpoint.
 * @param {number} port
 * @param {Environment} [env]
 * @returns {Promise<string | null>}
 */
export async function readCurrentLaunchToken(port, env = process.env, { timeoutMs = 2000 } = {}) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const token = readLaunchToken(port, env);
		if (!token) return null;
		const result = await new Promise((resolve) => {
			const socket = net.connect(launchTokenIpcPath(agentDirOf(env), String(port)));
			const clientNonce = randomBytes(32).toString("base64url");
			let serverNonce;
			let response = "";
			let finished = false;
			const finish = (value) => { if (!finished) { finished = true; clearTimeout(timer); socket.destroy(); resolve(value); } };
			const timer = setTimeout(() => finish({ error: "unavailable" }), timeoutMs);
			socket.once("connect", () => socket.write(`${JSON.stringify({ clientNonce })}\n`));
			socket.on("data", (chunk) => {
				response += chunk.toString("utf8");
				if (Buffer.byteLength(response, "utf8") > 1024) { finish({ error: "unavailable" }); return; }
				while (response.includes("\n") && !finished) try {
					const boundary = response.indexOf("\n");
					const message = JSON.parse(response.slice(0, boundary));
					response = response.slice(boundary + 1);
					if (!serverNonce) {
						if (typeof message.serverNonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(message.serverNonce)
							|| !validLaunchIpcProof(message.proof, token, "server", clientNonce, message.serverNonce)) { finish({ error: "invalid_token" }); return; }
						serverNonce = message.serverNonce;
						socket.write(`${JSON.stringify({ proof: launchIpcProof(token, "client", clientNonce, serverNonce) })}\n`);
					} else {
						finish(validLaunchIpcProof(message.proof, token, "ready", clientNonce, serverNonce) ? { ready: true } : { error: "invalid_token" });
					}
				} catch { finish({ error: "unavailable" }); }
			});
			socket.once("error", () => finish({ error: "unavailable" }));
			socket.once("close", () => finish({ error: "unavailable" }));
		});
		if (result?.ready) return readLaunchToken(port, env);
		if (result?.error !== "invalid_token") return null;
	}
	return null;
}

/**
 * pi 的 `httpProxy` 设置（agent 目录的 settings.json）。读不到、写坏了、没设都返回 null。
 * 按标准 JSON 读：这份文件由 pi 和 PiWeb 的设置面板写，两边写出来的都是标准 JSON。
 * @param {Environment} [env]
 * @returns {string | null}
 */
/** Node 自带的环境变量代理（NODE_USE_ENV_PROXY）：24.0 起支持，22.x 从 22.21 起 */
export function nodeSupportsEnvProxy(version = process.versions.node) {
	const [major, minor] = String(version).split(".").map(Number);
	return major >= 24 || (major === 22 && minor >= 21);
}

/** 日志里的代理地址：去掉账号密码 */
function redactProxy(proxy) {
	try {
		const url = new URL(proxy);
		if (url.username || url.password) {
			url.username = "";
			url.password = "";
			return `${url.href.replace(/\/$/, "")}（已隐去账号）`;
		}
		return url.href.replace(/\/$/, "");
	} catch {
		return "（格式无法解析）";
	}
}

/**
 * 给服务进程配代理环境。pi 的 CLI 入口会做这两件事，而 PiWeb 走的是 SDK，得自己做，
 * 否则在 pi 终端里配好的代理到了网页端对模型请求完全不生效：
 *  1. 手动 `httpProxy` 优先，其次代理环境变量，再跟随 Windows 系统代理；
 *  2. 让 Node 的 fetch / http 认这些变量（NODE_USE_ENV_PROXY）——默认它们是被忽略的。
 * 本机地址默认不走代理（本地 llama.cpp / Ollama），用户自己设了 NO_PROXY 就照他的。
 * @param {Environment} childEnv 就地修改
 * @param {{proxySetting?: string | null, systemProxy?: import('./system-proxy.mjs').SystemProxy | null, nodeVersion?: string}} [options]
 * @returns {{proxy: string | null, source: 'env' | 'settings' | 'system' | null, supported: boolean}}
 */
export function applyProxyEnv(childEnv, { proxySetting = null, systemProxy = null, nodeVersion = process.versions.node } = {}) {
	// Windows 上环境变量不分大小写，但展开成普通对象后分：两种写法都要查，免得补出一个只差大小写的重复键
	const current = (name) => String(childEnv[name] ?? childEnv[name.toLowerCase()] ?? "").trim();
	const fromEnv = current("HTTPS_PROXY") || current("HTTP_PROXY");
	const set = (name, value) => {
		if (childEnv[name.toLowerCase()] !== undefined) childEnv[name.toLowerCase()] = value;
		if (childEnv[name] !== undefined || childEnv[name.toLowerCase()] === undefined) childEnv[name] = value;
	};
	if (proxySetting) {
		set("HTTP_PROXY", proxySetting);
		set("HTTPS_PROXY", proxySetting);
	} else if (!fromEnv && systemProxy) {
		if (systemProxy.http) set("HTTP_PROXY", systemProxy.http);
		if (systemProxy.https) set("HTTPS_PROXY", systemProxy.https);
	}
	const proxy = proxySetting || fromEnv || systemProxy?.https || systemProxy?.http || null;
	if (!proxy) return { proxy: null, source: null, supported: true };
	const source = proxySetting ? "settings" : fromEnv ? "env" : "system";
	const supported = nodeSupportsEnvProxy(nodeVersion);
	if (supported) {
		// 用户自己表过态（哪怕是 0）就尊重
		if (!String(childEnv.NODE_USE_ENV_PROXY ?? "").trim()) childEnv.NODE_USE_ENV_PROXY = "1";
		if (childEnv.NO_PROXY === undefined && childEnv.no_proxy === undefined) {
			childEnv.NO_PROXY = source === "system" && systemProxy?.noProxy === "*" ? "*"
				: ["localhost,127.0.0.1,::1", source === "system" ? systemProxy?.noProxy : null].filter(Boolean).join(",");
		}
	}
	return { proxy, source, supported };
}

function mergeHostnames(current, hostname) {
	const list = (current ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
	if (hostname && !list.includes(hostname)) list.push(hostname);
	return list.join(",");
}

function authenticationEnabled(value) {
	return String(value ?? "1").trim() !== "0";
}

/** @param {string[]} [args] @param {Environment} [env] @returns {ParsedOptions} */
export function parseLauncherArgs(args = [], env = process.env) {
	let port = Number(env.PORT || 30141);
	let hostname = env.PI_WEB_HOSTNAME || "127.0.0.1";
	let publicUrl = env.PI_WEB_PUBLIC_URL ?? null;
	let noOpen = env.PI_WEB_NO_OPEN === "1";
	let isDev = env.PI_WEB_DEV === "1";
	let help = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-p" || arg === "--port") port = Number(args[++i]);
		else if (arg.startsWith("--port=")) port = Number(arg.slice(7));
		else if (arg === "-H" || arg === "--hostname") hostname = args[++i];
		else if (arg.startsWith("--hostname=")) hostname = arg.slice(11);
		else if (arg === "--public-url") publicUrl = args[++i];
		else if (arg.startsWith("--public-url=")) publicUrl = arg.slice(13);
		else if (arg === "--no-open") noOpen = true;
		else if (arg === "--dev") isDev = true;
		else if (arg === "-h" || arg === "--help") help = true;
		else throw new Error(`未知参数：${arg}`);
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`无效端口：${port}`);
	return { port, hostname: normalizeHostname(hostname), publicUrl: normalizePublicUrl(publicUrl), noOpen, isDev, help };
}

/**
 * @param {string} root
 * @param {ParsedOptions} options
 * @param {Environment} [env]
 * @returns {{root: string, command: 'dev' | 'start', env: Environment}}
 */
export function createLaunchPlan(root, options, env = process.env) {
	// 拒绝启动而不是静默忽略：设了 PI_WEB_PASSWORD 的部署本来是有认证的，
	// 悄悄放过就会让它在没有任何登录要求的情况下继续对外服务。
	if (env.PI_WEB_PASSWORD) {
		throw new Error("PI_WEB_PASSWORD 已被移除：密码登录不再存在，认证现在只用启动令牌（PI_WEB_AUTH=1，启动器默认已开）。请删掉这个环境变量再重试。");
	}
	const loopback = isLoopback(options.hostname);
	if (!loopback && options.isDev) {
		throw new Error("拒绝非本机开发模式：启动令牌认证保护不了 Next 开发工具端点。请绑定 127.0.0.1，或先运行 npm run build:release 后用生产模式启动。");
	}
	const publicUrl = options.publicUrl ?? null;
	if (String(env.PI_WEB_AUTH ?? "").trim() === "0" && (!loopback || publicUrl)) {
		throw new Error("对外连接必须启用认证：请移除 PI_WEB_AUTH=0，或仅绑定本机地址且不配置公开地址。");
	}
	const installation = assertInstallation(root);
	const build = options.isDev ? null : selectProductionBuild(installation, env.PIWEB_BUILD_DIR);
	if (!build && !loopback) {
		throw new Error("找不到可用生产构建，拒绝对外自动回退到开发模式。请先运行 npm run build:release，再以相同启动参数重试。");
	}
	const command = options.isDev || !build ? "dev" : "start";
	const childEnv = {
		...env,
		PI_WEB_ROOT: installation,
		PYTHONUTF8: env.PYTHONUTF8 ?? "1",
		PYTHONIOENCODING: env.PYTHONIOENCODING ?? "utf-8",
	};
	// 每次启动换一个启动令牌；调用方已经给出就沿用（便于测试与外部编排）。
	if (!childEnv.PI_WEB_LAUNCH_TOKEN) childEnv.PI_WEB_LAUNCH_TOKEN = randomBytes(32).toString("base64url");
	// 每种启动方式都默认启用认证，并由下面的登录链接自动进入；不再需要手动常设环境变量。
	// 显式关闭仍留给已有部署，远程入口会继续拒绝无认证运行。
	if (!String(childEnv.PI_WEB_AUTH ?? "").trim()) childEnv.PI_WEB_AUTH = "1";
	// 反代会把外部主机名原样转给后端，不进白名单会被判 untrusted host。
	if (publicUrl) childEnv.PI_WEB_TRUSTED_HOSTS = mergeHostnames(childEnv.PI_WEB_TRUSTED_HOSTS, new URL(publicUrl).hostname.toLowerCase());
	if (command === "start") childEnv.PIWEB_BUILD_DIR = build.buildDir;
	else {
		delete childEnv.PIWEB_BUILD_DIR;
		childEnv.PIWEB_DEV_ASSET_ID = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
		childEnv.NODE_OPTIONS = [env.NODE_OPTIONS, "--max-old-space-size=3072"].filter(Boolean).join(" ");
	}
	return { root: installation, command, env: childEnv };
}

export function localUrl(hostname, port) {
	const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname === "::" ? "::1" : hostname;
	return `http://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

/**
 * Never send credentials to a port occupant, even if it forges PiWeb JSON/401.
 * @param {string} base
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<boolean>}
 */
export async function isPiWebRunning(base, { fetchImpl = fetch, timeoutMs = 1500, signal } = {}) {
	try {
		const url = new URL("/api/health", base);
		if (url.username || url.password || url.protocol !== "http:") return false;
		const timeout = AbortSignal.timeout(timeoutMs);
		const response = await fetchImpl(url, {
			credentials: "omit",
			redirect: "error",
			headers: { accept: "application/json" },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (response.status !== 200 || !response.body) return false;
		const reader = response.body.getReader();
		let text = "";
		let bytes = 0;
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > 4096) return false;
				text += decoder.decode(chunk.value, { stream: true });
			}
			text += decoder.decode();
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		const body = JSON.parse(text);
		return body?.success === true && body?.data?.ok === true && body?.data?.service === "piweb";
	} catch {
		return false;
	}
}

/** 预热要打的四个首屏路由（会话列表 / 工作区 / 模型目录 / pi 设置） */
export const FIRST_PAINT_ROUTES = ["/api/sessions", "/api/workspaces", "/api/models", "/api/pi-settings"];

/** @param {number} ms @param {AbortSignal} [signal] */
function delay(ms, signal) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}

/**
 * 先准备首屏会话列表，避免首次索引与模型目录等初始化争用同一进程。
 * 身份确认与 Cookie 交换后，启动器只等一次有超时的列表预热尝试；版本、
 * 工作区、模型与设置随后并发准备，不延长就绪等待。预热失败不阻止启动。
 *
 * @param {string} base
 * @param {{fetchImpl?: typeof fetch, token?: string, timeoutMs?: number, waitMs?: number,
 * pollMs?: number, check?: typeof isPiWebRunning, signal?: AbortSignal}} [options]
 * @returns {Promise<boolean>} 是否成功读完首个会话列表响应
 */
export async function warmFirstPaint(base, { fetchImpl = fetch, token, timeoutMs = 20_000, waitMs = 60_000, pollMs = 100, check = isPiWebRunning, signal } = {}) {
	const timeoutFor = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
	// 身份确认不带凭据（与 isPiWebRunning 的既有约定一致）：端口可能被别的进程抢走。
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (signal?.aborted) return false;
		if (await check(base, { fetchImpl, timeoutMs: Math.min(1500, timeoutMs), signal })) break;
		if (Date.now() >= deadline) return false;
		await delay(pollMs, signal);
	}
	// 令牌只认根路径的 GET：先换到 Cookie，后面几条路由才有资格预热。
	let cookie;
	if (token) {
		try {
			const response = await fetchImpl(new URL(tokenLoginUrl("/", token), base), { credentials: "omit", redirect: "manual", signal: timeoutFor() });
			const match = /^([^;]+)/.exec(response.headers.get("set-cookie") ?? "");
			if (match) cookie = match[1];
			await response.arrayBuffer().catch(() => undefined);
		} catch {
			/* 换不到就退化成只预热公开路由 */
		}
	}
	const headers = {};
	if (cookie) headers.cookie = cookie;
	const headerInit = Object.keys(headers).length > 0 ? headers : undefined;
	const get = async (route) => {
		if (signal?.aborted) return false;
		try {
			const response = await fetchImpl(new URL(route, base), { credentials: "omit", redirect: "error", headers: headerInit, signal: timeoutFor() });
			// 只需让服务端把这条路由跑完；响应体要么丢弃，要么读干净以释放连接。
			await response.arrayBuffer();
			return response.ok;
		} catch {
			/* 预热失败不影响启动 */
			return false;
		}
	};
	const sessionsReady = await get("/api/sessions");
	if (signal?.aborted) return false;
	for (const route of ["/api/version", ...FIRST_PAINT_ROUTES.filter((route) => route !== "/api/sessions")]) void get(route);
	return sessionsReady;
}

/** @param {number} port @param {string} hostname @returns {Promise<'busy' | 'free' | NodeJS.ErrnoException>} */
export function probePort(port, hostname) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", (error) => resolve(error.code === "EADDRINUSE" ? "busy" : error));
		server.once("listening", () => server.close(() => resolve("free")));
		server.listen({ port, host: hostname, exclusive: true });
	});
}

export function browserLaunchSpec(url, platform = process.platform) {
	if (platform === "win32") {
		// The URL is data in the child environment, never command text interpreted
		// by cmd or PowerShell. Ampersands/quotes cannot create another command.
		return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:PIWEB_BROWSER_URL"], env: { ...process.env, PIWEB_BROWSER_URL: url } };
	}
	return { command: platform === "darwin" ? "open" : "xdg-open", args: [url], env: process.env };
}
async function openBrowser(url) {
	const { command, args, env } = browserLaunchSpec(url);
	const child = spawn(command, args, { env, detached: true, stdio: "ignore", windowsHide: true });
	child.once("error", () => {});
	child.unref();
}

/**
 * Import-safe entrypoint; injectable I/O keeps launcher tests off real services.
 * @param {LauncherOptions} [options]
 * @returns {Promise<number>}
 */
async function runLauncherInner({ args = process.argv.slice(2), env = process.env, root = DEFAULT_ROOT, dependencies = {} } = {}, instanceLock) {
	const options = parseLauncherArgs(args, env);
	const log = dependencies.log ?? console.log;
	if (options.help) {
		log("Usage: pi web [-p, --port <port>] [-H, --hostname <host>] [--public-url <url>] [--dev] [--no-open]");
		log("默认绑定 127.0.0.1:30141；端口被占自动 +1。开发模式仅允许本机监听。");
		log("非本机监听、或配了 --public-url，都会自动启用启动令牌认证（PI_WEB_AUTH=1）。");
		log("对外监听必须使用生产构建。构建/恢复发布：npm run build:release。");
		return 0;
	}
	// A finished build is selected, fully verified and consumed by the plan in one
	// synchronous call. Do not first verify it in ensureInstallBuild and then hash
	// the same files again here. No validation result survives this invocation.
	let plan;
	try { plan = createLaunchPlan(root, options, env); }
	catch (error) {
		if (options.isDev) throw error;
		// An incomplete production-only installation may still be repaired below.
	}
	// Keep first-install preparation and repair before probing/reusing a service.
	// A checkout without a production build retains its local development fallback.
	if (!plan || (!options.isDev && plan.command !== "start")) {
		const prepared = ensureInstallBuild(root, { log, warn: dependencies.warn ?? console.warn });
		if (prepared === "failed" && isProductionOnlyInstall(root)) {
			// 常见根因：包目录属主不是当前用户（sudo 安装残留），构建产物写不进去
			let owner = "";
			try {
				const stat = fs.statSync(root);
				if (typeof stat.uid === "number" && stat.uid !== process.getuid?.()) {
					owner = `\n此安装目录属主不是当前用户（uid ${stat.uid}）——之前可能用 sudo 安装过。修复：sudo chown -R $(whoami) "${root}"，然后重试 piweb。`;
				}
			} catch { /* diagnostics only */ }
			throw new Error(`无法准备生产构建，且该安装没有开发依赖。请用 \`npm rebuild -g @rexvane/piweb\` 重试，或改用仓库中的 npm run dev。${owner}`);
		}
		plan = createLaunchPlan(root, options, env);
	}
	const checkPort = dependencies.probePort ?? probePort;
	const checkHealth = dependencies.isPiWebRunning ?? isPiWebRunning;
	const browse = dependencies.openBrowser ?? openBrowser;
	const start = dependencies.spawn ?? spawn;
	let port = options.port;
	for (let attempts = 0; ; attempts += 1) {
		const state = await checkPort(port, options.hostname);
		if (state === "free") break;
		if (state !== "busy") throw new Error(`无法监听 ${options.hostname}:${port}：${state.code ?? state.message ?? state}`);
		const url = localUrl(options.hostname, port);
		if (await checkHealth(url)) {
			log(`[piweb] 检测到已有 PiWeb：${url}（未发送凭据）`);
			if (!options.noOpen) {
				// 那个实例开了认证的话，裸地址只会落到登录页，而这里手里没有它的令牌；
				// 它启动时留下过令牌就直接开登录链接（浏览器里已有 Cookie 时令牌也无害）
				const token = await (dependencies.readCurrentLaunchToken ?? readCurrentLaunchToken)(port, env);
				await browse(token ? tokenLoginUrl(url, token) : url);
			}
			return 0;
		}
		if (attempts >= 50 || port >= 65535) throw new Error(`连续 ${attempts + 1} 个端口都被占用，请用 -p 指定端口`);
		log(`[piweb] 端口 ${port} 被占用，尝试 ${port + 1}`);
		port += 1;
	}
	const url = localUrl(options.hostname, port);
	// 内置插件要转发回 PiWeb 自己的端口；端口可能被占而 +1，所以在这里给最终值。
	plan.env.PIWEB_PORT = String(port);
	plan.env.PORT = String(port);
	instanceLock?.updateMetadata({ port, hostname: options.hostname, root: plan.root });
	plan.env.PIWEB_HTTP_GUARD = "1";
	plan.env.NODE_OPTIONS = [plan.env.NODE_OPTIONS, `--import=${JSON.stringify(pathToFileURL(path.join(DEFAULT_ROOT, "scripts", "http-request-guard.mjs")).href)}`].filter(Boolean).join(" ");
	log(`[piweb] 启动 ${url} (${plan.command} 模式)`);
	const proxySetting = (dependencies.readHttpProxySetting ?? readHttpProxySetting)(env);
	const hasProxyEnv = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((key) => plan.env[key]?.trim());
	const systemProxy = !proxySetting && !hasProxyEnv ? (dependencies.readSystemProxy ?? readSystemProxy)() : null;
	plan.env.PIWEB_INHERITED_HTTP_PROXY = (env.http_proxy || env.HTTP_PROXY || "").trim();
	plan.env.PIWEB_INHERITED_HTTPS_PROXY = (env.https_proxy || env.HTTPS_PROXY || "").trim();
	const proxy = applyProxyEnv(plan.env, { proxySetting, systemProxy });
	plan.env.PIWEB_PROXY_SOURCE = proxy.source ?? "none";
	if (proxy.proxy) {
		const from = proxy.source === "settings" ? "手动设置" : proxy.source === "system" ? "系统代理" : "环境变量";
		if (proxy.supported) log(`[piweb] 模型请求走代理 ${redactProxy(proxy.proxy)}（来自${from}）`);
		else (dependencies.warn ?? console.warn)(`[piweb] 配了代理（来自${from}），但 Node ${process.versions.node} 不支持按环境变量走代理，模型请求仍是直连。请升级到 Node 24 或 22.21 以上。`);
	}
	const authOn = authenticationEnabled(plan.env.PI_WEB_AUTH);
	if (authOn) log("[piweb] 已启用启动令牌认证");
	if (!isLoopback(options.hostname)) {
		for (const addresses of Object.values(os.networkInterfaces())) {
			for (const address of addresses ?? []) {
				if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254.")) {
					log(`[piweb] 局域网/手机访问地址（需同一网络）：http://${address.address}:${port}`);
				}
			}
		}
	}
	// Only the browser receives a launch credential; redirected terminal logs do not.
	const loginBase = options.publicUrl ?? url;
	if (authOn) {
		if (options.publicUrl) log(`[piweb] 对外地址：${options.publicUrl}`);
		log("[piweb] 登录入口会自动在本机浏览器打开；需要重新登录时再次运行 piweb。");
	}
	const next = path.join(plan.root, "node_modules", "next", "dist", "bin", "next");
	/**
	 * 服务进程的工作目录**必须是项目根目录**，不能用 `next [directory]` 传参代替。
	 *
	 * 曾试过把工作目录移到安装目录之外、改由 `next [directory]` 传入项目目录，
	 * 目的是让 Windows 上 npm 能替换正在运行的包（进程 cwd 落在包目录内时改名为 EBUSY）。
	 * 这条路在 Next 16.4.0 上不成立，原因在 Next 内部：
	 *
	 *   1. `build/define-env.js` 把 `path.relative(process.cwd(), projectPath)` 作为
	 *      `__NEXT_RELATIVE_PROJECT_DIR` 烘焙进产物；
	 *   2. 处理请求时 `server/route-modules/route-module.js` 用
	 *      `join(process.cwd(), relativeProjectDir)` 还原项目目录。
	 *
	 * 于是 cwd 一旦不等于项目目录，还原结果就是错的：
	 *   - 生产构建烘焙的是空串（构建时 cwd 就是项目根），`join(cwd, "")` 直接等于 cwd；
	 *   - 跨盘符（cwd 在 C:、项目在 D:）时 `path.relative` 直接返回绝对路径，
	 *     `join(cwd, "D:\\...")` 拼成 `C:\\...\\run\\D:\\...\\PiWeb` 这种双份路径，
	 *     表现为 `ENOENT ... routes-manifest.json`。
	 *
	 * 所以 cwd 保持项目根；Windows 上「服务运行时就地自我更新」改为让用户先停服务再装
	 * （update-service 会据此退回复制命令，见 canSelfUpdateNpmInstall）。
	 */
	const child = start(process.execPath, [next, plan.command, ...(plan.command === "dev" ? ["--webpack"] : []), "-p", String(port), "-H", options.hostname], {
		cwd: plan.root, stdio: "inherit", env: instanceLock ? lockChildEnvironment(plan.env, instanceLock.file, instanceLock.token) : plan.env, windowsHide: true, detached: process.platform !== "win32",
	});
	if (child.pid) instanceLock?.childStarted(child.pid);
	const controller = new AbortController();
	let timer;
	// 首屏预热：开发模式每次请求都要现场编译，预热只会白占 CPU，因此只在生产模式下做。
	let warmPromise = null;
	if (plan.command !== "dev" && env.PIWEB_SKIP_WARMUP !== "1") {
		const warm = dependencies.warmFirstPaint ?? warmFirstPaint;
		warmPromise = Promise.resolve(warm(url, { token: authOn ? plan.env.PI_WEB_LAUNCH_TOKEN : undefined, signal: controller.signal })).then(() => true, () => false);
	}
	const ready = async (attempt = 0) => {
		if (controller.signal.aborted || attempt > 240) return;
		if (await checkHealth(url, { signal: controller.signal })) {
			if (controller.signal.aborted) return;
			if (warmPromise) {
				log("[piweb] 预热首屏…");
				await warmPromise;
				if (controller.signal.aborted) return;
			}
			log(`[piweb] 就绪：${url}`);
			// 开了认证就直接开登录链接：否则用户打开的是登录页，而他手里还没有会话 Cookie。
			if (!options.noOpen) {
				const latestToken = authOn ? await (dependencies.readCurrentLaunchToken ?? readCurrentLaunchToken)(port, env) : null;
				await browse(latestToken ? tokenLoginUrl(loginBase, latestToken) : url);
			}
		} else if (!controller.signal.aborted) {
			timer = setTimeout(() => void ready(attempt + 1), 250);
			timer.unref();
		}
	};
	return new Promise((resolve, reject) => {
		const interrupt = () => { void terminateProcessTree(child).catch((error) => { cleanup(); reject(error); }); };
		const terminate = interrupt;
		const cleanup = () => {
			controller.abort();
			clearTimeout(timer);
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
		};
		process.once("SIGINT", interrupt);
		process.once("SIGTERM", terminate);
		child.once("error", (error) => { cleanup(); reject(error); });
		child.once("exit", (code) => { cleanup(); resolve(code ?? 1); });
		void ready().catch(() => {});
	});
}

/** One launcher per agent directory, including the period before health is ready. */
export async function runLauncher(options = {}) {
	const env = options.env ?? process.env;
	const parsed = parseLauncherArgs(options.args ?? process.argv.slice(2), env);
	if (!parsed.help) {
		assertInstallation(options.root ?? DEFAULT_ROOT);
		if (env.PI_WEB_PASSWORD) throw new Error("PI_WEB_PASSWORD 已被移除，请删掉该环境变量后重试。");
		if (parsed.isDev && !isLoopback(parsed.hostname)) throw new Error("拒绝非本机开发模式，请使用生产构建。");
	}
	// Injected process I/O remains isolated in launcher unit tests.
	if (parsed.help || options.dependencies?.spawn) return runLauncherInner(options);
	const lockFile = path.join(agentDirOf(env), "web-launch", "instance.lock");
	let lock;
	try { lock = acquireFileLock(lockFile, { port: parsed.port, hostname: parsed.hostname, root: path.resolve(options.root ?? DEFAULT_ROOT) }); }
	catch (error) {
		const owner = error.owner;
		if (!owner || !Number.isInteger(owner.port)) throw error;
		if (owner.root && fs.realpathSync(owner.root) !== fs.realpathSync(options.root ?? DEFAULT_ROOT)) throw new Error("已有 PiWeb 实例来自另一安装目录；停止该实例后再启动当前版本。");
		const url = localUrl(owner.hostname || "127.0.0.1", owner.port);
		const log = options.dependencies?.log ?? console.log;
		log("[piweb] 已有实例正在启动，等待它就绪…");
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (await (options.dependencies?.isPiWebRunning ?? isPiWebRunning)(url)) {
				if (!parsed.noOpen) {
					const token = await (options.dependencies?.readCurrentLaunchToken ?? readCurrentLaunchToken)(owner.port, env);
					await (options.dependencies?.openBrowser ?? openBrowser)(token ? tokenLoginUrl(url, token) : url);
				}
				return 0;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error("已有 PiWeb 实例仍在启动或没有响应；请等待或停止该实例后重试。");
	}
	try { return await runLauncherInner(options, lock); }
	finally { lock(); }
}
