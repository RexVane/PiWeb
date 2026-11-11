// @vitest-environment jsdom
/** 字体仅保留三个预设，兼容旧选择且不改变代码字体。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";
import { applyAllFonts, DEFAULT_FONT_STACK, resolveFontStack, SYSTEM_FONT_STACK } from "@/lib/font";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));

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

function uiFontRow(): HTMLElement {
	const row = screen.getByText("界面字体族").closest<HTMLElement>(".hairline-b");
	expect(row).not.toBeNull();
	return row!;
}

function choose(label: string) {
	fireEvent.click(within(uiFontRow()).getByRole("button"));
	fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: label }));
}

describe("font family picker", () => {
	it("offers exactly Maple, reading and Noto without a custom-font entry", async () => {
		render(<SettingsPanel open cwd="/test-workspace" onClose={vi.fn()} />);
		await waitFor(() => expect(uiFontRow()).toBeTruthy());
		fireEvent.click(within(uiFontRow()).getByRole("button"));
		const options = within(screen.getByRole("listbox")).getAllByRole("option");
		expect(options.map((option) => option.textContent)).toEqual([
			"Maple Mono CN（默认）", "阅读预设（系统无衬线）", "思源黑体",
		]);
		expect(within(uiFontRow()).queryByRole("textbox")).toBeNull();
	});

	it("applies the reading preset to inherited text without changing the code font, and restores it after reopening", async () => {
		const mono = 'Consolas, "Liberation Mono", monospace';
		document.documentElement.style.setProperty("--font-mono", mono);
		const view = render(<SettingsPanel open cwd="/test-workspace" onClose={vi.fn()} />);
		await waitFor(() => expect(uiFontRow()).toBeTruthy());
		choose("阅读预设（系统无衬线）");
		expect(localStorage.getItem("piweb.fontUi")).toBe("reading");
		expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe(SYSTEM_FONT_STACK);
		expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(mono);
		expect(screen.getByText("界面与对话正文使用系统无衬线字体，代码保持系统等宽，适合长篇阅读。")).toBeTruthy();

		view.unmount();
		document.documentElement.style.removeProperty("--font-ui");
		applyAllFonts();
		expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe(SYSTEM_FONT_STACK);
		expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(""); // Uses the unchanged CSS monospace default.
		render(<SettingsPanel open cwd="/test-workspace" onClose={vi.fn()} />);
		await waitFor(() => expect(within(uiFontRow()).getByRole("button").textContent).toContain("阅读预设（系统无衬线）"));
		expect(localStorage.getItem("piweb.fontUi")).toBe("reading");
	});

	it.each([
		["maple", "Maple Mono CN（默认）"],
		["reading", "阅读预设（系统无衬线）"],
		["noto", "思源黑体"],
	])("preserves a saved %s preset", async (saved, label) => {
		localStorage.setItem("piweb.fontUi", saved);
		applyAllFonts();
		render(<SettingsPanel open cwd="/test-workspace" onClose={vi.fn()} />);
		await waitFor(() => expect(within(uiFontRow()).getByRole("button").textContent).toContain(label));
		expect(localStorage.getItem("piweb.fontUi")).toBe(saved);
		expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe(resolveFontStack(saved));
	});

	it("keeps Maple as the default until a font is explicitly selected", async () => {
		render(<SettingsPanel open cwd="/test-workspace" onClose={vi.fn()} />);
		await waitFor(() => expect(within(uiFontRow()).getByRole("button").textContent).toContain("Maple Mono CN（默认）"));
		expect(resolveFontStack(null)).toBe(DEFAULT_FONT_STACK);
		expect(localStorage.getItem("piweb.fontUi")).toBeNull();
		expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("");
	});

	it.each(["system", "custom:Fira Code, monospace", "custom:"])("migrates a saved %s choice to reading during startup", async (saved) => {
		localStorage.setItem("piweb.fontUi", saved);
		document.documentElement.style.setProperty("--font-ui", "Fira Code, monospace");
		applyAllFonts();
		render(<SettingsPanel open cwd="/test-workspace" onClose={vi.fn()} />);
		await waitFor(() => expect(within(uiFontRow()).getByRole("button").textContent).toContain("阅读预设（系统无衬线）"));
		expect(localStorage.getItem("piweb.fontUi")).toBe("reading");
		expect(resolveFontStack(saved)).toBe(SYSTEM_FONT_STACK);
		expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe(SYSTEM_FONT_STACK);
		expect(within(uiFontRow()).queryByRole("textbox")).toBeNull();
	});

	it("migrates a legacy custom choice when settings opens before startup font replay", async () => {
		localStorage.setItem("piweb.fontUi", "custom:Fira Code, monospace");
		document.documentElement.style.setProperty("--font-ui", "Fira Code, monospace");
		const mono = 'Consolas, "Liberation Mono", monospace';
		document.documentElement.style.setProperty("--font-mono", mono);
		render(<SettingsPanel open cwd="/test-workspace" onClose={vi.fn()} />);
		await waitFor(() => expect(within(uiFontRow()).getByRole("button").textContent).toContain("阅读预设（系统无衬线）"));
		expect(localStorage.getItem("piweb.fontUi")).toBe("reading");
		expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe(SYSTEM_FONT_STACK);
		expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(mono);
		choose("Maple Mono CN（默认）");
		expect(localStorage.getItem("piweb.fontUi")).toBe("maple");
		expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe(DEFAULT_FONT_STACK);
	});
});
