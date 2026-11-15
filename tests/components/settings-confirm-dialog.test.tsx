// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsSection } from "@/components/settings/PluginsSection";

vi.mock("@/lib/theme", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/theme")>()),
	applyPebrelTheme: () => {},
	loadPebrelTheme: () => "dsh",
	loadThemeMode: () => "system",
}));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("themed ConfirmDialog in SettingsPanel / PluginsSection", () => {
	it("replaces window.confirm and closes nested confirm on Escape without closing SettingsPanel", async () => {
		const confirmSpy = vi.fn(() => true);
		vi.stubGlobal("confirm", confirmSpy);

		const savedBodies: any[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/models?custom=1") {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						success: true,
						data: {
							providers: [
								{
									id: "demo-custom",
									name: "Demo Custom",
									builtIn: false,
									authReady: true,
									authConfigured: true,
									keyManaged: false,
									authTypes: ["api_key"],
									apis: ["openai-completions"],
									modelCount: 1,
								},
							],
							customProviders: {
								content: JSON.stringify({
									providers: {
										"demo-custom": {
											name: "Demo Custom",
											baseUrl: "https://example.invalid/v1",
											api: "openai-completions",
											models: [{ id: "m1" }],
										},
									},
								}),
								revision: "rev-1",
								secretProviderIds: [],
							},
						},
					}),
				};
			}
			if (url === "/api/models" && init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				if (body.action === "saveCustomProviders") savedBodies.push(body);
				return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
			}
			if (url === "/api/pi-settings") {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						success: true,
						data: {
							retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10000 },
							compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
						},
					}),
				};
			}
			if (url === "/api/version") return { ok: true, status: 200, json: async () => ({ success: true, data: { piWeb: "0.3.30", piEngine: "0.0.0" } }) };
			if (url === "/api/web-auth") return { ok: true, status: 200, json: async () => ({ success: true, data: { enabled: false, authenticated: false } }) };
			return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
		});
		vi.stubGlobal("fetch", fetchMock);

		const onCloseSettings = vi.fn();
		render(<SettingsPanel open onClose={onCloseSettings} />);

		fireEvent.click(screen.getByRole("button", { name: "模型" }));
		const deleteBtn = await screen.findByRole("button", { name: "删除" });
		deleteBtn.focus();
		fireEvent.click(deleteBtn);

		const confirmDialog = await screen.findByRole("alertdialog");
		expect(confirmSpy).not.toHaveBeenCalled();
		expect(confirmDialog.textContent).toContain("Demo Custom");

		// Escape 仅关闭嵌套确认框，不关闭设置弹窗
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onCloseSettings).not.toHaveBeenCalled();
		expect(savedBodies).toHaveLength(0);

		// 再次打开并确认删除
		fireEvent.click(screen.getByRole("button", { name: "删除" }));
		const dialog2 = await screen.findByRole("alertdialog");
		fireEvent.click(within(dialog2).getByRole("button", { name: "删除" }));
		await waitFor(() => expect(savedBodies).toHaveLength(1));
		expect(savedBodies[0].action).toBe("saveCustomProviders");
	});

	it("renders ConfirmDialog and disabled package update check cleanly in standalone PluginsSection", async () => {
		const removeBodies: unknown[] = [];
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST") {
				removeBodies.push(JSON.parse(String(init.body)));
				return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({
					success: true,
					data: {
						packages: [{ source: "npm:demo-pkg", scope: "user", disabled: true, resources: { extensions: 1, skills: 0, prompts: 0 } }],
						extensions: [],
					},
				}),
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<PluginsSection cwd="/test-workspace" />);
		await screen.findByText("demo-pkg");

		const updateButton = screen.getByRole("button", { name: "更新" }) as HTMLButtonElement;
		expect(updateButton.disabled).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "卸载" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog.textContent).toContain("npm:demo-pkg");
		fireEvent.click(within(dialog).getByRole("button", { name: "卸载" }));
		await waitFor(() => expect(removeBodies).toHaveLength(1));
		expect(removeBodies[0]).toMatchObject({ action: "remove", source: "npm:demo-pkg" });
	});
});
