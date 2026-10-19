// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const originalModel = { id: "test-model", name: "Test model", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16000,
	compat: { supportsDeveloperRole: false }, thinkingLevelMap: { high: "deep" }, headers: { "x-model": "test" }, cost: { input: 1, output: 2 } };
const providerConfig = () => ({ name: "Gateway", baseUrl: "https://gateway.invalid", api: "openai-responses", headers: { "x-test": "opaque" }, oauth: { flow: "device" },
	compat: { providerOption: true }, future: { nested: ["preserved"] }, models: [structuredClone(originalModel), { id: "delete-me", reasoning: false }] });

function setup({ builtin = false, conflict = false, catalog, extraProviders = [], models }: {
	builtin?: boolean; conflict?: boolean; catalog?: Record<string, string[]>; extraProviders?: object[]; models?: object[];
} = {}) {
	let saved = { schemaVersion: "future-1", providers: { gateway: { ...providerConfig(), ...(models ? { models } : {}) } } };
	let revision = "rev-1";
	const writes: Array<{ action: string; content: string; revision: string }> = [];
	const keys: Array<{ providerId: string; apiKey: string }> = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/models?custom=1") return response({
			providers: [{ id: "gateway", name: "Gateway", builtIn: builtin, authReady: true, authConfigured: true, keyManaged: false, authTypes: ["api_key"], apis: ["openai-completions"], modelCount: 2 }, ...extraProviders],
			customProviders: { content: JSON.stringify(saved), revision, secretProviderIds: ["gateway"] },
			...(catalog ? { catalogModelIds: catalog } : {}),
		});
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

	it("体检卡片能补推理字段：只差 reasoning 的模型选「支持」后就能保存，卡片随即消失", async () => {
		// 回归：以前卡片没有推理列，只差 reasoning 的模型三格都显示已填，保存按钮却一直灰着
		const flash = { id: "flash", contextWindow: 1_000_000, maxTokens: 32_000, input: ["text", "image"] };
		const { writes, saved } = setup({ models: [flash] });
		const audit = await screen.findByTestId("model-audit");
		expect(within(audit).getByText("1 个模型没写能力字段")).toBeTruthy();
		expect((within(audit).getByRole("button", { name: "填好后保存" }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(within(audit).getByRole("radio", { name: "支持" }));
		expect(within(audit).getByRole("radio", { name: "支持" }).getAttribute("aria-checked")).toBe("true");
		fireEvent.click(within(audit).getByRole("button", { name: "保存 1 个模型" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(saved().providers.gateway.models).toEqual([{ ...flash, reasoning: true }]);
		await waitFor(() => expect(screen.queryByTestId("model-audit")).toBeNull());
	});

	it("体检卡片的「推理一起设」把所有缺推理的模型设成不支持，再点一下单个按钮可以取消", async () => {
		const { writes, saved } = setup({ models: [{ id: "a", contextWindow: 1000, maxTokens: 100, input: ["text"] }, { id: "b", contextWindow: 1000, maxTokens: 100, input: ["text"] }] });
		const audit = await screen.findByTestId("model-audit");
		fireEvent.click(within(audit).getByRole("button", { name: "都不支持推理" }));
		const offs = within(audit).getAllByRole("radio", { name: "不支持" });
		expect(offs.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "true"]);
		fireEvent.click(offs[1]);
		expect(offs[1].getAttribute("aria-checked")).toBe("false");
		fireEvent.click(within(audit).getByRole("button", { name: "保存 1 个模型" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(saved().providers.gateway.models).toEqual([
			{ id: "a", contextWindow: 1000, maxTokens: 100, input: ["text"], reasoning: false },
			{ id: "b", contextWindow: 1000, maxTokens: 100, input: ["text"] },
		]);
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
