/**
 * 「远程连接」内置插件的控制面。它管两个监听：
 *
 *   1. 局域网入口 —— 手机排版注入代理，绑 0.0.0.0。默认就该有，手机连同一个 WiFi 就能用。
 *   2. 公网入口 —— cloudflared 快速隧道，指向局域网入口。由设置页的按钮开关。
 *
 * 引擎（隧道实现）刻意做成可替换的：`startPublic` 只依赖「起一个进程 + 从输出里抓到
 * https 地址」这两件事，换 ngrok / frp 时改这一个函数即可。
 *
 * 状态挂 globalThis：Next 的热重载会重新求值模块，不能把监听弄丢或重复起。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { authEnabled } from "../web-auth";
import { agentDir } from "../web-secret";
import { createMobileProxy, MOBILE_FIT_CSS, MOBILE_FIT_JS } from "./mobile-proxy";
import { probeTunnel } from "./tunnel-health";

export const PLUGIN_ID = "builtin-remote";
export const DEFAULT_LAN_PORT = 30142;
/** cloudflared 快速隧道给的地址长这样 */
const PUBLIC_URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;
const TUNNEL_TIMEOUT_MS = 45_000;
/** 拿到地址后等它就绪的上限：快速隧道的域名要十几秒才在全球 DNS 生效 */
const TUNNEL_READY_TIMEOUT_MS = 60_000;
const TUNNEL_READY_POLL_MS = 2_500;
const TUNNEL_HEALTH_INTERVAL_MS = 5_000;

/**
 * 从 cloudflared 的输出里抓公网地址，**只认第一个**。
 *
 * 为什么必须只认第一个：隧道域名是绑在隧道上的，一次运行期内不该变。
 * cloudflared 在重连等情况下的输出里可能再出现一个地址，若跟着换，
 * 用户手里那条链接会当场失效，旧域名还会留在 Host 白名单里没人摘。
 */
export function createUrlCatcher(pattern: RegExp = PUBLIC_URL_PATTERN) {
	let captured: string | null = null;
	let buffer = "";
	return {
		/** 返回新捕获到的地址；已经捕获过、或这次还没匹配到，都返回 null */
		feed(chunk: string): string | null {
			if (captured) return null;
			// 累积再匹配：子进程的 chunk 边界不保证落在行边界上，
			// 逐块匹配会把一个被切断的地址整条漏掉。
			buffer += chunk;
			const match = pattern.exec(buffer);
			if (!match) {
				// 只留尾巴，够覆盖一个被切断的地址即可，避免缓冲无限增长
				if (buffer.length > 4096) buffer = buffer.slice(-4096);
				return null;
			}
			captured = match[0];
			buffer = "";
			return captured;
		},
		get url(): string | null {
			return captured;
		},
	};
}

/** 状态页持续探测；同一次探测复用，避免多个页面同时打开时重复请求公网。 */
export async function refreshPublicStatus(force = false): Promise<void> {
	const current = state();
	const tunnel = current.tunnel;
	if (!tunnel?.url) return;
	if (tunnel.checking) return tunnel.checking;
	if (!force && tunnel.checkedAt !== undefined && Date.now() - tunnel.checkedAt < TUNNEL_HEALTH_INTERVAL_MS) return;
	const controller = tunnel.controller ??= new AbortController();
	const checking = probeTunnel(tunnel.url, controller.signal).then((health) => {
		if (current.tunnel !== tunnel || controller.signal.aborted) return;
		tunnel.ready = health.ready;
		tunnel.checkedAt = Date.now();
		current.publicError = health.error;
	}).finally(() => { if (tunnel.checking === checking) tunnel.checking = undefined; });
	tunnel.checking = checking;
	return checking;
}

/** 启动时等一次；超时后由状态页继续检测，网络恢复时不必重启或换地址。 */
async function waitForTunnelReady(tunnel: ManagedTunnel): Promise<void> {
	const deadline = Date.now() + TUNNEL_READY_TIMEOUT_MS;
	for (;;) {
		if (state().tunnel !== tunnel) return;
		await refreshPublicStatus(true);
		if (state().tunnel !== tunnel || tunnel.ready || Date.now() >= deadline) return;
		await delay(TUNNEL_READY_POLL_MS, undefined, { signal: tunnel.controller?.signal }).catch(() => {});
	}
}

