/**
 * 无头浏览器管理（pi 的眼睛）：整个 PiWeb 进程共用一个浏览器（懒启动），每个 pi 会话一个标签页。
 * 临时 profile（不碰用户真实浏览器的 Cookie / 历史）；没有标签页 10 分钟后关闭；进程退出时清理。
 * 每个标签页记录控制台 error/warning、页面异常、请求失败与 ≥400 响应，供 pi 发现运行时问题。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpConnection, pipeTransport } from "./cdp";
import { elementAtPointScript, sanitizePickedElement, type ElementBox, type PickedElementInfo } from "./inspect";
import { locateBrowser } from "./locate";

const IDLE_MS = 10 * 60 * 1000;
const CONSOLE_CAP = 200;
const NAV_TIMEOUT_MS = 15_000;
/** 导航 / 点击 / 输入之后给页面的渲染与 HMR 留一点时间再截图 */
const SETTLE_MS = 500;
/** 整页截图的最大高度（超长页面只截前面这一段） */
const MAX_FULL_PAGE_HEIGHT = 6000;
/** 元素裁剪图的最长边：够模型看清，又不撑大消息 */
const MAX_REGION_EDGE = 640;

export const DEVICES = {
	desktop: { width: 1280, height: 800, mobile: false },
	tablet: { width: 768, height: 1024, mobile: true },
	mobile: { width: 390, height: 844, mobile: true },
} as const;
export type Device = keyof typeof DEVICES;

export interface ConsoleEntry {
	level: "error" | "warning";
	source: "console" | "exception" | "network" | "log";
	text: string;
	/** 出处：脚本位置或请求地址 */
	url?: string;
	ts: number;
}

export interface PageInfo {
	url: string;
	title: string;
}

export class BrowserUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrowserUnavailableError";
	}
}

interface RunningBrowser {
	child: ChildProcess;
	cdp: CdpConnection;
	profileDir: string;
	executable: string;
	product: string;
	/** 浏览器进程退出、临时 profile 删掉之后才 resolve */
	gone: Promise<void>;
}

interface Registry {
	browser: Promise<RunningBrowser> | null;
	tabs: Map<string, Promise<BrowserTab>>;
	idleTimer?: ReturnType<typeof setTimeout>;
	exitHooked?: boolean;
	live?: RunningBrowser;
}

const globalForBrowser = globalThis as typeof globalThis & { __piWebBrowser?: Registry };
const registry: Registry = (globalForBrowser.__piWebBrowser ??= { browser: null, tabs: new Map() });

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 进程退出时：同步、尽力而为 */
function removeProfileSync(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		/* Windows 上浏览器刚退出时文件可能还被占用：临时目录残留不影响功能 */
	}
}

/** 运行期间：浏览器的辅助进程比主进程晚退出、还占着文件，退避重试（最多约 4 秒） */
async function removeProfile(dir: string): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			await rm(dir, { recursive: true, force: true });
			return;
		} catch {
			await delay(250 * 2 ** attempt);
		}
	}
}

function launchArgs(profileDir: string): string[] {
	const args = [
		"--headless=new",
		"--remote-debugging-pipe",
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-breakpad",
		"--disable-crash-reporter",
		"--disable-background-networking",
		"--disable-sync",
		"--disable-component-update",
		"--disable-default-apps",
		"--mute-audio",
		"--hide-scrollbars",
		"--window-size=1280,800",
		"about:blank",
	];
	// 以 root 运行（容器里常见）时 Chromium 拒绝启用沙箱
	if (process.platform === "linux" && process.getuid?.() === 0) args.unshift("--no-sandbox");
	return args;
}

function hookExit(): void {
	if (registry.exitHooked) return;
	registry.exitHooked = true;
	process.once("exit", () => {
		const live = registry.live;
		if (!live) return;
		live.child.kill();
		removeProfileSync(live.profileDir);
	});
}

