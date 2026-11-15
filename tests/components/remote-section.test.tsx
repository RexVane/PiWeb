// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RemoteSection } from "@/components/RemoteSection";

const qr = vi.hoisted(() => vi.fn(async (url: string) => `data:image/png;base64,${btoa(url)}`));
vi.mock("qrcode", () => ({ default: { toDataURL: qr } }));
const lanOrigin = "http://192.168.5.44:30142";
const publicOrigin = "https://abc-def.trycloudflare.com";
const initial = {
	plugin: "builtin-remote", pluginEnabled: true, targetPort: 30141, blocked: null as "auth" | "dev" | null,
	lan: { running: true, port: 30142, urls: [lanOrigin], styled: true, error: null as string | null },
	public: { running: true, url: publicOrigin, ready: true, engine: "cloudflared", engineAvailable: true, error: null as string | null },
};
let current: typeof initial;
let serial: number;
let expiresAt: number;
let consumed: boolean;
const code = () => String(serial).padStart(43, "a");
const writeText = vi.fn(async (_text: string) => {});
const fetcher = vi.fn();
const json = (data: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ success: true, data }) });

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-13T07:00:00Z"));
	current = structuredClone(initial);
	serial = 1;
	expiresAt = Date.now() + 120_000;
	consumed = false;
	qr.mockReset().mockImplementation(async (url: string) => `data:image/png;base64,${btoa(url)}`);
	writeText.mockClear();
	fetcher.mockReset().mockImplementation(async (url: string, options?: RequestInit) => {
		if (url === "/api/remote") return json(current);
		if (url === "/api/remote/pair") {
			const body = JSON.parse(String(options?.body));
			const base = body.base === "lan" ? "lan" : "public";
			if (consumed || Date.now() >= expiresAt) { serial += 1; expiresAt = Date.now() + 120_000; consumed = false; }
			return json({ code: code(), base, url: `${base === "public" ? publicOrigin : lanOrigin}/pair?code=${code()}`, expiresAt, remainingMs: expiresAt - Date.now() });
		}
		throw new Error(`unexpected request: ${url}`);
	});
	vi.stubGlobal("fetch", fetcher);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { render(<RemoteSection />); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const href = () => atob(screen.getByRole("img").getAttribute("src")!.split(",")[1]);

describe("automatic remote QR connection", () => {
	it("prepares the entries and displays a public QR without start switches or generation clicks", async () => {
		await mount();
		expect(screen.getByRole("img", { name: "连接二维码" })).toBeTruthy();
		expect(screen.queryByRole("switch")).toBeNull();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.queryByRole("button", { name: "开启远程连接" })).toBeNull();
		expect(screen.queryByRole("button", { name: "生成二维码" })).toBeNull();
		expect(fetcher).toHaveBeenCalledWith("/api/remote", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "connect" }) }));
		expect(href()).toBe(`${publicOrigin}/pair?code=${code()}`);
		expect(screen.getByText(/同一 Wi-Fi 或外网都扫这个码/)).toBeTruthy();
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "复制连接链接" })); });
		expect(writeText).toHaveBeenCalledWith(href());
		expect(href()).not.toContain("token=");
		expect(document.body.textContent).not.toContain(code());
	});

	it("keeps a usable QR when the public connection fails and LAN is ready", async () => {
		await mount();
		current.public.ready = false;
		current.public.error = "Cloudflare 1033";
		await advance(3_000);
		expect(href()).toContain(lanOrigin);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByText("Cloudflare 1033")).toBeTruthy();
		current.public.ready = true;
		current.public.error = null;
		await advance(3_000);
		expect(href()).toContain(publicOrigin);
	});

	it("refreshes after use and expiry but retains the same image during ordinary polling", async () => {
		await mount();
		const first = href();
		await advance(9_000);
		expect(href()).toBe(first);
		expect(qr).toHaveBeenCalledTimes(1);
		consumed = true;
		await advance(3_000);
		const second = href();
		expect(second).not.toBe(first);
		await advance(120_000);
		expect(href()).not.toBe(second);
		expect(qr).toHaveBeenCalledTimes(3);
	});

	it("never opens entries or issues a QR while authentication or development restrictions block them and stops polling", async () => {
		current.blocked = "auth";
		await mount();
		expect(screen.getByText(/认证没开，远程连接不可用/)).toBeTruthy();
		expect(screen.queryByRole("img")).toBeNull();
		expect(fetcher.mock.calls.every(([, options]) => !options?.method)).toBe(true);
		const callsWhenBlocked = fetcher.mock.calls.length;
		await advance(9_000);
		expect(fetcher).toHaveBeenCalledTimes(callsWhenBlocked);
	});

	it("does not flash the QR placeholder card before initial status resolves", async () => {
		let resolveStatus!: (value: unknown) => void;
		fetcher.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
		render(<RemoteSection />);
		expect(screen.queryByText("正在准备连接二维码…")).toBeNull();
		expect(screen.getByText("启动中…")).toBeTruthy();
		await act(async () => { resolveStatus(json(current)); });
	});

	it("waits for a usable network and then generates the QR automatically", async () => {
		current.lan.running = false;
		current.lan.urls = [];
		current.public.ready = false;
		await mount();
		expect(screen.queryByRole("img")).toBeNull();
		expect(fetcher.mock.calls.some(([url]) => url === "/api/remote/pair")).toBe(false);
		current.public.ready = true;
		await advance(3_000);
		expect(href()).toContain(publicOrigin);
	});

	it("shows LAN and missing-engine failures and recovers through the retry action", async () => {
		current.lan.running = false;
		current.lan.urls = [];
		current.lan.error = "局域网监听端口已被占用";
		current.public.running = false;
		current.public.ready = false;
		current.public.engineAvailable = false;
		current.public.error = "missing cloudflared";
		await mount();
		expect(screen.getByRole("alert").textContent).toContain(current.lan.error);
		expect(screen.queryByText("启动中…")).toBeNull();
		expect(screen.queryByRole("img")).toBeNull();
		expect(screen.getByText(/cloudflared/)).toBeTruthy();
		current.lan.running = true;
		current.lan.urls = [lanOrigin];
		current.lan.error = null;
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重试连接" })); });
		expect(href()).toContain(lanOrigin);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("discards a stale QR rendering result when the connection page is reopened", async () => {
		let release!: (value: string) => void;
		qr.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
		await mount();
		expect(qr).toHaveBeenCalledTimes(1);
		cleanup();
		await mount();
		expect(href()).toContain(publicOrigin);
		await act(async () => { release("data:image/png;base64,stale"); });
		expect(href()).toContain(publicOrigin);
		expect(screen.getByRole("img").getAttribute("src")).not.toContain("stale");
	});

	it("stops polling after the connection page is closed", async () => {
		await mount();
		const count = fetcher.mock.calls.length;
		cleanup();
		await advance(12_000);
		expect(fetcher).toHaveBeenCalledTimes(count);
	});

	it("retries after a stalled request instead of leaving the QR stuck forever", async () => {
		fetcher.mockImplementationOnce((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
			options.signal!.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "AbortError" })), { once: true });
		}));
		await mount();
		await advance(15_000);
		expect(screen.getByRole("alert").textContent).toBe("操作失败");
		await advance(3_000);
		expect(screen.getByRole("img", { name: "连接二维码" })).toBeTruthy();
	});

	it("shows the sign-out-all control without fetching or listing individual devices", async () => {
		await mount();
		expect(screen.getByText("已登录的设备")).toBeTruthy();
		expect(screen.getByRole("button", { name: "让所有设备重新登录" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "退出此设备" })).toBeNull();
		expect(fetcher.mock.calls.some(([url]) => String(url).includes("/api/web-auth?devices="))).toBe(false);
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "让所有设备重新登录" })); });
		expect(screen.getByRole("button", { name: "再点一次确认" })).toBeTruthy();
	});
});
