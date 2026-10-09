import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CdpConnection, pipeTransport, type CdpTransport } from "../../../src/lib/browser/cdp";
import { locateBrowser } from "../../../src/lib/browser/locate";
import { BrowserUrlError, checkBrowserUrl } from "../../../src/lib/browser/url-policy";

describe("locateBrowser", () => {
	const only = (...files: string[]) => (file: string) => files.includes(file);

	it("prefers PI_WEB_BROWSER and refuses a missing explicit path", () => {
		expect(locateBrowser({ exists: only("/opt/my/chrome"), env: { PI_WEB_BROWSER: "/opt/my/chrome" }, platform: "linux" })).toBe("/opt/my/chrome");
		// 显式指定但不存在：不偷偷换成别的浏览器
		expect(locateBrowser({ exists: only("/usr/bin/google-chrome"), env: { PI_WEB_BROWSER: "/nope", PATH: "/usr/bin" }, platform: "linux" })).toBeNull();
	});

	it("finds Chrome before Edge on Windows and falls back to Edge", () => {
		const env = { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)" };
		const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
		const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
		expect(locateBrowser({ exists: only(chrome, edge), env, platform: "win32" })).toBe(chrome);
		expect(locateBrowser({ exists: only(edge), env, platform: "win32" })).toBe(edge);
	});

	it("looks in /Applications on macOS and on PATH on Linux", () => {
		expect(locateBrowser({ exists: only("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"), env: {}, platform: "darwin" })).toBe("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
		expect(locateBrowser({ exists: only("/snap/bin/chromium"), env: { PATH: "/usr/bin:/snap/bin" }, platform: "linux" })).toBe("/snap/bin/chromium");
		expect(locateBrowser({ exists: () => false, env: { PATH: "/usr/bin" }, platform: "linux" })).toBeNull();
	});
});

describe("checkBrowserUrl", () => {
	const resolveTo = (...addresses: string[]) => async () => addresses;

	it("allows local and private-network pages and adds a missing scheme", async () => {
		expect((await checkBrowserUrl("localhost:5173", { env: {} })).href).toBe("http://localhost:5173/");
		expect((await checkBrowserUrl("http://app.localhost/x", { env: {} })).hostname).toBe("app.localhost");
		expect((await checkBrowserUrl("http://127.0.0.1:3000", { env: {} })).port).toBe("3000");
		expect((await checkBrowserUrl("http://[::1]:8080", { env: {} })).hostname).toBe("[::1]");
		expect((await checkBrowserUrl("https://192.168.1.20:8443", { env: {} })).protocol).toBe("https:");
		expect((await checkBrowserUrl("http://devbox.lan", { env: {}, resolve: resolveTo("10.0.0.5") })).hostname).toBe("devbox.lan");
	});

	it("rejects public addresses, unsafe schemes and garbage", async () => {
		await expect(checkBrowserUrl("https://example.com", { env: {}, resolve: resolveTo("93.184.216.34") })).rejects.toThrow(/public address/);
		// 任何一个解析结果是公网都拒绝（防混合解析）
		await expect(checkBrowserUrl("http://mixed.test", { env: {}, resolve: resolveTo("10.0.0.5", "8.8.8.8") })).rejects.toThrow(BrowserUrlError);
		await expect(checkBrowserUrl("http://8.8.8.8", { env: {} })).rejects.toThrow(/public address/);
		await expect(checkBrowserUrl("file:///etc/passwd", { env: {} })).rejects.toThrow(/only http/);
		await expect(checkBrowserUrl("javascript://%0aalert(1)", { env: {} })).rejects.toThrow(/only http/);
		await expect(checkBrowserUrl("http://", { env: {} })).rejects.toThrow(/invalid URL/);
	});

	it("opens public pages only when explicitly allowed", async () => {
		expect((await checkBrowserUrl("https://example.com", { env: { PI_WEB_BROWSER_ALLOW_PUBLIC: "1" } })).hostname).toBe("example.com");
	});
});

function fakeTransport() {
	const sent: Array<{ id: number; method: string; params: unknown; sessionId?: string }> = [];
	let receive: (message: string) => void = () => {};
	let closed: (reason: string) => void = () => {};
	const transport: CdpTransport = {
		send: (message) => sent.push(JSON.parse(message)),
		onMessage: (handler) => { receive = handler; },
		onClose: (handler) => { closed = handler; },
		close: () => closed("closed"),
	};
	return { transport, sent, receive: (message: object) => receive(JSON.stringify(message)), drop: (reason: string) => closed(reason) };
}

describe("CdpConnection", () => {
	it("correlates responses by id, surfaces protocol errors and routes session events", async () => {
		const fake = fakeTransport();
		const cdp = new CdpConnection(fake.transport);
		const version = cdp.send("Browser.getVersion");
		const navigate = cdp.send("Page.navigate", { url: "http://localhost" }, "S1");
		expect(fake.sent.map((m) => [m.method, m.sessionId])).toEqual([["Browser.getVersion", undefined], ["Page.navigate", "S1"]]);
		fake.receive({ id: fake.sent[1].id, error: { message: "Cannot navigate" } });
		fake.receive({ id: fake.sent[0].id, result: { product: "Chrome/154" } });
		await expect(version).resolves.toEqual({ product: "Chrome/154" });
		await expect(navigate).rejects.toThrow("Page.navigate: Cannot navigate");

		const events: Array<[unknown, string | undefined]> = [];
		const off = cdp.on("Runtime.consoleAPICalled", (params, sessionId) => events.push([params, sessionId]));
		fake.receive({ method: "Runtime.consoleAPICalled", params: { type: "error" }, sessionId: "S1" });
		off();
		fake.receive({ method: "Runtime.consoleAPICalled", params: { type: "log" }, sessionId: "S1" });
		expect(events).toEqual([[{ type: "error" }, "S1"]]);
	});

	it("times out unanswered requests and fails everything pending when the pipe closes", async () => {
		vi.useFakeTimers();
		try {
			const fake = fakeTransport();
			const cdp = new CdpConnection(fake.transport, 1000);
			const slow = cdp.send("Page.captureScreenshot");
			const slowFailed = expect(slow).rejects.toThrow(/timed out/);
			vi.advanceTimersByTime(1001);
			await slowFailed;
			const pending = cdp.send("Runtime.evaluate");
			const closedReasons: string[] = [];
			cdp.onClose((reason) => closedReasons.push(reason));
			fake.drop("browser closed the pipe");
			await expect(pending).rejects.toThrow(/connection closed \(browser closed the pipe\)/);
			await expect(cdp.send("Browser.getVersion")).rejects.toThrow(/connection closed/);
			expect(cdp.closed).toBe(true);
			expect(closedReasons).toEqual(["browser closed the pipe"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("frames pipe messages on NUL bytes across chunk boundaries", async () => {
		const toBrowser = new PassThrough();
		const fromBrowser = new PassThrough();
		const written: string[] = [];
		toBrowser.on("data", (chunk) => written.push(chunk.toString()));
		const cdp = new CdpConnection(pipeTransport(toBrowser, fromBrowser));
		const first = cdp.send("A");
		const second = cdp.send("B");
		await new Promise((resolve) => setImmediate(resolve));
		expect(written.join("")).toBe(`${JSON.stringify({ id: 1, method: "A", params: {} })}\0${JSON.stringify({ id: 2, method: "B", params: {} })}\0`);
		const payload = `${JSON.stringify({ id: 1, result: { a: "多字节✓" } })}\0${JSON.stringify({ id: 2, result: { b: 2 } })}\0`;
		const bytes = Buffer.from(payload, "utf8");
		// 故意从多字节字符中间切开：解码与分帧都不能出错
		const cut = bytes.indexOf(Buffer.from("✓")) + 1;
		fromBrowser.write(bytes.subarray(0, cut));
		fromBrowser.write(bytes.subarray(cut));
		await expect(first).resolves.toEqual({ a: "多字节✓" });
		await expect(second).resolves.toEqual({ b: 2 });
		fromBrowser.end();
		await new Promise((resolve) => setImmediate(resolve));
		expect(cdp.closed).toBe(true);
	});
});
