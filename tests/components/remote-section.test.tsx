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
});
