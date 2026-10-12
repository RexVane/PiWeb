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

describe("ProviderSetupModal (custom mode): 保存", () => {
	it("容量和视觉没填就不写，交给 pi 的缺省，不替用户猜 1M / 32K", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
		const onSaveCustom = vi.fn(async () => ({ success: true }));
		render(
			<ProviderSetupModal mode="custom" providers={[]} existingIds={[]} onClose={vi.fn()}
				onSaveBuiltin={vi.fn(async () => ({ success: true }))} onSaveCustom={onSaveCustom} />,
		);
		fireEvent.change(screen.getByPlaceholderText("acme-gateway"), { target: { value: "acme" } });
		fireEvent.change(screen.getByPlaceholderText("https://gateway.example/v1"), { target: { value: "https://gateway.example/v1" } });
		fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
		fireEvent.change(screen.getByPlaceholderText("模型 ID"), { target: { value: "m1" } });
		fireEvent.click(screen.getByRole("button", { name: "创建提供方" }));
		await waitFor(() => expect(onSaveCustom).toHaveBeenCalledWith({
			providerId: "acme",
			config: { name: "acme", baseUrl: "https://gateway.example/v1", api: "openai-completions", models: [{ id: "m1" }] },
		}));
	});
});

describe("ProviderSetupModal (custom mode): 自动识别", () => {
	const URL_PLACEHOLDER = "https://gateway.example/v1";
	const KEY_PLACEHOLDER = "输入 API 密钥，或留空使用环境认证";

	/** fetch 桩：每次请求挂起，测试按顺序手动放行，模拟慢端点和乱序返回 */
	function deferredDiscovery() {
		const pending: { body: { action: string; baseUrl: string; apiKey: string }; resolve: (models: object[]) => void }[] = [];
		vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((resolve) => {
			pending.push({
				body: JSON.parse(String(init?.body)),
				resolve: (models) => resolve({ ok: true, json: async () => ({ success: true, data: { models } }) }),
			});
		})));
		return pending;
	}

	function renderCustom(onSaveCustom = vi.fn(async () => ({ success: true }))) {
		render(
			<ProviderSetupModal mode="custom" providers={[]} existingIds={[]} onClose={vi.fn()}
				onSaveBuiltin={vi.fn(async () => ({ success: true }))} onSaveCustom={onSaveCustom} />,
		);
		return onSaveCustom;
	}

	it("打字时不发请求，地址 / 密钥失焦才拉一次；端点报的容量照填，没报的留空", async () => {
		const pending = deferredDiscovery();
		const onSaveCustom = renderCustom();
		fireEvent.change(screen.getByPlaceholderText("acme-gateway"), { target: { value: "acme" } });
		const url = screen.getByPlaceholderText(URL_PLACEHOLDER);
		const key = screen.getByPlaceholderText(KEY_PLACEHOLDER);
		fireEvent.change(url, { target: { value: "https://gate" } });
		fireEvent.change(url, { target: { value: URL_PLACEHOLDER } });
		// 只填了地址（公网、还没密钥）就失焦：不该拿空密钥去试
		fireEvent.blur(url);
		fireEvent.change(key, { target: { value: "sk-te" } });
		fireEvent.change(key, { target: { value: "sk-test" } });
		expect(pending).toHaveLength(0);
		fireEvent.blur(key);
		expect(pending.map((call) => call.body)).toEqual([expect.objectContaining({ action: "discoverModels", baseUrl: URL_PLACEHOLDER, apiKey: "sk-test" })]);
		// 同一组地址 + 密钥再失焦：不重复请求
		fireEvent.blur(url);
		expect(pending).toHaveLength(1);

		await act(async () => pending[0].resolve([
			{ id: "auto-a", name: "A", contextWindow: 1_000_000, maxTokens: 32_000, vision: true },
			{ id: "auto-b", name: "B" },
		]));
		expect(screen.getByDisplayValue("auto-a")).toBeTruthy();
		expect(screen.getByDisplayValue("auto-b")).toBeTruthy();
		expect(screen.getByText(/已自动识别 2 个模型/)).toBeTruthy();
		fireEvent.click(screen.getAllByTitle("容量")[0]);
		expect(screen.getByDisplayValue("1M")).toBeTruthy();
		expect(screen.getByDisplayValue("32K")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "创建提供方" }));
		await waitFor(() => expect(onSaveCustom).toHaveBeenCalledWith({
			providerId: "acme",
			config: {
				name: "acme", baseUrl: URL_PLACEHOLDER, api: "openai-completions", apiKey: "sk-test",
				models: [{ id: "auto-a", name: "A", contextWindow: 1_000_000, maxTokens: 32_000, input: ["text", "image"] }, { id: "auto-b", name: "B" }],
			},
		}));
	});

	it("地址改了，旧地址迟到的结果直接丢掉，不会把别家的模型塞进来", async () => {
		const pending = deferredDiscovery();
		renderCustom();
		const url = screen.getByPlaceholderText(URL_PLACEHOLDER);
		fireEvent.change(screen.getByPlaceholderText(KEY_PLACEHOLDER), { target: { value: "sk-test" } });
		fireEvent.change(url, { target: { value: "https://old.example/v1" } });
		fireEvent.blur(url);
		expect(screen.getByText(/正在自动识别模型/)).toBeTruthy();
		// 还没失焦就改了地址：在路上的那次作废
		fireEvent.change(url, { target: { value: "https://new.example/v1" } });
		expect(screen.queryByText(/正在自动识别模型/)).toBeNull();
		fireEvent.blur(url);
		expect(pending.map((call) => call.body.baseUrl)).toEqual(["https://old.example/v1", "https://new.example/v1"]);

		await act(async () => pending[0].resolve([{ id: "old-model" }]));
		expect(screen.queryByDisplayValue("old-model")).toBeNull();
		expect(screen.getByText(/正在自动识别模型/)).toBeTruthy();
		await act(async () => pending[1].resolve([{ id: "new-model" }]));
		expect(screen.getByDisplayValue("new-model")).toBeTruthy();
		expect(screen.queryByDisplayValue("old-model")).toBeNull();
	});

	it("自动采纳后把模型行都删了，再失焦也不会自己加回来", async () => {
		const pending = deferredDiscovery();
		renderCustom();
		const url = screen.getByPlaceholderText(URL_PLACEHOLDER);
		fireEvent.change(url, { target: { value: "http://127.0.0.1:11434/v1" } });
		// 本机地址不要求密钥，并自动允许访问私网
		fireEvent.blur(url);
		expect(pending[0].body).toEqual(expect.objectContaining({ baseUrl: "http://127.0.0.1:11434/v1", allowPrivate: true }));
		await act(async () => pending[0].resolve([{ id: "llama" }]));
		fireEvent.click(screen.getByTitle("删除"));
		expect(screen.queryByDisplayValue("llama")).toBeNull();
		fireEvent.blur(url);
		expect(pending).toHaveLength(1);
	});
});
