// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralSection } from "@/components/settings/GeneralSection";

vi.mock("@/components/update/update-store", () => ({
	loadUpdates: vi.fn(), checkUpdate: vi.fn(), runUpdate: vi.fn(),
	useUpdates: () => ({ targets: { pi: { phase: "idle" }, piweb: { phase: "idle" } } }),
}));
const settings = (maxRetries = 3) => ({
	compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
	retry: { enabled: true, maxRetries, baseDelayMs: 2_000 },
	cacheWarming: "idle", steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", httpProxy: "",
});
const response = (data: unknown) => Response.json({ success: true, data });
const input = () => screen.getByRole("spinbutton", { name: "最大重试次数" }) as HTMLInputElement;
function setup(save: (patch: unknown) => Promise<Response> = async () => response(settings())) {
	const writes = vi.fn(save);
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/pi-settings") return init?.method === "PUT" ? writes(JSON.parse(String(init.body))) : response(settings());
		if (url === "/api/proxy") return response({ source: "none", http: null, https: null });
		if (url === "/api/version") return response({ piWeb: "test", piEngine: "test" });
		if (url === "/api/web-auth") return response({ enabled: false });
		if (url === "/api/security") return response({});
		throw new Error(`Unexpected URL ${url}`);
	}));
	render(<GeneralSection lang="zh" setLang={vi.fn()} cwd="/workspace" />);
	return writes;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
