// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/theme")>()),
	applyPebrelTheme: () => {},
	loadPebrelTheme: () => "dsh",
	loadThemeMode: () => "system",
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const originalModel = { id: "test-model", name: "Test model", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16000,
	compat: { supportsDeveloperRole: false }, thinkingLevelMap: { high: "deep" }, headers: { "x-model": "test" }, cost: { input: 1, output: 2 } };
const providerConfig = () => ({ name: "Gateway", baseUrl: "https://gateway.invalid", api: "openai-responses", headers: { "x-test": "opaque" }, oauth: { flow: "device" },
	compat: { providerOption: true }, future: { nested: ["preserved"] }, models: [structuredClone(originalModel), { id: "delete-me", reasoning: false }] });

function setup({ builtin = false, conflict = false, catalog, extraProviders = [], auditOnly = false, auditMissing = false, refreshFailure = false, outputOnly = false, reorderOnConflict = false,
	autoResolve = false, unresolved = false, resolutionFailure = false, resolutionDelay, onModelsChanged }: {
	builtin?: boolean; conflict?: boolean; catalog?: Record<string, string[]>; extraProviders?: object[]; auditOnly?: boolean; auditMissing?: boolean; refreshFailure?: boolean; outputOnly?: boolean; reorderOnConflict?: boolean;
	autoResolve?: boolean; unresolved?: boolean; resolutionFailure?: boolean; resolutionDelay?: Promise<void>;
	onModelsChanged?: () => void | Promise<void>;
} = {}) {
	let saved = { schemaVersion: "future-1", providers: { gateway: providerConfig() } };
	if (auditOnly || auditMissing || outputOnly) {
		const undeclared = structuredClone(originalModel);
		if (!outputOnly) Reflect.deleteProperty(undeclared, "reasoning");
		if (auditMissing) for (const field of ["contextWindow", "maxTokens", "input"]) Reflect.deleteProperty(undeclared, field);
		if (outputOnly) Reflect.deleteProperty(undeclared, "maxTokens");
		saved.providers.gateway.models = [structuredClone(originalModel), { ...undeclared, id: "undeclared" }];
		if (reorderOnConflict) saved.providers.gateway.models[0] = { ...undeclared, id: "other" };
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
			capabilityResolutionAvailable: autoResolve,
			...(catalog ? { catalogModelIds: catalog } : {}),
			});
		}
		if (url === "/api/models") {
			const body = JSON.parse(String(init?.body));
			if (body.action === "resolveCapabilities") {
				await resolutionDelay;
				if (resolutionFailure) return { ok: false, status: 503, json: async () => ({ success: false, error: "offline" }) };
				if (!unresolved) {
					Object.assign(saved.providers.gateway.models[1], { contextWindow: 256000, maxTokens: 32000, input: ["text"], reasoning: true });
					revision = "rev-auto";
				}
				return response({ filled: unresolved ? 0 : 1, customProviders: { content: JSON.stringify(saved), revision, secretProviderIds: ["gateway"] } });
			}
			if (body.action === "setKey") {
				keys.push(body);
				return response({});
			}
			if (body.action === "loginState") return response({ prompt: null, notifyLog: [], done: true });
			if (body.action !== "saveCustomProviders") throw new Error("unexpected action");
			writes.push(body);
			if (reorderOnConflict && writes.length === 1) {
				saved.providers.gateway.models.reverse();
				revision = "rev-2";
				return { ok: false, status: 409, json: async () => ({ success: false, error: "Model configuration changed; reload before saving." }) };
			}
			if (conflict) return { ok: false, status: 409, json: async () => ({ success: false, error: "Model configuration changed; reload before saving." }) };
			saved = JSON.parse(body.content);
			revision = "rev-2";
			return response({ requiresSessionReopen: false });
		}
		if (url === "/api/pi-settings") return response({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } });
		if (url === "/api/version") return response({ piWeb: "0.test", piEngine: "0.test" });
		if (url === "/api/web-auth") return response({ enabled: false });
		throw new Error(`unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	const panelProps = { onClose: vi.fn(), onModelsChanged };
	const mounted = render(<SettingsPanel open {...panelProps} />);
	fireEvent.click(screen.getByRole("button", { name: "模型" }));
	return { writes, keys, fetchMock, mounted, panelProps, saved: () => saved };
}
function response(data: unknown) { return { ok: true, status: 200, json: async () => ({ success: true, data }) }; }
async function edit() { fireEvent.click(await screen.findByRole("button", { name: "编辑" })); }

describe("SettingsPanel model round trip and revision", () => {
	it("hides manual fields while detecting and keeps persisted automatic capabilities after reopening", async () => {
		let finish!: () => void;
		const resolutionDelay = new Promise<void>((resolve) => { finish = resolve; });
		const { saved, fetchMock } = setup({ auditMissing: true, autoResolve: true, resolutionDelay });
		await screen.findByTestId("model-capabilities-pending");
		await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes("resolveCapabilities"))).toBe(true));
		expect(screen.queryByTestId("model-audit")).toBeNull();
		await act(async () => finish());
		await screen.findByRole("button", { name: "编辑" });
		expect(screen.queryByTestId("model-audit")).toBeNull();
		expect(saved().providers.gateway.models[1]).toMatchObject({ contextWindow: 256000, maxTokens: 32000, reasoning: true });
		cleanup();
		render(<SettingsPanel open onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "模型" }));
		await screen.findByRole("button", { name: "编辑" });
		expect(screen.queryByTestId("model-audit")).toBeNull();
		expect(fetchMock.mock.calls.filter(([, init]) => String(init?.body).includes("resolveCapabilities"))).toHaveLength(1);
	});

	it("does not expose manual gaps when a second catalog load overlaps detection", async () => {
		let finish!: () => void;
		const resolutionDelay = new Promise<void>((resolve) => { finish = resolve; });
		const { mounted, fetchMock } = setup({ auditMissing: true, autoResolve: true, resolutionDelay });
		await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => String(init?.body).includes("resolveCapabilities"))).toHaveLength(1));
		mounted.rerender(<SettingsPanel open onClose={vi.fn()} onModelsChanged={vi.fn()} />);
		await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => String(init?.body).includes("resolveCapabilities"))).toHaveLength(2));
		expect(screen.queryByTestId("model-audit")).toBeNull();
		await act(async () => finish());
		await screen.findByRole("button", { name: "编辑" });
		expect(screen.queryByTestId("model-audit")).toBeNull();
	});

	it.each([false, true])("offers manual input only after unknown/offline detection settles (failure=%s)", async (resolutionFailure) => {
		const { writes, saved } = setup({ auditMissing: true, autoResolve: true, unresolved: true, resolutionFailure });
		fireEvent.change(await screen.findByRole("textbox", { name: "undeclared 上下文" }), { target: { value: "512K" } });
		expect(screen.queryByTestId("model-capabilities-pending")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "使用默认值并保存" }));
		await waitFor(() => expect(screen.queryByTestId("model-audit")).toBeNull());
		expect(writes).toHaveLength(1);
		expect(saved().providers.gateway.models[1]).toMatchObject({ contextWindow: 512000, maxTokens: 16384 });
	});

	it("refreshes the outer catalog after saving without rendering a persistent apply-session banner", async () => {
		const onModelsChanged = vi.fn();
		setup({ onModelsChanged });
		await edit();
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存" })));
		expect(onModelsChanged).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("button", { name: "应用到当前会话" })).toBeNull();
		expect(screen.queryByText(/应用到当前会话|重新打开会话/)).toBeNull();
	});

	it("retains the saved configuration and shows an error alert when the outer catalog refresh fails", async () => {
		const onModelsChanged = vi.fn().mockRejectedValueOnce(new Error("catalog offline")).mockResolvedValueOnce(undefined);
		const { saved } = setup({ onModelsChanged });
		await edit();
		fireEvent.change(screen.getByDisplayValue("Gateway"), { target: { value: "Saved gateway" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		expect((await screen.findByRole("alert")).textContent).toContain("配置已保存，但模型目录刷新失败：catalog offline");
		await waitFor(() => expect(screen.queryByDisplayValue("Saved gateway")).toBeNull());
		expect(saved().providers.gateway.name).toBe("Saved gateway");
		expect(screen.queryByRole("button", { name: "应用到当前会话" })).toBeNull();

		// A subsequent successful save clears the stale catalog error alert.
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(onModelsChanged).toHaveBeenCalledTimes(2));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it.each(["__proto__", "gateway?bad", "existing"])("edits display name %s without renaming or overwriting the provider identity", async (id) => {
		const { writes, saved } = setup({ extraProviders: [{ id: "existing", name: "Existing", builtIn: true, authReady: false, modelCount: 0 }] });
		await edit();
		fireEvent.change(screen.getByPlaceholderText("gateway"), { target: { value: id } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(Object.keys(saved().providers)).toEqual(["gateway"]);
		expect(saved().providers.gateway.name).toBe(id);
	});
	it("lets the user save the current default output once without changing already configured capabilities", async () => {
		const { saved, writes } = setup({ outputOnly: true });
		const useDefaults = await screen.findByRole("button", { name: "使用默认值并保存" });
		expect(screen.getByText(/这些是默认设置，不是模型官方能力上限/)).toBeTruthy();
		expect(writes).toHaveLength(0);
		fireEvent.click(useDefaults);
		await waitFor(() => expect(screen.queryByTestId("model-audit")).toBeNull());
		expect(saved().providers.gateway.models).toEqual([originalModel, { ...originalModel, id: "undeclared", maxTokens: 16384 }]);
		cleanup();
		render(<SettingsPanel open onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "模型" }));
		await screen.findByRole("button", { name: "编辑" });
		expect(screen.queryByTestId("model-audit")).toBeNull();
	});

	it("keeps entered values when default completion fills the remaining fields", async () => {
		const { saved } = setup({ auditMissing: true });
		fireEvent.change(await screen.findByRole("textbox", { name: "undeclared 上下文" }), { target: { value: "256K" } });
		fireEvent.click(screen.getByRole("checkbox", { name: "undeclared 图片" }));
		fireEvent.click(screen.getByRole("button", { name: "使用默认值并保存" }));
		await waitFor(() => expect(screen.queryByTestId("model-audit")).toBeNull());
		expect(saved().providers.gateway.models[1]).toMatchObject({ contextWindow: 256000, maxTokens: 16384, input: ["text", "image"], reasoning: false });
	});

	it("retains drafts by model identity after a conflicting save reloads a reordered configuration", async () => {
		const { saved, writes } = setup({ auditMissing: true, reorderOnConflict: true });
		fireEvent.change(await screen.findByRole("textbox", { name: "undeclared 输出上限" }), { target: { value: "32K" } });
		fireEvent.click(screen.getByRole("button", { name: "保存 1 个模型" }));
		await screen.findByText("Model configuration changed; reload before saving.");
		await waitFor(() => expect(saved().providers.gateway.models[0].id).toBe("undeclared"));
		expect((screen.getByRole("textbox", { name: "undeclared 输出上限" }) as HTMLInputElement).value).toBe("32K");
		expect((screen.getByRole("textbox", { name: "other 输出上限" }) as HTMLInputElement).value).toBe("");
		fireEvent.click(screen.getByRole("button", { name: "保存 1 个模型" }));
		await waitFor(() => expect(screen.queryByRole("textbox", { name: "undeclared 输出上限" })).toBeNull());
		expect(writes).toHaveLength(2);
		expect(writes[1].revision).toBe("rev-2");
		expect(saved().providers.gateway.models[0]).toMatchObject({ id: "undeclared", maxTokens: 32000 });
		expect(saved().providers.gateway.models[1]).not.toHaveProperty("maxTokens");
	});

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
		render(<SettingsPanel open onClose={vi.fn()} />);
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
		const onModelsChanged = vi.fn();
		const { writes } = setup({ conflict: true, onModelsChanged });
		await edit();
		fireEvent.change(screen.getByDisplayValue("test-model"), { target: { value: "keep-conflicting-draft" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await screen.findByText("Model configuration changed; reload before saving.");
		expect(screen.getByDisplayValue("keep-conflicting-draft")).toBeTruthy();
		expect(writes).toHaveLength(1);
		expect(writes[0].revision).toBe("rev-1");
		expect(onModelsChanged).not.toHaveBeenCalled();
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
