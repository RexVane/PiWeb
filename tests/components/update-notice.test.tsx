// @vitest-environment jsdom
/**
 * 右下角更新提示条：有新版本才出现、同一次启动关掉就不再出现、
 * 「更新」逐个装完提示重启、Windows npm 安装给命令不给按钮、有会话在跑时说清楚原因。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UPDATE_NOTICE_KEY, UpdateNotice } from "@/components/update/UpdateNotice";
import { resetUpdates } from "@/components/update/update-store";

type Results = Record<string, unknown>;

function reply(status: number, body: unknown) {
	return { ok: status < 400, status, json: async () => body };
}

/** GET 返回启动检查结果；POST update 按 target 给结果（默认成功） */
function stubFetch(results: Results, startId: string | null = "start-1", updates: Record<string, () => ReturnType<typeof reply>> = {}) {
	const posts: string[] = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url !== "/api/update") throw new Error(`unexpected URL ${url}`);
		if (!init?.method || init.method === "GET") return reply(200, { success: true, data: { startId, results } });
		const { target, action } = JSON.parse(String(init.body));
		posts.push(`${action}:${target}`);
		return updates[target]?.() ?? reply(200, { success: true, data: { version: target === "pi" ? "1.2.0" : "0.3.20", needsRestart: true } });
	});
	vi.stubGlobal("fetch", fetchMock);
	return posts;
}

const PIWEB = { current: "0.3.18", latest: "0.3.20", canUpdate: true, selfUpdate: true };
const PI = { current: "1.1.0", latest: "1.2.0", canUpdate: true, selfUpdate: true };

beforeEach(() => {
	resetUpdates();
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("更新提示条", () => {
	it("仅 Pi 有新版本时不显示提示", async () => {
		stubFetch({ pi: PI });
		render(<UpdateNotice />);
		await act(async () => {});
		expect(screen.queryByTestId("update-notice")).toBeNull();
	});
	it("没有新版本、检查失败或关了启动检查都不出现", async () => {
		stubFetch({ piweb: { ...PIWEB, latest: PIWEB.current, canUpdate: false }, pi: { error: "offline" } });
		const { unmount } = render(<UpdateNotice />);
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		await act(async () => {});
		expect(screen.queryByTestId("update-notice")).toBeNull();
		unmount();

		resetUpdates();
		stubFetch({}, null);
		render(<UpdateNotice />);
		await act(async () => {});
		expect(screen.queryByTestId("update-notice")).toBeNull();
	});

	it("有新版本就列出来；「稍后」后同一次启动不再出现，换一次启动又会提醒", async () => {
		stubFetch({ piweb: PIWEB, pi: { ...PI, latest: PI.current, canUpdate: false } });
		const { unmount } = render(<UpdateNotice />);
		const notice = await screen.findByTestId("update-notice");
		expect(notice.textContent).toContain("有新版本");
		expect(notice.textContent).toContain("PiWeb");
		expect(notice.textContent).toContain("0.3.18 → 0.3.20");
		expect(notice.textContent).not.toContain("1.1.0");

		fireEvent.click(screen.getByRole("button", { name: "稍后" }));
		expect(screen.queryByTestId("update-notice")).toBeNull();
		expect(localStorage.getItem(UPDATE_NOTICE_KEY)).toBe("start-1");
		unmount();

		resetUpdates();
		stubFetch({ piweb: PIWEB }, "start-1");
		const again = render(<UpdateNotice />);
		await act(async () => {});
		expect(screen.queryByTestId("update-notice")).toBeNull();
		again.unmount();

		resetUpdates();
		stubFetch({ piweb: PIWEB }, "start-2");
		render(<UpdateNotice />);
		expect(await screen.findByTestId("update-notice")).toBeTruthy();
	});

	it("「更新」只更新 PiWeb，不包含内置 Pi，装完提示手动重启", async () => {
		const posts = stubFetch({ piweb: PIWEB, pi: PI });
		render(<UpdateNotice />);
		fireEvent.click(await screen.findByRole("button", { name: "更新" }));
		await screen.findByText("更新完成");
		expect(posts).toEqual(["update:piweb"]);
		const notice = screen.getByTestId("update-notice");
		expect(notice.textContent).toContain("已更新到 0.3.20");
		expect(notice.textContent).not.toContain("1.2.0");
		expect(notice.textContent).toContain("重启 PiWeb 后生效");
		expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "知道了" }));
		expect(screen.queryByTestId("update-notice")).toBeNull();
	});

	it("Windows 上的 npm 安装：给命令和复制按钮，不给「更新」按钮", async () => {
		const command = "npm install -g @rexvane/piweb@latest";
		const posts = stubFetch({ piweb: { ...PIWEB, selfUpdate: false, command } });
		render(<UpdateNotice />);
		const notice = await screen.findByTestId("update-notice");
		expect(notice.textContent).toContain("先停掉 piweb");
		expect(notice.textContent).toContain(command);
		expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
		expect(screen.getByRole("button", { name: "知道了" })).toBeTruthy();
		expect(posts).toEqual([]);
	});

	it("有会话在跑（409）：说明原因、后面的不再装，可以再试", async () => {
		const posts = stubFetch({ piweb: PIWEB, pi: PI }, "start-1", {
			piweb: () => reply(409, { success: false, error: "sessions are running; retry in a maintenance window" }),
		});
		render(<UpdateNotice />);
		fireEvent.click(await screen.findByRole("button", { name: "更新" }));
		await screen.findByText("有会话正在运行，等它结束再更新");
		expect(posts).toEqual(["update:piweb"]);
		expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "稍后" })).toBeTruthy();
	});
});
