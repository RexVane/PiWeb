// @vitest-environment jsdom
/** 字体族不再可配：界面固定系统无衬线、代码固定系统等宽；旧的字体偏好会在启动时清掉。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";
import { clearRetiredFontPreferences } from "@/lib/theme";

// 只替换主题应用（它会清旧偏好并写主题属性），其余保持真实实现供清理函数使用。
vi.mock("@/lib/theme", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/theme")>();
	return { ...actual, applyPebrelTheme: vi.fn() };
});

function response(data: unknown) { return { ok: true, status: 200, json: async () => ({ success: true, data }) }; }

beforeEach(() => {
	localStorage.clear();
	document.documentElement.style.removeProperty("--font-ui");
	document.documentElement.style.removeProperty("--font-mono");
	vi.stubGlobal("fetch", vi.fn(async (url: string) => {
		if (url === "/api/models?custom=1") return response({ providers: [], customProviders: { content: JSON.stringify({ providers: {} }), revision: "rev-1", secretProviderIds: [] } });
		if (url === "/api/pi-settings") return response({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } });
		if (url === "/api/security") return response({ defaultProjectTrust: "ask" });
		if (url === "/api/version") return response({ piWeb: "0.test", piEngine: "0.test" });
		if (url === "/api/web-auth") return response({ enabled: false });
		throw new Error(`unexpected URL ${url}`);
	}));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	document.documentElement.style.removeProperty("--font-ui");
	document.documentElement.style.removeProperty("--font-mono");
});

async function renderSettings() {
	render(<SettingsPanel open cwd="/test-workspace" onClose={vi.fn()} />);
	await waitFor(() => expect(screen.getByText("界面字体")).toBeTruthy());
}

describe("font family is no longer configurable", () => {
	it("设置里只剩字号，没有字体族选择", async () => {
		await renderSettings();
		expect(screen.queryByText("界面字体族")).toBeNull();
		expect(screen.queryByText("UI font family")).toBeNull();
		expect(screen.getByText("对话字体")).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "decrease font size" }).length).toBeGreaterThan(0);
	});

	it("启动时清掉历史字体偏好，字号偏好不动", () => {
		localStorage.setItem("piweb.fontUi", "maple");
		localStorage.setItem("piweb.fontMono", "Consolas, monospace");
		localStorage.setItem("piweb.fontSize", "16");
		localStorage.setItem("piweb.chatFontSize", "15");
		document.documentElement.style.setProperty("--font-ui", "Fira Code, monospace");
		document.documentElement.style.setProperty("--font-mono", "Fira Code, monospace");

		clearRetiredFontPreferences();

		expect(localStorage.getItem("piweb.fontUi")).toBeNull();
		expect(localStorage.getItem("piweb.fontMono")).toBeNull();
		expect(localStorage.getItem("piweb.fontSize")).toBe("16");
		expect(localStorage.getItem("piweb.chatFontSize")).toBe("15");
		expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("");
		expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe("");
	});

	it("清理后再打开设置，不会把字体偏好写回来", async () => {
		localStorage.setItem("piweb.fontUi", "maple");
		document.documentElement.style.setProperty("--font-ui", "Fira Code, monospace");
		clearRetiredFontPreferences();

		await renderSettings();

		expect(localStorage.getItem("piweb.fontUi")).toBeNull();
		expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("");
	});
});
