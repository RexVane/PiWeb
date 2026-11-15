// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralSection } from "@/components/settings/GeneralSection";

vi.mock("@/components/update/update-store", () => ({
	loadUpdates: vi.fn(), checkUpdate: vi.fn(), runUpdate: vi.fn(),
	useUpdates: () => ({ targets: { pi: { phase: "idle" }, piweb: { phase: "idle" } } }),
}));
const settings = (maxRetries = 3, compactionOverrides: Partial<{ enabled: boolean; reserveTokens: number; keepRecentTokens: number }> = {}) => ({
	compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, ...compactionOverrides },
	retry: { enabled: true, maxRetries, baseDelayMs: 2_000 },
	cacheWarming: "idle", steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", httpProxy: "",
});
const response = (data: unknown) => Response.json({ success: true, data });
const input = () => screen.getByRole("spinbutton", { name: "最大重试次数" }) as HTMLInputElement;
const reserveInput = () => screen.getByRole("spinbutton", { name: "触发阈值保留 (Tokens)" }) as HTMLInputElement;
const keepRecentInput = () => screen.getByRole("spinbutton", { name: "保留近期内容 (Tokens)" }) as HTMLInputElement;
function setup(save?: (patch: unknown) => Promise<Response>) {
	let current = settings();
	const writes = vi.fn(save ?? (async (patch) => {
		const p = patch as { compaction?: Record<string, unknown>; retry?: Record<string, unknown> };
		current = {
			...current,
			...(p.compaction ? { compaction: { ...current.compaction, ...p.compaction } } : {}),
			...(p.retry ? { retry: { ...current.retry, ...p.retry } } : {}),
		};
		return response(current);
	}));
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/pi-settings") return init?.method === "PUT" ? writes(JSON.parse(String(init.body))) : response(current);
		if (url === "/api/proxy") return response({ source: "none", http: null, https: null });
		if (url === "/api/version") return response({ piWeb: "test", piEngine: "test" });
		if (url === "/api/web-auth") return response({ enabled: false });
		if (url === "/api/security") return response({});
		throw new Error(`Unexpected URL ${url}`);
	}));
	render(<GeneralSection lang="zh" setLang={vi.fn()} />);
	return writes;
}
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("retry count draft commits", () => {
	it.each(["", "-1", "1.5", "1000000001"])("restores the saved count and sends no request for invalid input %j", async (value) => {
		const writes = setup();
		await waitFor(() => expect(input().value).toBe("3"));
		fireEvent.change(input(), { target: { value } }); fireEvent.blur(input());
		expect(input().value).toBe("3");
		expect(screen.getByRole("alert").textContent).toContain("设置未保存");
		expect(writes).not.toHaveBeenCalled();
	});

	it.each(["response", "network"])("restores the saved count after a %s failure", async (failure) => {
		const writes = setup(async () => {
			if (failure === "network") throw new Error("connection interrupted");
			return Response.json({ success: false, error: "write failed" }, { status: 500 });
		});
		await waitFor(() => expect(input().value).toBe("3"));
		fireEvent.change(input(), { target: { value: "7" } }); fireEvent.blur(input());
		await waitFor(() => expect(input().value).toBe("3"));
		expect(writes).toHaveBeenCalledExactlyOnceWith({ retry: { maxRetries: 7 } });
		expect(screen.getByRole("alert").textContent).toContain("设置未保存");
		expect(input().disabled).toBe(false);
	});

	it("rolls back to the most recent successful count after a later save fails", async () => {
		let attempts = 0;
		const writes = setup(async () => ++attempts === 1
			? response(settings(6)) : Response.json({ success: false, error: "write failed" }, { status: 500 }));
		await waitFor(() => expect(input().value).toBe("3"));
		fireEvent.change(input(), { target: { value: "6" } }); fireEvent.blur(input());
		await waitFor(() => expect(writes).toHaveBeenCalledOnce());
		await waitFor(() => expect(input().disabled).toBe(false));
		expect(input().value).toBe("6");
		fireEvent.change(input(), { target: { value: "9" } }); fireEvent.blur(input());
		await waitFor(() => expect(input().value).toBe("6"));
		expect(writes).toHaveBeenLastCalledWith({ retry: { maxRetries: 9 } });
	});
});

describe("theme dropdown & compaction parameters", () => {
	it("renders appearance theme selector as a compact dropdown with color dots and switches themes", async () => {
		setup();
		await waitFor(() => expect(reserveInput().value).toBe("16384"));
		// 仅渲染一个下拉按钮，不平铺多个主题大卡片
		expect(screen.queryByRole("button", { name: /石灰与煤炭/ })).toBeNull();
		const trigger = screen.getByRole("button", { name: "外观" });
		expect(trigger.textContent).toContain("北欧纸墨");
		expect(screen.getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(trigger);
		const listbox = await screen.findByRole("listbox");
		expect(within(listbox).queryByRole("option", { name: "银钢" })).toBeNull();
		const option = within(listbox).getByRole("option", { name: "天青" });
		fireEvent.click(option);
		await waitFor(() => expect(screen.getByRole("button", { name: "外观" }).textContent).toContain("天青"));
		expect(localStorage.getItem("piweb.pebrelTheme")).toBe("ripple");
	});

	it("shows reserveTokens and keepRecentTokens under 自动压缩 only when enabled and persists edits", async () => {
		const writes = setup();
		const group = await screen.findByRole("group", { name: "自动压缩" });
		await waitFor(() => expect(within(group).getByRole("spinbutton", { name: "触发阈值保留 (Tokens)" })).toBeTruthy());
		expect(reserveInput().value).toBe("16384");
		expect(keepRecentInput().value).toBe("20000");

		fireEvent.change(reserveInput(), { target: { value: "24000" } });
		fireEvent.blur(reserveInput());
		await waitFor(() => expect(writes).toHaveBeenCalledWith({ compaction: { reserveTokens: 24000 } }));

		await waitFor(() => expect(keepRecentInput().disabled).toBe(false));
		fireEvent.change(keepRecentInput(), { target: { value: "12000" } });
		fireEvent.blur(keepRecentInput());
		await waitFor(() => expect(writes).toHaveBeenLastCalledWith({ compaction: { keepRecentTokens: 12000 } }));

		// 非法输入不发送请求并回退
		fireEvent.change(reserveInput(), { target: { value: "-5" } });
		fireEvent.blur(reserveInput());
		expect(reserveInput().value).toBe("24000");
		expect(screen.getByRole("alert").textContent).toContain("设置未保存");

		// 关闭自动压缩开关时折叠隐藏两个参数
		await waitFor(() => expect(screen.getByRole("switch", { name: "自动压缩" }).getAttribute("aria-checked")).toBe("true"));
		fireEvent.click(screen.getByRole("switch", { name: "自动压缩" }));
		await waitFor(() => expect(screen.queryByRole("spinbutton", { name: "触发阈值保留 (Tokens)" })).toBeNull());
		expect(screen.queryByRole("spinbutton", { name: "保留近期内容 (Tokens)" })).toBeNull();
	});
});
