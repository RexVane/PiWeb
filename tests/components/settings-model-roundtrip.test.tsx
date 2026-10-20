// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const originalModel = { id: "test-model", name: "Test model", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16000,
	compat: { supportsDeveloperRole: false }, thinkingLevelMap: { high: "deep" }, headers: { "x-model": "test" }, cost: { input: 1, output: 2 } };
const providerConfig = () => ({ name: "Gateway", baseUrl: "https://gateway.invalid", api: "openai-responses", headers: { "x-test": "opaque" }, oauth: { flow: "device" },
	compat: { providerOption: true }, future: { nested: ["preserved"] }, models: [structuredClone(originalModel), { id: "delete-me", reasoning: false }] });

function setup({ builtin = false, conflict = false, catalog, extraProviders = [], auditOnly = false, auditMissing = false, refreshFailure = false }: {
	builtin?: boolean; conflict?: boolean; catalog?: Record<string, string[]>; extraProviders?: object[]; auditOnly?: boolean; auditMissing?: boolean; refreshFailure?: boolean;
} = {}) {
	let saved = { schemaVersion: "future-1", providers: { gateway: providerConfig() } };
	if (auditOnly || auditMissing) {
		const undeclared = structuredClone(originalModel);
		Reflect.deleteProperty(undeclared, "reasoning");
		if (auditMissing) for (const field of ["contextWindow", "maxTokens", "input"]) Reflect.deleteProperty(undeclared, field);
		saved.providers.gateway.models = [structuredClone(originalModel), { ...undeclared, id: "undeclared" }];
	}
	let revision = "rev-1";
	const writes: Array<{ action: string; content: string; revision: string }> = [];
	const keys: Array<{ providerId: string; apiKey: string }> = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/models?custom=1") {
			if (refreshFailure && writes.length) return { ok: false, status: 503, json: async () => ({ success: false, error: "temporary refresh failure" }) };
			return response({
			providers: [{ id: "gateway", name: "Gateway", builtIn: builtin, authReady: true, authConfigured: true, keyManaged: false, authTypes: ["api_key"], apis: ["openai-completions"], modelCount: 2 }, ...extraProviders],
			customProviders: { content: JSON.stringify(saved), revision, secretProviderIds: ["gateway"] },
			...(catalog ? { catalogModelIds: catalog } : {}),
			});
		}
		if (url === "/api/models") {
			const body = JSON.parse(String(init?.body));
			if (body.action === "setKey") {
				keys.push(body);
				return response({});
			}
			if (body.action === "loginState") return response({ prompt: null, notifyLog: [], done: true });
			if (body.action !== "saveCustomProviders") throw new Error("unexpected action");
			writes.push(body);
			if (conflict) return { ok: false, status: 409, json: async () => ({ success: false, error: "Model configuration changed; reload before saving." }) };
			saved = JSON.parse(body.content);
			revision = "rev-2";
			return response({});
		}
		if (url === "/api/pi-settings") return response({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } });
		if (url === "/api/security") return response({ defaultProjectTrust: "ask" });
		if (url === "/api/version") return response({ piWeb: "0.test", piEngine: "0.test" });
		if (url === "/api/web-auth") return response({ enabled: false });
		throw new Error(`unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	render(<SettingsPanel open cwd="/test-workspace" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "模型" }));
	return { writes, keys, fetchMock, saved: () => saved };
}
function response(data: unknown) { return { ok: true, status: 200, json: async () => ({ success: true, data }) }; }
async function edit() { fireEvent.click(await screen.findByRole("button", { name: "编辑" })); }

describe("SettingsPanel model round trip and revision", () => {
	it("shows the remaining fields after saving capacities, and explicit text-only completion survives reopening", async () => {
		const { saved } = setup({ auditMissing: true });
		fireEvent.change(await screen.findByRole("textbox", { name: "undeclared 上下文" }), { target: { value: "256K" } });
		fireEvent.change(screen.getByRole("textbox", { name: "undeclared 输出上限" }), { target: { value: "32K" } });
		fireEvent.click(screen.getByRole("button", { name: "保存 1 个模型" }));
		await waitFor(() => expect(screen.queryByRole("textbox", { name: "undeclared 上下文" })).toBeNull());
		expect(saved().providers.gateway.models[1]).toMatchObject({ contextWindow: 256000, maxTokens: 32000 });
		expect(screen.getByText("仍需补充：视觉、推理")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "undeclared 确认纯文本" }));
		fireEvent.change(screen.getByRole("combobox", { name: "undeclared 推理" }), { target: { value: "off" } });
		fireEvent.click(screen.getByRole("button", { name: "保存 1 个模型" }));
		await waitFor(() => expect(screen.queryByTestId("model-audit")).toBeNull());
		expect(saved().providers.gateway.models[1]).toMatchObject({ contextWindow: 256000, maxTokens: 32000, input: ["text"], reasoning: false });
		cleanup();
		render(<SettingsPanel open cwd="/test-workspace" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "模型" }));
		await screen.findByRole("button", { name: "编辑" });
		expect(screen.queryByTestId("model-audit")).toBeNull();
	});

	it("retains confirmed saved values when refreshing the model list fails", async () => {
		const { saved } = setup({ auditMissing: true, refreshFailure: true });
		fireEvent.change(await screen.findByRole("textbox", { name: "undeclared 上下文" }), { target: { value: "256K" } });
		fireEvent.change(screen.getByRole("textbox", { name: "undeclared 输出上限" }), { target: { value: "32K" } });
		fireEvent.click(screen.getByRole("checkbox", { name: "undeclared 图片" }));
		fireEvent.change(screen.getByRole("combobox", { name: "undeclared 推理" }), { target: { value: "on" } });
		fireEvent.click(screen.getByRole("button", { name: "保存 1 个模型" }));
		await screen.findByText("temporary refresh failure");
		expect(saved().providers.gateway.models[1]).toMatchObject({ contextWindow: 256000, maxTokens: 32000, input: ["text", "image"], reasoning: true });
		expect(screen.queryByTestId("model-audit")).toBeNull();
	});

	it.each([false, true])("prevents an older provider draft from deleting saved capabilities (builtin=%s)", async (builtin) => {
		const { writes, saved } = setup({ auditOnly: true, builtin });
		await edit();
		if (builtin) fireEvent.click(screen.getByRole("button", { name: "自定义设置" }));
		fireEvent.change(screen.getByRole("combobox", { name: "undeclared 推理" }), { target: { value: "off" } });
		fireEvent.click(screen.getByRole("button", { name: "保存 1 个模型" }));
		await waitFor(() => expect(screen.queryByTestId("model-audit")).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
		await screen.findByText("模型配置已变更，请取消后重新编辑，避免覆盖已保存的参数。");
		expect(writes).toHaveLength(1);
		expect(saved().providers.gateway.models[1].reasoning).toBe(false);
	});

	it.each([["on", true], ["off", false]])("fills an otherwise complete model's missing reasoning with %s", async (choice, expected) => {
		const { writes, saved } = setup({ auditOnly: true });
		const select = await screen.findByRole("combobox", { name: "undeclared 推理" });
		expect((screen.getByRole("button", { name: "填好后保存" }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(select, { target: { value: choice } });
		fireEvent.click(screen.getByRole("button", { name: /保存.*1|1.*保存/ }));
		await waitFor(() => expect(writes).toHaveLength(1));
		await waitFor(() => expect(screen.queryByTestId("model-audit")).toBeNull());
		expect(saved().providers.gateway.models).toEqual([originalModel, { ...originalModel, id: "undeclared", reasoning: expected }]);
		expect(writes[0].revision).toBe("rev-1");
	});

	it("saves only edited fields, retains opaque model/provider options and refreshes revision", async () => {
		const { writes, saved, fetchMock } = setup();
		await edit();
		fireEvent.change(screen.getByDisplayValue("Gateway"), { target: { value: "Renamed gateway" } });
		fireEvent.change(screen.getByDisplayValue("test-model"), { target: { value: "new-id" } });
		fireEvent.click(screen.getAllByTitle("删除")[1]);
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(screen.queryByDisplayValue("new-id")).toBeNull());
		expect(writes[0].revision).toBe("rev-1");
		expect(saved()).toEqual({ schemaVersion: "future-1", providers: { gateway: { ...providerConfig(), name: "Renamed gateway", models: [{ ...originalModel, id: "new-id" }] } } });
		expect(saved().providers.gateway).not.toHaveProperty("apiKey");
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(writes).toHaveLength(2));
		expect(writes[1].revision).toBe("rev-2");
		expect(fetchMock.mock.calls.some(([url]) => url === "/api/version")).toBe(true);
		expect(fetchMock.mock.calls.some(([url]) => url === "/api/health")).toBe(false);
	});

	it("keeps a conflicting edit visible and does not retry without its revision", async () => {
		const { writes } = setup({ conflict: true });
		await edit();
		fireEvent.change(screen.getByDisplayValue("test-model"), { target: { value: "keep-conflicting-draft" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await screen.findByText("Model configuration changed; reload before saving.");
		expect(screen.getByDisplayValue("keep-conflicting-draft")).toBeTruthy();
		expect(writes).toHaveLength(1);
		expect(writes[0].revision).toBe("rev-1");
	});

	it("allows deleting all builtin overrides without dropping headers, OAuth, or API", async () => {
		const { writes, saved } = setup({ builtin: true });
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "自定义设置" }));
		fireEvent.change(screen.getByDisplayValue("https://gateway.invalid"), { target: { value: "" } });
		while (screen.queryAllByTitle("删除").length) fireEvent.click(screen.getAllByTitle("删除")[0]);
		const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
		expect(save.disabled).toBe(false);
		fireEvent.click(save);
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(saved().providers.gateway.models).toEqual([]);
		expect(saved().providers.gateway).not.toHaveProperty("baseUrl");
		expect(saved().providers.gateway.api).toBe("openai-responses");
		expect(saved().providers.gateway.oauth).toEqual({ flow: "device" });
		expect(saved().providers.gateway.headers).toEqual({ "x-test": "opaque" });
	});

	it("writes edits of built-in catalog models as modelOverrides instead of redefining them in models[]", async () => {
		// 回归：同 ID 的 models[] 会让 SDK 用默认值整条重建内置模型（丢 reasoning / 上下文 / 价格 / 思考档位）
		const { writes, saved } = setup({ builtin: true, catalog: { gateway: ["test-model"] } });
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "自定义设置" }));
		expect(screen.getByText(/与内置目录同 ID 的行只覆盖填写的字段/)).toBeTruthy();
		fireEvent.change(screen.getByDisplayValue("Test model"), { target: { value: "Renamed" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		const overridden: Record<string, unknown> = { ...originalModel };
		delete overridden.id;
		expect(saved().providers.gateway.models).toEqual([{ id: "delete-me", reasoning: false }]);
		expect((saved().providers.gateway as Record<string, unknown>).modelOverrides).toEqual({ "test-model": { ...overridden, name: "Renamed" } });
	});

	it("adds a built-in provider with only an API key without writing an empty models.json entry", async () => {
		// SDK 不认空条目（must specify baseUrl / models / …），以前这一步整次保存失败、密钥也没存上
		const { writes, keys } = setup({ extraProviders: [{ id: "deepseek", name: "DeepSeek", builtIn: true, authReady: false, authConfigured: false, keyManaged: false, authTypes: ["api_key"], apis: ["openai-completions"], modelCount: 2 }] });
		fireEvent.click(await screen.findByRole("button", { name: "添加提供方" }));
		fireEvent.change(await screen.findByPlaceholderText("输入 API 密钥，或留空使用环境认证"), { target: { value: "sk-test" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(keys).toEqual([expect.objectContaining({ action: "setKey", providerId: "deepseek", apiKey: "sk-test" })]));
		expect(writes).toHaveLength(0);
	});
});