async function launch(): Promise<RunningBrowser> {
	const executable = locateBrowser();
	if (!executable) {
		throw new BrowserUnavailableError("no Chrome / Edge / Chromium found; install one or set PI_WEB_BROWSER to its executable");
	}
	const profileDir = mkdtempSync(path.join(os.tmpdir(), "piweb-browser-"));
	const child = spawn(executable, launchArgs(profileDir), { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString("utf8")).slice(-4000);
	});
	const cdp = new CdpConnection(pipeTransport(child.stdio[3] as Writable, child.stdio[4] as Readable));
	const spawnFailed = new Promise<never>((_, reject) => child.once("error", (error) => reject(error)));
	const gone = new Promise<void>((resolve) => {
		child.once("exit", () => {
			cdp.close();
			if (registry.live?.child === child) {
				registry.live = undefined;
				registry.browser = null;
				registry.tabs.clear();
			}
			void removeProfile(profileDir).then(resolve);
		});
	});
	try {
		const version = await Promise.race([cdp.send<{ product: string }>("Browser.getVersion", {}, undefined, 20_000), spawnFailed]);
		const running: RunningBrowser = { child, cdp, profileDir, executable, product: version.product, gone };
		registry.live = running;
		hookExit();
		return running;
	} catch (error) {
		child.kill();
		const detail = stderr.trim().split("\n").slice(-3).join(" | ");
		throw new BrowserUnavailableError(`failed to start ${executable}: ${error instanceof Error ? error.message : String(error)}${detail ? ` (${detail})` : ""}`);
	}
}

function getBrowser(): Promise<RunningBrowser> {
	if (!registry.browser) {
		const starting = launch();
		registry.browser = starting;
		starting.catch(() => {
			if (registry.browser === starting) registry.browser = null;
		});
	}
	return registry.browser;
}

function cancelIdle(): void {
	if (registry.idleTimer) clearTimeout(registry.idleTimer);
	registry.idleTimer = undefined;
}

function scheduleIdle(): void {
	cancelIdle();
	if (registry.tabs.size > 0 || !registry.browser) return;
	registry.idleTimer = setTimeout(() => void shutdownBrowser(), IDLE_MS);
	registry.idleTimer.unref?.();
}

/** 本机有没有可用的浏览器（只查可执行文件，不启动） */
export function browserAvailable(): boolean {
	return locateBrowser() !== null;
}

/** 某个会话的标签页：没有就开一个（必要时先启动浏览器） */
export async function getBrowserTab(key: string): Promise<BrowserTab> {
	cancelIdle();
	const existing = registry.tabs.get(key);
	if (existing) {
		const tab = await existing.catch(() => null);
		if (tab && !tab.closed) return tab;
		if (registry.tabs.get(key) === existing) registry.tabs.delete(key);
	}
	const creating = (async () => {
		const browser = await getBrowser();
		const { targetId } = await browser.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await browser.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
		const tab = new BrowserTab(browser.cdp, targetId, sessionId);
		await tab.init();
		return tab;
	})();
	registry.tabs.set(key, creating);
	creating.catch(() => {
		if (registry.tabs.get(key) === creating) registry.tabs.delete(key);
		scheduleIdle();
	});
	return creating;
}

/** 已打开的标签页（不创建） */
export async function peekBrowserTab(key: string): Promise<BrowserTab | null> {
	const tab = await registry.tabs.get(key)?.catch(() => null);
	return tab && !tab.closed ? tab : null;
}

export async function closeBrowserTab(key: string): Promise<void> {
	const existing = registry.tabs.get(key);
	if (!existing) return;
	registry.tabs.delete(key);
	const tab = await existing.catch(() => null);
	await tab?.close();
	scheduleIdle();
}

export async function shutdownBrowser(): Promise<void> {
	cancelIdle();
	const starting = registry.browser;
	registry.browser = null;
	registry.tabs.clear();
	const browser = await starting?.catch(() => null);
	if (!browser) return;
	await browser.cdp.send("Browser.close", {}, undefined, 5000).catch(() => undefined);
	// 正常关闭等它自己退出；超时再强杀。返回时进程已退出、临时 profile 已删
	const exited = await Promise.race([browser.gone.then(() => true), delay(5000).then(() => false)]);
	if (!exited) {
		browser.child.kill();
		await browser.gone;
	}
}

/** 截图结果：base64 JPEG 与图像尺寸（CSS 像素） */
export interface Screenshot {
	data: string;
	width: number;
	height: number;
}

export class BrowserTab {
	readonly console: ConsoleEntry[] = [];
	device: Device = "desktop";
	closed = false;
	/** 最近一次打开 / 刷新页面的时间：控制台摘要只算这之后的 */
	loadedAt = 0;
	/** 打开过真实页面（不再是 about:blank） */
	hasPage = false;
	private readonly unsubscribe: Array<() => void> = [];
	/** requestId → url：请求失败事件里只有 id */
	private readonly requests = new Map<string, string>();

	constructor(private readonly cdp: CdpConnection, readonly targetId: string, readonly sessionId: string) {}

