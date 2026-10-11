import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertInstallation, selectProductionBuild } from "./build-output.mjs";
import { ensureInstallBuild, isProductionOnlyInstall } from "./install-build.mjs";
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
 * warmFirstPaint?: typeof warmFirstPaint,
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

function mergeHostnames(current, hostname) {
	const list = (current ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
	if (hostname && !list.includes(hostname)) list.push(hostname);
	return list.join(",");
}

function isTruthyFlag(value) {
	const flag = (value ?? "").trim().toLowerCase();
	return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
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
	const loopback = isLoopback(options.hostname);
	if (!loopback && options.isDev) {
		throw new Error("拒绝非本机开发模式：PI_WEB_PASSWORD 不能保护 Next 开发工具端点。请绑定 127.0.0.1，或先运行 npm run build:release 后用生产模式启动。");
	}
	const publicUrl = options.publicUrl ?? null;
	// 非本机监听能被局域网直连；配了对外地址说明前面有反代或隧道。两种都算暴露面，都必须有认证。
	const exposed = !loopback || Boolean(publicUrl);
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
	// 暴露面 + 没设密码 → 自动打开启动令牌认证，而不是拒绝启动。
	// 这样「对外可达却完全没有认证」这个组合不存在，用户也不必先想好密码。
	if (exposed && !childEnv.PI_WEB_PASSWORD && !isTruthyFlag(childEnv.PI_WEB_AUTH)) childEnv.PI_WEB_AUTH = "1";
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
 * 首屏预热：生产模式下，Next 服务器对**第一个动态 API 请求**要一次性付出 2.4~3.3 秒的
 * 模块加载成本（本机实测：`/api/version` 首次 2559~3566ms、第二次 4~10ms；页面路由与
 * `/api/health` 不吃这笔账）。浏览器首屏正好撞在这笔成本上，于是"页面出来了、列表还在转圈"。
 *
 * 这里在子进程刚起来时就后台打一次最便宜的路由吃掉它，再预热首屏真正要用的四个路由。
 * 只等端口起来 + 身份确认，绝不阻塞启动；失败一律静默（预热属于优化，不是启动的前置条件）。
 *
 * @param {string} base
 * @param {{fetchImpl?: typeof fetch, password?: string, token?: string, timeoutMs?: number, waitMs?: number,
 * pollMs?: number, check?: typeof isPiWebRunning, signal?: AbortSignal}} [options]
 * @returns {Promise<boolean>} 是否完成了管线预热
 */
export async function warmFirstPaint(base, { fetchImpl = fetch, password, token, timeoutMs = 20_000, waitMs = 60_000, pollMs = 100, check = isPiWebRunning, signal } = {}) {
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
	if (password) headers.authorization = `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
	if (cookie) headers.cookie = cookie;
	const headerInit = Object.keys(headers).length > 0 ? headers : undefined;
	const get = async (route) => {
		try {
			const response = await fetchImpl(new URL(route, base), { credentials: "omit", redirect: "error", headers: headerInit, signal: timeoutFor() });
			// 只需让服务端把这条路由跑完；响应体要么丢弃，要么读干净以释放连接。
			await response.arrayBuffer().catch(() => undefined);
		} catch {
			/* 预热失败不影响启动 */
		}
	};
	await get("/api/version");
	for (const route of FIRST_PAINT_ROUTES) void get(route);
	return true;
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

async function openBrowser(url) {
	const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
	const args = process.platform === "win32" ? ["/d", "/c", "start", "", url] : [url];
	const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
	child.once("error", () => {});
	child.unref();
}

/**
 * Import-safe entrypoint; injectable I/O keeps launcher tests off real services.
 * @param {LauncherOptions} [options]
 * @returns {Promise<number>}
 */
export async function runLauncher({ args = process.argv.slice(2), env = process.env, root = DEFAULT_ROOT, dependencies = {} } = {}) {
	const options = parseLauncherArgs(args, env);
	const log = dependencies.log ?? console.log;
	if (options.help) {
		log("Usage: pi web [-p, --port <port>] [-H, --hostname <host>] [--public-url <url>] [--dev] [--no-open]");
		log("默认绑定 127.0.0.1:30141；端口被占自动 +1。开发模式仅允许本机监听。");
		log("非本机监听、或配了 --public-url，都会自动启用启动令牌认证（PI_WEB_AUTH=1）。");
		log("对外监听必须使用生产构建。构建/恢复发布：npm run build:release。");
		return 0;
	}
	// Validate before probing/reusing: an existing server must not hide an unsafe request.
	// Production-only installs (`npm i -g piweb`) have no dev dependencies, so the
	// development fallback is unusable there: prepare the one-time build first.
	if (!options.isDev) {
		const prepared = ensureInstallBuild(root, { log, warn: dependencies.warn ?? console.warn });
		if (prepared === "failed" && isProductionOnlyInstall(root)) {
			// 常见根因：包目录属主不是当前用户（sudo 安装残留），构建产物写不进去
			let owner = "";
			try {
				const stat = await fs.stat(root);
				if (typeof stat.uid === "number" && stat.uid !== process.getuid?.()) {
					owner = `\n此安装目录属主不是当前用户（uid ${stat.uid}）——之前可能用 sudo 安装过。修复：sudo chown -R $(whoami) "${root}"，然后重试 piweb。`;
				}
			} catch { /* diagnostics only */ }
			throw new Error(`无法准备生产构建，且该安装没有开发依赖。请用 \`npm rebuild -g piweb\` 重试，或改用仓库中的 npm run dev。${owner}`);
		}
	}
	const plan = createLaunchPlan(root, options, env);
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
			if (!options.noOpen) await browse(url);
			return 0;
		}
		if (attempts >= 50 || port >= 65535) throw new Error(`连续 ${attempts + 1} 个端口都被占用，请用 -p 指定端口`);
		log(`[piweb] 端口 ${port} 被占用，尝试 ${port + 1}`);
		port += 1;
	}
	const url = localUrl(options.hostname, port);
	log(`[piweb] 启动 ${url} (${plan.command} 模式)`);
	const authOn = Boolean(plan.env.PI_WEB_PASSWORD) || plan.env.PI_WEB_AUTH === "1";
	if (plan.env.PI_WEB_PASSWORD) log(plan.command === "dev" ? "[piweb] 开发模式仅限本机；密码不保护 Next 开发工具端点。" : "[piweb] 已启用密码认证（浏览器登录页，API 兼容 Basic 用户名 pi）");
	else if (authOn) log("[piweb] 已启用启动令牌认证");
	if (!isLoopback(options.hostname)) {
		for (const addresses of Object.values(os.networkInterfaces())) {
			for (const address of addresses ?? []) {
				if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254.")) {
					log(`[piweb] 局域网/手机访问地址（需同一网络）：http://${address.address}:${port}`);
				}
			}
		}
	}
	// 令牌即凭据：只往终端打印，不写日志文件，也不要贴到聊天或截图里。
	const loginBase = options.publicUrl ?? url;
	const loginUrl = tokenLoginUrl(loginBase, plan.env.PI_WEB_LAUNCH_TOKEN);
	if (authOn) {
		if (options.publicUrl) log(`[piweb] 对外地址：${options.publicUrl}`);
		log(`[piweb] 登录链接（令牌即凭据，别外传；它会进浏览器历史）：${loginUrl}`);
	}
	const next = path.join(plan.root, "node_modules", "next", "dist", "bin", "next");
	const child = start(process.execPath, [next, plan.command, ...(plan.command === "dev" ? ["--webpack"] : []), "-p", String(port), "-H", options.hostname], {
		cwd: plan.root, stdio: "inherit", env: plan.env,
	});
	const controller = new AbortController();
	let timer;
	// 首屏预热：开发模式每次请求都要现场编译，预热只会白占 CPU，因此只在生产模式下做。
	let warmPromise = null;
	if (plan.command !== "dev" && env.PIWEB_SKIP_WARMUP !== "1") {
		const warm = dependencies.warmFirstPaint ?? warmFirstPaint;
		warmPromise = Promise.resolve(warm(url, { password: plan.env.PI_WEB_PASSWORD, token: authOn ? plan.env.PI_WEB_LAUNCH_TOKEN : undefined, signal: controller.signal })).then(() => true, () => false);
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
			// 开了认证就直接开登录链接：否则用户打开的是登录页，而他并不知道密码。
			if (!options.noOpen) await browse(authOn ? loginUrl : url);
		} else if (!controller.signal.aborted) {
			timer = setTimeout(() => void ready(attempt + 1), 250);
			timer.unref();
		}
	};
	return new Promise((resolve, reject) => {
		const interrupt = () => { child.kill("SIGINT"); };
		const terminate = () => { child.kill("SIGTERM"); };
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
