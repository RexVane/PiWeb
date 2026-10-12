// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProviderSetupModal, formatCapacity, parseCapacity, validateModelDrafts } from "@/components/ProviderSetupModal";
import type { ProviderView } from "@/lib/models-service";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

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

	it("keeps built-in catalog models out of discovered picks and saves their edits as overrides", async () => {
		// 回归：「获取可用模型」默认勾选目录里已有的 ID，采纳后写成同 ID 的 models[]，内置模型被整条重建
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true,
			json: async () => ({ success: true, data: { models: [{ id: "grok-4", name: "Remote name" }, { id: "grok-new", name: "Grok New" }] } }),
		})));
		const onSaveBuiltin = vi.fn(async () => ({ success: true }));
		render(
			<ProviderSetupModal
				mode="builtin"
				providers={[provider({ apis: ["openai-responses", "openai-completions"] })]}
				catalogModelIds={{ xai: ["grok-4"] }}
				existingIds={[]}
				onClose={vi.fn()}
				onSaveBuiltin={onSaveBuiltin}
				onSaveCustom={vi.fn(async () => ({ success: true }))}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "自定义设置" }));
		fireEvent.change(screen.getByPlaceholderText("提供方默认"), { target: { value: "https://proxy.invalid/v1" } });
		fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

		const listed = (await screen.findByText("已在目录中")).closest("label")!;
		const listedBox = listed.querySelector("input")!;
		expect(listed.textContent).toContain("grok-4");
		expect(listedBox.disabled).toBe(true);
		expect(listedBox.checked).toBe(false);
		const fresh = screen.getByText("grok-new").closest("label")!.querySelector("input")!;
		expect(fresh.checked).toBe(true);
		// 新模型排在已在目录里的前面
		expect(fresh.compareDocumentPosition(listedBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "添加 1 个" }));

		fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
		fireEvent.change(screen.getAllByPlaceholderText("模型 ID")[1], { target: { value: "grok-4" } });
		fireEvent.change(screen.getAllByPlaceholderText("显示名称（可选）")[1], { target: { value: "Grok Four" } });
		expect(screen.getByText(/与内置目录同 ID 的行只覆盖填写的字段/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(onSaveBuiltin).toHaveBeenCalledWith({
			providerId: "xai",
			apiKey: "",
			config: {
				baseUrl: "https://proxy.invalid/v1",
				models: [{ id: "grok-new", name: "Grok New" }],
				api: "openai-responses",
				modelOverrides: { "grok-4": { name: "Grok Four" } },
			},
		}));
	});
});

describe("ProviderSetupModal (custom mode): 自动识别", () => {
	it("URL 和密钥填完就自己去拉模型目录，并把容量与视觉一起填好", async () => {
		vi.useFakeTimers();
		const calls: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
			calls.push(String(url));
			expect(JSON.parse(String(init?.body)).action).toBe("discoverModels");
			return { ok: true, json: async () => ({ success: true, data: { models: [
				{ id: "auto-a", name: "A", contextWindow: 1_000_000, maxTokens: 32_000, vision: true },
				{ id: "auto-b", name: "B" },
			] } }) };
		}));
		render(
			<ProviderSetupModal mode="custom" providers={[]} existingIds={[]} onClose={vi.fn()}
				onSaveBuiltin={vi.fn(async () => ({ success: true }))} onSaveCustom={vi.fn(async () => ({ success: true }))} />,
		);
		// 还没填地址：不该有请求
		expect(calls).toHaveLength(0);
		fireEvent.change(screen.getByPlaceholderText("https://gateway.example/v1"), { target: { value: "https://gateway.example/v1" } });
		fireEvent.change(screen.getByPlaceholderText("输入 API 密钥，或留空使用环境认证"), { target: { value: "sk-test" } });
		await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
		expect(calls).toEqual(["/api/models"]);
		// 候选被自动采纳：容量与视觉来自端点
		expect(screen.getByDisplayValue("auto-a")).toBeTruthy();
		expect(screen.getByDisplayValue("auto-b")).toBeTruthy();
		expect(screen.getByText(/已自动识别 2 个模型/)).toBeTruthy();
		// auto-a 展开后能看到端点给的容量；auto-b 只填了 id/name
		fireEvent.click(screen.getAllByTitle("容量")[0]);
		expect(screen.getByDisplayValue("1M")).toBeTruthy();
		expect(screen.getByDisplayValue("32K")).toBeTruthy();
	});
});
