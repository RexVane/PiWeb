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

function setup({ builtin = false, conflict = false } = {}) {
	let saved = { schemaVersion: "future-1", providers: { gateway: providerConfig() } };
	let revision = "rev-1";
	const writes: Array<{ action: string; content: string; revision: string }> = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/models?custom=1") return response({ providers: [{ id: "gateway", name: "Gateway", builtIn: builtin, authReady: true, authConfigured: true, keyManaged: false, authTypes: ["api_key"], apis: ["openai-completions"], modelCount: 2 }], customProviders: { content: JSON.stringify(saved), revision, secretProviderIds: ["gateway"] } });
		if (url === "/api/models") {
			const body = JSON.parse(String(init?.body));
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
	return { writes, fetchMock, saved: () => saved };
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
});