export type TunnelEngine = "cloudflared";

export interface LanState {
	running: boolean;
	port: number | null;
	urls: string[];
	/** 这一个监听是否在注入手机排版。插件关掉时为 false（纯转发），端口与可达性不变 */
	styled: boolean;
	error: string | null;
}

export interface PublicState {
	running: boolean;
	url: string | null;
	/** 地址已可访问。快速隧道拿到地址后还要十几秒域名才在全球 DNS 生效 */
	ready: boolean;
	engine: TunnelEngine | null;
	/** 引擎二进制是否可用；不可用时 UI 应给出安装提示而不是「启动失败」 */
	engineAvailable: boolean;
	error: string | null;
}

/** 不允许开入口的原因：没开认证 / 开发模式（Next 开发工具端点不能暴露出去） */
export type RemoteBlocked = "auth" | "dev";

export interface RemoteStatus {
	plugin: typeof PLUGIN_ID;
	/** 内置插件是否启用。关掉后局域网入口仍在（纯转发），但没有手机排版与公网入口 */
	pluginEnabled: boolean;
	/** PiWeb 自己的端口（局域网入口的转发目标） */
	targetPort: number;
	/** 非空时两个入口都不许开，UI 应置灰按钮并说明原因 */
	blocked: RemoteBlocked | null;
	lan: LanState;
	public: PublicState;
}

interface ManagedTunnel {
	child: ChildProcess;
	url: string | null;
	ready: boolean;
	/** 可选以兼容 Next 热重载之前创建的状态。 */
	controller?: AbortController;
	checkedAt?: number;
	checking?: Promise<void>;
}

interface SupervisorState {
	lan: { server: http.Server; port: number; styled: boolean } | null;
	tunnel: ManagedTunnel | null;
	generation?: number;
	/** 正在启动中的那一次：并发调用复用它，不能起两个监听 / 两个 cloudflared */
	lanStarting?: Promise<LanState> | null;
	publicStarting?: Promise<PublicState> | null;
	lanError: string | null;
	publicError: string | null;
	enginePath: string | null;
	engineChecked: boolean;
}

/**
 * 入口能不能开。两个入口都会把 PiWeb 交给本机以外的设备，所以：
 *  - 没开认证绝不能开（直接 `next start`、或显式 PI_WEB_AUTH=0 时，开出去就是一个免密 shell）；
 *  - 开发模式不能开（认证保护不了 Next 开发工具端点，启动器也拒绝非本机开发模式）。
 */
export function remoteBlocked(env: Record<string, string | undefined> = process.env): RemoteBlocked | null {
	if (!authEnabled(env)) return "auth";
	if (env.NODE_ENV === "development") return "dev";
	return null;
}

const STATE_KEY = "piweb:remote-supervisor";

/**
 * 把隧道域名并进 Host 白名单。
 *
 * 必须是动态的：快速隧道的域名每次启动都变，没法在启动前写进环境变量。
 * isSafeHost 每次请求现读 process.env，所以同进程内改了立刻生效，不用重启。
 */
export function allowTunnelHost(url: string): void {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return;
	}
	const current = (process.env.PI_WEB_TRUSTED_HOSTS ?? "")
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);
	if (!current.includes(hostname)) current.push(hostname);
	process.env.PI_WEB_TRUSTED_HOSTS = current.join(",");
}

/** 隧道停了就把域名从白名单摘掉：不要给一个已经没人管的域名留后门 */
export function disallowTunnelHost(url: string | null): void {
	if (!url) return;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return;
	}
	const remaining = (process.env.PI_WEB_TRUSTED_HOSTS ?? "")
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter((part) => part && part !== hostname);
	process.env.PI_WEB_TRUSTED_HOSTS = remaining.join(",");
}

function state(): SupervisorState {
	const store = globalThis as Record<PropertyKey, unknown>;
	const key = Symbol.for(STATE_KEY);
	const existing = store[key] as SupervisorState | undefined;
	if (existing) return existing;
	const created: SupervisorState = { lan: null, tunnel: null, lanError: null, publicError: null, enginePath: null, engineChecked: false };
	store[key] = created;
	return created;
}

