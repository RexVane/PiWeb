// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "piweb", loadThemeMode: () => "system" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const success = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
function fallback(url: string) {
	if (url === "/api/pi-settings") return success({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } });
	if (url === "/api/security") return success({ defaultProjectTrust: "ask" });
	if (url === "/api/version") return success({ piWeb: "0.test", piEngine: "0.test" });
	if (url === "/api/web-auth") return success({ enabled: false, authenticated: false });
	throw new Error(`unexpected URL ${url}`);
}

function mount(fetchMock: ReturnType<typeof vi.fn>) {
	vi.stubGlobal("fetch", fetchMock);
	render(<SettingsPanel open cwd="/workspace" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: /插件|Plugins/ }));
}

it("offers a retry when the plugin list request fails", async () => {
	let attempts = 0;
	mount(vi.fn(async (url: string) => {
		if (url.startsWith("/api/plugins")) {
			attempts += 1;
			if (attempts === 1) throw new Error("plugins unavailable");
			return success({ packages: [], extensions: [] });
		}
		return fallback(url);
	}));
	await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("plugins unavailable"));
	fireEvent.click(screen.getByRole("button", { name: /重试|Retry/ }));
	await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("reports a failed extension reload and re-enables its button", async () => {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url.startsWith("/api/plugins") && init?.method === "POST") throw new Error("reload unavailable");
		if (url.startsWith("/api/plugins")) return success({ packages: [], extensions: [] });
		return fallback(url);
	});
	mount(fetchMock);
	const reload = screen.getByRole("button", { name: /重载全部扩展|Reload all extensions/ });
	fireEvent.click(reload);
	await screen.findByText("reload unavailable");
	expect((reload as HTMLButtonElement).disabled).toBe(false);
});
