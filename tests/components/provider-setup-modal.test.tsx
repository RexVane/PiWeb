// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProviderSetupModal, formatCapacity, parseCapacity, validateModelDrafts } from "@/components/ProviderSetupModal";
import type { ProviderView } from "@/lib/models-service";

afterEach(cleanup);

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
	return {
		id: "xai",
		name: "xAI",
		apis: ["openai-completions"],
		authTypes: ["api_key"],
		builtIn: true,
		authConfigured: false,
		authReady: false,
		authFastPath: false,
		keyManaged: false,
		modelCount: 12,
		...overrides,
	};
}

describe("capacity helpers", () => {
	it("parses K/M human notation", () => {
		expect(parseCapacity("128K")).toBe(128_000);
		expect(parseCapacity("1.5M")).toBe(1_500_000);
		expect(parseCapacity("4096")).toBe(4096);
		expect(parseCapacity("")).toBeUndefined();
		expect(Number.isNaN(parseCapacity("abc"))).toBe(true);
	});

	it("formats round capacities back to K/M", () => {
		expect(formatCapacity(128_000)).toBe("128K");
		expect(formatCapacity(1_000_000)).toBe("1M");
		expect(formatCapacity(4096)).toBe("4096");
		expect(formatCapacity(undefined)).toBe("");
	});

	it("locates the first invalid model row", () => {
		expect(validateModelDrafts([{ id: "grok-4", name: "" }])).toBeUndefined();
		expect(validateModelDrafts([{ id: "  ", name: "" }])).toEqual({ index: 0, reason: "id" });
		expect(validateModelDrafts([{ id: "a", name: "" }, { id: "b", name: "", contextWindow: Number.NaN }])).toEqual({ index: 1, reason: "capacity" });
	});
});

describe("ProviderSetupModal (builtin mode)", () => {
	it("offers OAuth as an authentication method when the provider supports it", () => {
		const onOAuthLogin = vi.fn(async () => ({ success: true }));
		render(
			<ProviderSetupModal
				mode="builtin"
				providers={[provider({ authTypes: ["api_key", "oauth"] })]}
				existingIds={[]}
				onClose={vi.fn()}
				onSaveBuiltin={vi.fn(async () => ({ success: true }))}
				onSaveCustom={vi.fn(async () => ({ success: true }))}
				onOAuthLogin={onOAuthLogin}
			/>,
		);
		expect(screen.getByText("认证方式")).toBeTruthy();
		const select = screen.getByRole("combobox") as HTMLSelectElement;
		expect([...select.options].map((option) => option.textContent)).toEqual(["API 密钥", "OAuth 登录"]);

		// 切到 OAuth：API key 输入框隐藏
		expect(screen.queryByPlaceholderText("输入 API 密钥，或留空使用环境认证")).toBeTruthy();
		fireEvent.change(select, { target: { value: "oauth" } });
		expect(screen.queryByPlaceholderText("输入 API 密钥，或留空使用环境认证")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		return waitFor(() => expect(onOAuthLogin).toHaveBeenCalledWith("xai"));
	});

	it("hides the method picker for providers without OAuth and saves the API key", async () => {
		const onSaveBuiltin = vi.fn(async () => ({ success: true }));
		const onOAuthLogin = vi.fn(async () => ({ success: true }));
		render(
			<ProviderSetupModal
				mode="builtin"
				providers={[provider({ id: "deepseek", name: "DeepSeek" })]}
				existingIds={[]}
				onClose={vi.fn()}
				onSaveBuiltin={onSaveBuiltin}
				onSaveCustom={vi.fn(async () => ({ success: true }))}
				onOAuthLogin={onOAuthLogin}
			/>,
		);
		expect(screen.queryByText("认证方式")).toBeNull();

		fireEvent.change(screen.getByPlaceholderText("输入 API 密钥，或留空使用环境认证"), { target: { value: "sk-test" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(onSaveBuiltin).toHaveBeenCalledWith({ providerId: "deepseek", apiKey: "sk-test", config: {} }));
		expect(onOAuthLogin).not.toHaveBeenCalled();
	});

	it("closes the dialog after a successful save", async () => {
		const onClose = vi.fn();
		render(
			<ProviderSetupModal
				mode="builtin"
				providers={[provider()]}
				existingIds={[]}
				onClose={onClose}
				onSaveBuiltin={vi.fn(async () => ({ success: true }))}
				onSaveCustom={vi.fn(async () => ({ success: true }))}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	it("keeps the dialog open and shows the error when saving fails", async () => {
		const onClose = vi.fn();
		render(
			<ProviderSetupModal
				mode="builtin"
				providers={[provider()]}
				existingIds={[]}
				onClose={onClose}
				onSaveBuiltin={vi.fn(async () => ({ success: false, error: "boom" }))}
				onSaveCustom={vi.fn(async () => ({ success: true }))}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
		expect(onClose).not.toHaveBeenCalled();
	});
});