/** PiWeb 自己的监听端口：启动器显式给的优先 */
export function piwebPort(env: Record<string, string | undefined> = process.env): number {
	for (const raw of [env.PIWEB_PORT, env.PORT]) {
		const value = Number(raw);
		if (Number.isInteger(value) && value >= 1 && value <= 65535) return value;
	}
	return 30141;
}

function isOff(value: string | undefined): boolean {
	const flag = (value ?? "").trim().toLowerCase();
	return flag === "0" || flag === "false" || flag === "off" || flag === "no";
}

/**
 * 局域网入口是否随服务启动。默认开 —— 「不开启也默认局域网可用」就是这个开关。
 * 设 PIWEB_REMOTE_LAN=0 关掉。
 */
export function remoteLanEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return !isOff(env.PIWEB_REMOTE_LAN);
}

export function remoteLanPort(env: Record<string, string | undefined> = process.env): number {
	const value = Number(env.PIWEB_REMOTE_LAN_PORT);
	return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : DEFAULT_LAN_PORT;
}

/** 虚拟机、WSL、容器的虚拟网卡：地址也是私网段，但同一 WiFi 的手机连不到，排到最后 */
const VIRTUAL_ADAPTER = /vmware|virtualbox|vboxnet|vethernet|hyper-v|wsl|docker|^br-|^veth/i;

/**
 * 所有非回环 IPv4 —— 手机该用哪个地址，UI 直接列出来，真实网卡排在前面。
 * 198.18.0.0/15 是测试保留段，Clash / Mihomo 等代理的 TUN 网卡用它，手机永远连不上，直接不列。
 */
export function lanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
	const real: string[] = [];
	const virtual: string[] = [];
	for (const [name, entries] of Object.entries(interfaces)) {
		for (const entry of entries ?? []) {
			if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
			if (/^198\.1[89]\./.test(entry.address)) continue;
			(VIRTUAL_ADAPTER.test(name) ? virtual : real).push(entry.address);
		}
	}
	return [...real, ...virtual];
}

export function remoteStatus(): RemoteStatus {
	const current = state();
	const lanPort = current.lan?.port ?? null;
	return {
		plugin: PLUGIN_ID,
		pluginEnabled: remotePluginEnabled(),
		targetPort: piwebPort(),
		blocked: remoteBlocked(),
		lan: {
			running: Boolean(current.lan),
			port: lanPort,
			urls: lanPort ? lanAddresses().map((address) => `http://${address}:${lanPort}`) : [],
			styled: Boolean(current.lan?.styled),
			error: current.lanError,
		},
		public: {
			running: Boolean(current.tunnel),
			url: current.tunnel?.url ?? null,
			ready: Boolean(current.tunnel?.ready),
			engine: current.tunnel ? "cloudflared" : null,
			engineAvailable: current.engineChecked ? current.enginePath !== null : true,
			error: current.publicError,
		},
	};
}