	private send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		if (this.closed) return Promise.reject(new Error("browser tab is closed"));
		return this.cdp.send<T>(method, params, this.sessionId, timeoutMs);
	}

	private listen(method: string, handler: (params: any) => void): void {
		this.unsubscribe.push(this.cdp.on(method, (params, sessionId) => {
			if (sessionId === this.sessionId) handler(params);
		}));
	}

	private record(entry: Omit<ConsoleEntry, "ts">): void {
		this.console.push({ ...entry, text: entry.text.slice(0, 2000), ts: Date.now() });
		if (this.console.length > CONSOLE_CAP) this.console.shift();
	}

	async init(): Promise<void> {
		this.listen("Runtime.consoleAPICalled", (p) => {
			if (p.type !== "error" && p.type !== "warning" && p.type !== "assert") return;
			const text = (p.args ?? []).map((arg: { value?: unknown; description?: string; unserializableValue?: string }) =>
				arg.value !== undefined ? (typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value)) : arg.description ?? arg.unserializableValue ?? "").join(" ");
			const frame = p.stackTrace?.callFrames?.[0];
			this.record({ level: p.type === "warning" ? "warning" : "error", source: "console", text, url: frame?.url ? `${frame.url}:${frame.lineNumber + 1}` : undefined });
		});
		this.listen("Runtime.exceptionThrown", (p) => {
			const d = p.exceptionDetails ?? {};
			this.record({ level: "error", source: "exception", text: d.exception?.description ?? d.text ?? "uncaught exception", url: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : undefined });
		});
		this.listen("Log.entryAdded", (p) => {
			const entry = p.entry ?? {};
			if (entry.level !== "error" && entry.level !== "warning") return;
			this.record({ level: entry.level, source: "log", text: entry.text ?? "", url: entry.url });
		});
		this.listen("Network.requestWillBeSent", (p) => {
			this.requests.set(p.requestId, p.request?.url ?? "");
			if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value as string);
		});
		this.listen("Network.loadingFailed", (p) => {
			if (p.canceled) return;
			const url = this.requests.get(p.requestId) ?? "";
			this.record({ level: "error", source: "network", text: `request failed: ${p.errorText ?? "unknown error"}`, url });
		});
		this.listen("Network.responseReceived", (p) => {
			const status = p.response?.status ?? 0;
			const url: string = p.response?.url ?? "";
			if (status < 400 || /\/favicon\.ico(\?|$)/.test(url)) return;
			this.record({ level: "error", source: "network", text: `HTTP ${status}`, url });
		});
		this.unsubscribe.push(this.cdp.on("Target.detachedFromTarget", (p) => {
			if (p.sessionId === this.sessionId) this.closed = true;
		}));
		this.unsubscribe.push(this.cdp.onClose(() => {
			this.closed = true;
		}));
		await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].map((method) => this.send(method)));
		await this.setDevice("desktop");
	}

	/** 等一个本标签页的事件；超时返回 false 而不是报错（长轮询页面可能永远等不到 load） */
	private waitFor(method: string, timeoutMs: number): { promise: Promise<boolean>; cancel: () => void } {
		let off = () => {};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const promise = new Promise<boolean>((resolve) => {
			off = this.cdp.on(method, (_params, sessionId) => {
				if (sessionId !== this.sessionId) return;
				off();
				if (timer) clearTimeout(timer);
				resolve(true);
			});
			timer = setTimeout(() => {
				off();
				resolve(false);
			}, timeoutMs);
		});
		return { promise, cancel: () => { off(); if (timer) clearTimeout(timer); } };
	}

	async navigate(url: string): Promise<PageInfo> {
		const loaded = this.waitFor("Page.loadEventFired", NAV_TIMEOUT_MS);
		const result = await this.send<{ errorText?: string; loaderId?: string }>("Page.navigate", { url }, NAV_TIMEOUT_MS + 5000).catch((error) => {
			loaded.cancel();
			throw error;
		});
		if (result.errorText) {
			loaded.cancel();
			throw new Error(`cannot open ${url}: ${result.errorText}${/CONNECTION_REFUSED/.test(result.errorText) ? " (is the dev server running?)" : ""}`);
		}
		// 同文档导航（只改 hash）没有 loaderId，也不会有 load 事件
		this.loadedAt = Date.now();
		this.hasPage = true;
		if (result.loaderId) await loaded.promise;
		else loaded.cancel();
		await delay(SETTLE_MS);
		return this.info();
	}

	async reload(): Promise<PageInfo> {
		const loaded = this.waitFor("Page.loadEventFired", NAV_TIMEOUT_MS);
		this.loadedAt = Date.now();
		await this.send("Page.reload", {});
		await loaded.promise;
		await delay(SETTLE_MS);
		return this.info();
	}

	async info(): Promise<PageInfo> {
		return this.evaluate<PageInfo>("({ url: location.href, title: document.title })");
	}

	async evaluate<T>(expression: string): Promise<T> {
		const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
			"Runtime.evaluate",
			{ expression, returnByValue: true, awaitPromise: true },
		);
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed");
		return r.result?.value as T;
	}

	/** 元素在文档中的位置（滚到视野中间后取），以及视口坐标里的中心点（点击用） */
	private async boxOf(selector: string): Promise<{ x: number; y: number; width: number; height: number; cx: number; cy: number }> {
		const box = await this.evaluate<{ x: number; y: number; width: number; height: number; cx: number; cy: number } | null>(`(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return null;
			el.scrollIntoView({ block: "center", inline: "center" });
			const r = el.getBoundingClientRect();
			return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
		})()`);
		if (!box) throw new Error(`no element matches ${selector}`);
		return box;
	}

	/** 视口里某一点的元素与源码线索（截图上点选元素）；那里没有元素返回 null */
	async elementAt(x: number, y: number): Promise<PickedElementInfo | null> {
		return sanitizePickedElement(await this.evaluate<unknown>(elementAtPointScript(x, y)));
	}

	/**
	 * region：元素的视口包围盒 + 当时的滚动位置。只截视口里可见的那部分（元素可能比视口还大），
	 * 长边超过 MAX_REGION_EDGE 时按比例缩小。
	 */
	async screenshot(opts: { fullPage?: boolean; selector?: string; region?: { box: ElementBox; scroll: { x: number; y: number } }; quality?: number } = {}): Promise<Screenshot> {
		let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
		if (opts.region) {
			const view = DEVICES[this.device];
			const { box, scroll } = opts.region;
			const pad = 6;
			const left = Math.max(0, box.x - pad);
			const top = Math.max(0, box.y - pad);
			const width = Math.min(view.width, box.x + box.width + pad) - left;
			const height = Math.min(view.height, box.y + box.height + pad) - top;
			if (!(width >= 1 && height >= 1)) throw new Error("the element is not visible in the viewport");
			const scale = Math.min(1, MAX_REGION_EDGE / Math.max(width, height));
			clip = { x: left + scroll.x, y: top + scroll.y, width, height, scale };
		} else if (opts.selector) {
			const box = await this.boxOf(opts.selector);
			const pad = 8;
			clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.max(1, box.width + pad * 2), height: Math.max(1, box.height + pad * 2), scale: 1 };
		} else if (opts.fullPage) {
			const metrics = await this.send<{ cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number } }>("Page.getLayoutMetrics");
			const size = metrics.cssContentSize ?? metrics.contentSize;
			clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(Math.min(size.height, MAX_FULL_PAGE_HEIGHT)), scale: 1 };
		}
		const r = await this.send<{ data: string }>("Page.captureScreenshot", {
			format: "jpeg",
			quality: opts.quality ?? 70,
			...(clip ? { clip, captureBeyondViewport: true } : {}),
		});
		const view = DEVICES[this.device];
		if (!clip) return { data: r.data, width: view.width, height: view.height };
		return { data: r.data, width: Math.round(clip.width * clip.scale), height: Math.round(clip.height * clip.scale) };
	}

	async click(target: { selector?: string; x?: number; y?: number }): Promise<void> {
		let x: number;
		let y: number;
		if (target.selector) {
			const box = await this.boxOf(target.selector);
			x = box.cx;
			y = box.cy;
		} else if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
			x = target.x!;
			y = target.y!;
		} else {
			throw new Error("click needs a selector or x/y coordinates");
		}
		for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
			await this.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
		}
		await delay(SETTLE_MS);
	}

	async type(selector: string, text: string, submit = false): Promise<void> {
		const found = await this.evaluate<boolean>(`(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return false;
			el.scrollIntoView({ block: "center" });
			el.focus();
			return document.activeElement === el;
		})()`);
		if (!found) throw new Error(`no focusable element matches ${selector}`);
		await this.send("Input.insertText", { text });
		if (submit) {
			const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
			await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
			await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
		}
		await delay(SETTLE_MS);
	}

	async setDevice(device: Device): Promise<void> {
		const d = DEVICES[device];
		await this.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: d.height, deviceScaleFactor: 1, mobile: d.mobile });
		this.device = device;
	}

	async close(): Promise<void> {
		// 断连 / 被分离时已标记关闭，但订阅仍要退掉
		const wasOpen = !this.closed;
		this.closed = true;
		for (const off of this.unsubscribe.splice(0)) off();
		if (wasOpen) await this.cdp.send("Target.closeTarget", { targetId: this.targetId }, undefined, 5000).catch(() => undefined);
	}
}
