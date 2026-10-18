// @vitest-environment jsdom
/**
 * 设置 → 远程连接：入口链接带启动令牌，手机打开就直接登录。
 * 改前链接是裸地址，手机打开只能看到「这个实例用启动令牌登录」，还得去终端里抄令牌。
 * 屏幕上仍只显示裸地址：截图、共享屏幕时令牌不能露出来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { loginLink, RemoteSection } from "@/components/RemoteSection";

const TOKEN = "tok-123_ABC";
const status = {
	plugin: "builtin-remote",
	targetPort: 30141,
	blocked: null,
	lan: { running: true, port: 30142, urls: ["http://192.168.5.44:30142"], error: null },
	public: { running: true, url: "https://abc-def.trycloudflare.com", ready: true, engine: "cloudflared", engineAvailable: true, error: null },
	loginToken: TOKEN,
};

const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
	writeText.mockClear();
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: status }) })));
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("remote entry links", () => {
	it("builds a root login link and leaves bare addresses alone without a token", () => {
		expect(loginLink("http://192.168.5.44:30142", "a b")).toBe("http://192.168.5.44:30142/?token=a%20b");
		expect(loginLink("https://abc.trycloudflare.com/", TOKEN)).toBe(`https://abc.trycloudflare.com/?token=${TOKEN}`);
		expect(loginLink("http://192.168.5.44:30142", null)).toBe("http://192.168.5.44:30142");
	});

	it("links and copies the tokened address but only shows the bare one", async () => {
		render(<RemoteSection />);
		const lan = await screen.findByRole("link", { name: "http://192.168.5.44:30142" });
		expect(lan.getAttribute("href")).toBe(`http://192.168.5.44:30142/?token=${TOKEN}`);
		const pub = screen.getByRole("link", { name: "https://abc-def.trycloudflare.com" });
		expect(pub.getAttribute("href")).toBe(`https://abc-def.trycloudflare.com/?token=${TOKEN}`);
		// 令牌不出现在页面文字里
		expect(document.body.textContent).not.toContain(TOKEN);

		fireEvent.click(screen.getAllByRole("button", { name: "复制" })[0]);
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(`http://192.168.5.44:30142/?token=${TOKEN}`));
		expect(await screen.findByRole("button", { name: "已复制（含令牌）" })).toBeTruthy();
	});

	/**
	 * 插件开关与「纯转发」标注。
	 * 关键：字段缺失（旧服务端、缓存的响应）不能被当成「插件已关闭」——那会在界面上误报纯转发。
	 */
	it("does not claim plain forwarding when the response has no styled flag", async () => {
		// 上面那份 status 就没有 styled / pluginEnabled，正是旧响应的形状
		render(<RemoteSection />);
		await screen.findByRole("link", { name: "http://192.168.5.44:30142" });
		// 只看状态标注（形如「· 纯转发（未注入手机排版）」）：说明文案里本来就有「纯转发」三个字
		expect(document.body.textContent).not.toContain("· 纯转发");
		// 开关按「已启用」处理：断言开关本身（aria-checked），比匹配文字更稳
		const toggle = screen.getByRole("switch", { name: "启用内置远程连接插件" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		// 公网入口按钮不被插件开关拦住
		expect((screen.getByText("关闭").closest("button") as HTMLButtonElement).disabled).toBe(false);
	});

	it("locks the plugin switch while remote entries are blocked", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true, status: 200,
			json: async () => ({ success: true, data: { ...status, blocked: "auth", loginToken: null, lan: { ...status.lan, running: false, urls: [] }, public: { ...status.public, running: false, ready: false, url: null } } }),
		})));
		render(<RemoteSection />);
		const toggle = screen.getByRole("switch", { name: "启用内置远程连接插件" }) as HTMLButtonElement;
		await waitFor(() => expect(screen.getByText("开启远程连接").closest("button")?.disabled).toBe(true));
		expect(toggle.disabled).toBe(true);
	});

	it("marks the LAN entry as plain forwarding only when the server says so", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true, status: 200,
			json: async () => ({
				success: true,
				data: {
					...status,
					pluginEnabled: false,
					lan: { ...status.lan, styled: false },
					// 公网入口没开，才渲染「开启远程连接」这个按钮
					public: { ...status.public, running: false, ready: false, url: null },
				},
			}),
		})));
		render(<RemoteSection />);
		await screen.findByRole("link", { name: "http://192.168.5.44:30142" });
		expect(document.body.textContent).toContain("· 纯转发");
		expect(document.body.textContent).toContain("已关闭");
		// 插件关闭时公网入口不可开，按钮置灰并说明原因
		expect((screen.getByText("开启远程连接").closest("button") as HTMLButtonElement).disabled).toBe(true);
		expect(document.body.textContent).toContain("需要先启用内置插件");
	});
});
