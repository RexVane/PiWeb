// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/settings/SettingsPanel";

vi.mock("@/lib/ui/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, "clipboard"); });

describe("settings → versions on an npm installation", () => {
	it("shows the npm command instead of an update button, and says pi comes with PiWeb releases", async () => {
		const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
		vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
			if (url === "/api/update") {
				const { target, action } = JSON.parse(String(init?.body));
				if (action !== "check") throw new Error("an npm installation must not be updated in place");
				return ok(target === "piweb"
					? { current: "1.0.0", latest: "1.2.0", canUpdate: true, command: "npm install -g @rexvane/piweb@latest" }
					: { current: "1.0.0", latest: "2.0.0", canUpdate: true, bundled: true });
			}
			if (url === "/api/pi-settings") return ok({ compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, thinking: { defaultLevel: null, modelLevels: {}, budgets: {} }, defaultModel: null });
			if (url === "/api/security") return ok({ defaultProjectTrust: "ask" });
			if (url === "/api/version") return ok({ piWeb: "1.0.0", piEngine: "1.0.0" });
			if (url === "/api/web-auth") return ok({ enabled: false });
			throw new Error(`unexpected URL ${url}`);
		}));
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		render(<SettingsPanel open cwd="/w" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
		const [piweb, pi] = screen.getAllByRole("button", { name: "检查更新" });

		fireEvent.click(piweb);
		expect(await screen.findByText("npm install -g @rexvane/piweb@latest")).toBeTruthy();
		expect(screen.getByText("1.2.0 已发布：npm 安装请先停止 piweb，在终端运行下面的命令，再重新启动")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /更新到/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "复制" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("npm install -g @rexvane/piweb@latest"));
		expect(await screen.findByRole("button", { name: "已复制" })).toBeTruthy();

		fireEvent.click(pi);
		expect(await screen.findByText("pi 2.0.0 已发布：npm 安装的 pi 随 PiWeb 发布版本一起更新")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /更新到/ })).toBeNull();
	});
});