/** PiWeb 自己管的引擎位置（与 web-secret 同一批状态文件放在 agent 目录下） */
export function managedEnginePath(): string {
	return path.join(agentDir(), "web-bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

/**
 * 引擎查找顺序：
 *   1. PIWEB_CLOUDFLARED（显式指定绝对路径）
 *   2. PiWeb 自己管的位置（「一键安装」就放这儿）
 *   3. PATH 上的 cloudflared
 * 都没找到时返回 PATH 上的名字，让 spawn 报 ENOENT —— startPublic 会翻译成安装提示。
 */
function resolveTunnelEngine(): string {
	const explicit = process.env.PIWEB_CLOUDFLARED?.trim();
	if (explicit) return explicit;
	const managed = managedEnginePath();
	try {
		if (fs.existsSync(managed)) return managed;
	} catch {
		/* 读不了就当没有 */
	}
	return "cloudflared";
}

/** 探测隧道引擎是否可用（结果缓存） */
export function tunnelEngine(): string | null {
	const current = state();
	if (current.engineChecked) return current.enginePath;
	current.engineChecked = true;
	current.enginePath = resolveTunnelEngine();
	return current.enginePath;
}

export function markEngineMissing(): void {
	const current = state();
	current.engineChecked = true;
	current.enginePath = null;
}

/**
 * 内置插件是否启用。关闭后**局域网入口照旧可用**，只是不再注入手机排版、也不提供公网隧道——
 * 这样用户可以用自己写的插件或自建反代接手远程访问，而手机在同一个 WiFi 下仍然连得上。
 *
 * 存 `<agentDir>/remote-plugin.json`，与 web-secret 同一目录。读不到就按启用处理（默认开）。
 */
function pluginFile(): string {
	return path.join(agentDir(), "remote-plugin.json");
}

export function remotePluginEnabled(): boolean {
	try {
		const raw = JSON.parse(fs.readFileSync(pluginFile(), "utf8")) as { enabled?: unknown };
		return raw?.enabled !== false;
	} catch {
		// 没写过、或文件坏了：按默认（启用）处理，不让一次读盘失败把功能关掉
		return true;
	}
}

export function setRemotePluginEnabled(enabled: boolean): void {
	const file = pluginFile();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
	} catch (error) {
		throw new Error(`无法保存远程连接插件开关：${error instanceof Error ? error.message : error}`);
	}
}

/**
 * 起局域网入口；已经在跑（或正在起）就复用。targetPort 默认转发回 PiWeb 自己，测试可改成别的上游。
 *
 * 插件启用时是「手机排版注入代理」；关闭时同一个端口退化成**纯转发**（不注入任何东西），
 * 这样自建反代指向 30142 的部署不会因为关掉插件而失效——用户要的是「插件可关、局域网照旧」。
 */
export function startLan(port = remoteLanPort(), host = "0.0.0.0", targetPort = piwebPort()): Promise<LanState> {
	const current = state();
	if (current.lan) return Promise.resolve(remoteStatus().lan);
	if (current.lanStarting) return current.lanStarting;
	const starting = listenLan(port, host, targetPort).finally(() => {
		if (current.lanStarting === starting) current.lanStarting = null;
	});
	current.lanStarting = starting;
	return starting;
}

async function listenLan(port: number, host: string, targetPort: number): Promise<LanState> {
	const current = state();
	current.lanError = null;
	const styled = remotePluginEnabled();
	const server = createMobileProxy({
		targetPort,
		// 关掉插件就不注入：仍是同一个端口、同一套转发，只是页面上不再有手机排版补丁
		css: styled ? MOBILE_FIT_CSS : null,
		js: styled ? MOBILE_FIT_JS : null,
		log: (message) => console.warn(message),
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, host, resolve);
		});
	} catch (error) {
		current.lanError = error instanceof Error ? error.message : String(error);
		server.close();
		return remoteStatus().lan;
	}
	current.lan = { server, port, styled };
	return remoteStatus().lan;
}

export async function stopLan(): Promise<void> {
	const current = state();
	const lan = current.lan;
	current.lan = null;
	if (!lan) return;
	lan.server.closeAllConnections?.();
	await new Promise<void>((resolve) => lan.server.close(() => resolve()));
}

/**
 * 起公网隧道；已在跑（或正在起）就复用。
 * 「正在起」必须算进来：起局域网入口、等 cloudflared 吐地址都要 await，连点两下若各自 spawn，
 * 先起的那个会变成没人管的孤儿进程，它的域名还留在 Host 白名单里。
 */
export function startPublic(): Promise<PublicState> {
	const current = state();
	if (current.publicStarting) return current.publicStarting;
	if (current.tunnel) return Promise.resolve(remoteStatus().public);
	const starting = spawnTunnel().finally(() => {
		if (current.publicStarting === starting) current.publicStarting = null;
	});
	current.publicStarting = starting;
	return starting;
}

/** 把一条隧道彻底收掉：摘白名单、清状态、杀进程（只动传进来的这一条） */
function dropTunnel(child: ChildProcess): void {
	const current = state();
	const active = current.tunnel;
	if (active?.child === child) {
		active.controller?.abort();
		disallowTunnelHost(active.url);
		current.tunnel = null;
	}
	if (child.exitCode === null && !child.killed) child.kill();
}

