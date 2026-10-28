// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));
beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => ({ success: true, data: url === "/api/pi-settings" ? { compaction: { enabled: true, reserveTokens: 100 }, retry: { enabled: true, maxRetries: 3 } } : {} }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = { cwd: "/w", toolPreset: "standard" as const, onToolPresetChange: () => {} };

describe("Settings dialog keyboard", () => {
	it("announces a modal and traps Tab and background focus", async () => {
		const { container } = render(<><button>background</button><SettingsPanel {...props} open onClose={vi.fn()} /></>);
		const dialog = screen.getByRole("dialog", { name: "设置" });
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		await waitFor(() => expect((screen.getAllByRole("switch")[0] as HTMLButtonElement).disabled).toBe(false));
		const items = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex]')].filter((item) => item.tabIndex >= 0);
		items.at(-1)!.focus();
		fireEvent.keyDown(document.activeElement!, { key: "Tab" });
		expect(document.activeElement).toBe(items[0]);
		fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
		expect(dialog.contains(document.activeElement)).toBe(true);
		screen.getByRole("button", { name: "background" }).focus();
		expect(dialog.contains(document.activeElement)).toBe(true);
		expect(container.querySelector(".settings-dialog")).toBe(dialog);
	});

	it("uses Escape to close the open select before closing settings", () => {
		const onClose = vi.fn();
		render(<SettingsPanel {...props} open onClose={onClose} />);
		const trigger = screen.getByRole("button", { name: "中文" });
		fireEvent.click(trigger);
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
		expect(document.querySelector(".popover")).toBeNull();
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
