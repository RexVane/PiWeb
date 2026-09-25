// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "piweb", loadThemeMode: () => "system" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function response(data: unknown) {
	return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}

describe("general settings controls", () => {
	it("keeps the user on the current page when sign-out fails", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url === "/api/security") return response({ defaultProjectTrust: "ask" });
			if (url === "/api/pi-settings") return response({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } });
			if (url === "/api/version") return response({ piWeb: "0.test", piEngine: "0.test" });
			if (url === "/api/web-auth" && init?.method === "DELETE") return { ok: false, status: 503, json: async () => ({ success: false, error: "unavailable" }) };
			if (url === "/api/web-auth") return response({ enabled: true, authenticated: true });
			throw new Error(`unexpected URL ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<SettingsPanel open cwd="/workspace" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);

		const button = await screen.findByRole("button", { name: /退出登录|Sign out/ });
		fireEvent.click(button);
		await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/退出登录失败|Could not sign out/));
		expect((button as HTMLButtonElement).disabled).toBe(false);
		expect(fetchMock).toHaveBeenCalledWith("/api/web-auth", { method: "DELETE" });
	});

	it("labels icon controls and persists the auto-retry switch through the API", async () => {
		let settings = {
			compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 },
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 },
		};
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url === "/api/pi-settings") {
				if (init?.method === "PUT") {
					const patch = JSON.parse(String(init.body));
					settings = { ...settings, retry: { ...settings.retry, ...patch.retry } };
				}
				return response(settings);
			}
			if (url === "/api/security") return response({ defaultProjectTrust: "ask" });
			if (url === "/api/version") return response({ piWeb: "0.test", piEngine: "0.test" });
			if (url === "/api/web-auth") return response({ enabled: false, authenticated: false });
			throw new Error(`unexpected URL ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const onClose = vi.fn();
		render(<SettingsPanel open cwd="/workspace" toolPreset="standard" onClose={onClose} onToolPresetChange={vi.fn()} />);

		const retry = await screen.findByRole("switch", { name: "自动重试" });
		expect(retry.getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("switch", { name: "自动压缩" })).toBeTruthy();
		fireEvent.click(retry);
		await waitFor(() => expect(retry.getAttribute("aria-checked")).toBe("false"));
		expect(fetchMock).toHaveBeenCalledWith("/api/pi-settings", expect.objectContaining({
			method: "PUT",
			body: JSON.stringify({ retry: { enabled: false } }),
		}));
		fireEvent.click(screen.getByRole("button", { name: "关闭" }));
		expect(onClose).toHaveBeenCalledOnce();
	});
});