async function spawnTunnel(): Promise<PublicState> {
	const current = state();
	const generation = current.generation;
	current.publicError = null;

	// 公网入口转发到局域网入口，所以局域网入口必须在跑
	if (!current.lan) await startLan();
	if (current.generation !== generation) return remoteStatus().public;
	const lan = remoteStatus().lan;
	if (!lan.running || lan.port === null) {
		current.publicError = lan.error ?? "局域网入口没能启动，公网入口无从转发";
		return remoteStatus().public;
	}

	const binary = tunnelEngine();
	if (!binary) {
		current.publicError = "找不到 cloudflared";
		return remoteStatus().public;
	}

	const child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${lan.port}`], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const tunnel: ManagedTunnel = { child, url: null, ready: false, controller: new AbortController() };
	current.tunnel = tunnel;

	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			tunnel.controller?.signal.removeEventListener("abort", canceled);
			resolve();
		};
		const canceled = () => finish();
		tunnel.controller!.signal.addEventListener("abort", canceled, { once: true });
		const timer = setTimeout(() => {
			// 不收掉的话进程还活着、状态一直是「运行中」却永远没有地址
			current.publicError = "启动隧道超时：cloudflared 没有在 45 秒内给出地址";
			dropTunnel(child);
			finish();
		}, TUNNEL_TIMEOUT_MS);
		const catcher = createUrlCatcher();
		const scan = (chunk: Buffer) => {
			const url = catcher.feed(chunk.toString("utf8"));
			if (!url || current.tunnel !== tunnel) return;
			tunnel.url = url;
			// 域名必须先放行再算启动成功，否则第一次访问必然被 Host 校验挡成 403
			allowTunnelHost(url);
			// 抓到就够了，摘掉监听：既避免后续输出改动已生效的地址，也不白占着流
			child.stdout?.off("data", scan);
			child.stderr?.off("data", scan);
			finish();
		};
		child.stdout?.on("data", scan);
		child.stderr?.on("data", scan);
		child.once("error", (error: NodeJS.ErrnoException) => {
			// spawn 失败时不一定还有 exit 事件：这里不清状态，界面会永远显示「运行中」
			if (current.tunnel !== tunnel) { finish(); return; }
			if (error.code === "ENOENT") {
				markEngineMissing();
				current.publicError = "找不到 cloudflared：请先安装它（https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/）";
			} else {
				current.publicError = error.message;
			}
			dropTunnel(child);
			finish();
		});
		child.once("exit", (code) => {
			const active = current.tunnel;
			if (active?.child === child) {
				current.publicError = `cloudflared 退出了（code ${code ?? "?"}）。请重新开启远程连接，并使用新地址。`;
				dropTunnel(child);
				finish();
			} else {
				finish();
			}
		});
	});

	// 地址拿到了，但快速隧道的域名还要十几秒才在全球 DNS 生效。
	// 不等它就直接报「就绪」，用户一复制地址打开就是打不开 —— 那才是真的像坏了。
	if (current.tunnel === tunnel && tunnel.url) await waitForTunnelReady(tunnel);
	return remoteStatus().public;
}

export async function stopPublic(): Promise<void> {
	const current = state();
	current.generation = (current.generation ?? 0) + 1;
	const starting = current.publicStarting;
	const tunnel = current.tunnel;
	current.tunnel = null;
	current.publicError = null;
	if (!tunnel) { await starting; return; }
	tunnel.controller?.abort();
	// 先摘域名再杀进程：别给一个已经没人管的域名留后门
	disallowTunnelHost(tunnel.url);
	await new Promise<void>((resolve) => {
		tunnel.child.once("exit", () => resolve());
		tunnel.child.kill();
		// 进程已经死了或杀不掉时不要卡住调用方
		setTimeout(resolve, 3_000).unref();
	});
	await starting;
}

export async function stopAll(): Promise<void> {
	await stopPublic();
	await stopLan();
}

/** 仅供测试 */
export function resetRemoteSupervisor(): void {
	const store = globalThis as Record<PropertyKey, unknown>;
	store[Symbol.for(STATE_KEY)] = {
		lan: null, tunnel: null, lanError: null, publicError: null, enginePath: null, engineChecked: false,
	} satisfies SupervisorState;
}
