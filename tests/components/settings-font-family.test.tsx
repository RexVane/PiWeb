// @vitest-environment jsdom
/**
 * 字体族选择（PR #19）：「自定义」是下拉自己的选中状态。
 * 改前它是从输入框内容推断的——删空输入框，下拉弹回默认、输入框一起消失；
 * 输入框里留着字时选回预设，下拉还停在「自定义」。两条断言改前都会失败。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));

function response(data: unknown) { return { ok: true, status: 200, json: async () => ({ success: true, data }) }; }

beforeEach(() => {
	localStorage.clear();
	document.documentElement.style.removeProperty("--font-ui");
	vi.stubGlobal("fetch", vi.fn(async (url: string) => {
		if (url === "/api/models?custom=1") return response({ providers: [], customProviders: { content: JSON.stringify({ providers: {} }), revision: "rev-1", secretProviderIds: [] } });
		if (url === "/api/pi-settings") return response({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } });
		if (url === "/api/security") return response({ defaultProjectTrust: "ask" });
		if (url === "/api/version") return response({ piWeb: "0.test", piEngine: "0.test" });
		if (url === "/api/web-auth") return response({ enabled: false });
		throw new Error(`unexpected URL ${url}`);
	}));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const PLACEHOLDER = "输入字体栈，如 Fira Code, monospace";

function uiFontRow(): HTMLElement {
	const row = screen.getByText("界面字体族").closest<HTMLElement>(".hairline-b");
	expect(row).not.toBeNull();
	return row!;
}

function choose(label: string) {
	fireEvent.click(within(uiFontRow()).getByRole("button"));
	fireEvent.click(screen.getByRole("button", { name: label }));
}

describe("font family picker", () => {
	it("keeps the custom input when it is emptied", async () => {
		render(<SettingsPanel open cwd="/test-workspace" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
		await waitFor(() => expect(uiFontRow()).toBeTruthy());
		choose("自定义…");
		const input = within(uiFontRow()).getByPlaceholderText(PLACEHOLDER);

		fireEvent.change(input, { target: { value: "Fira Code" } });
		expect(localStorage.getItem("piweb.fontUi")).toBe("custom:Fira Code");
		expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("Fira Code");

		fireEvent.change(input, { target: { value: "" } });
		// 字体回落默认，但还在「自定义」里等你重新输入
		expect(localStorage.getItem("piweb.fontUi")).toBeNull();
		expect(within(uiFontRow()).getByPlaceholderText(PLACEHOLDER)).toBeTruthy();
		expect(within(uiFontRow()).getByRole("button").textContent).toContain("自定义…");
	});

	it("leaves custom mode when a preset is picked even if the input still has text", async () => {
		render(<SettingsPanel open cwd="/test-workspace" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
		await waitFor(() => expect(uiFontRow()).toBeTruthy());
		choose("自定义…");
		fireEvent.change(within(uiFontRow()).getByPlaceholderText(PLACEHOLDER), { target: { value: "Fira Code" } });

		choose("系统默认");
		expect(localStorage.getItem("piweb.fontUi")).toBe("system");
		expect(within(uiFontRow()).queryByPlaceholderText(PLACEHOLDER)).toBeNull();
		expect(within(uiFontRow()).getByRole("button").textContent).toContain("系统默认");

		// 再切回「自定义」，上次输入的字体栈还在、并立即生效
		choose("自定义…");
		expect((within(uiFontRow()).getByPlaceholderText(PLACEHOLDER) as HTMLInputElement).value).toBe("Fira Code");
		expect(localStorage.getItem("piweb.fontUi")).toBe("custom:Fira Code");
	});
});
