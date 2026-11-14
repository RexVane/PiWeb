// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ModelsSection } from "@/components/settings/ModelsSection";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
const failure = (status: number, error: string) => ({ ok: false, status, json: async () => ({ success: false, error }) });
const model = { id: "test-model", input: ["text"], reasoning: false, contextWindow: 32000, maxTokens: 4000 };

function configured({ builtin = false, conflict = false, removeFails = false } = {}) {
	let revision = "rev-1", reads = 0;
	let config: Record<string, unknown> = { gateway: { baseUrl: "https://gateway.example/v1", api: "openai-completions", name: "Gateway", models: [model] } };
	const actions: Array<Record<string, any>> = [];
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/models?custom=1") { reads++; return response({ providers: [{ id: "gateway", name: "Gateway", builtIn: builtin, authReady: true, authConfigured: true, keyManaged: true, authTypes: ["api_key"], apis: ["openai-completions"], modelCount: 1 }], customProviders: { content: JSON.stringify({ providers: config }), revision, secretProviderIds: ["gateway"] } }); }
		const body = JSON.parse(String(init?.body)); actions.push(body);
		if (body.action === "saveCustomProviders") {
			if (conflict && actions.filter((entry) => entry.action === "saveCustomProviders").length === 1) { revision = "rev-2"; return failure(409, "configuration changed"); }
			config = JSON.parse(body.content).providers; revision = "rev-3"; return response({});
		}
		if (body.action === "removeKey") return removeFails ? failure(500, "credential removal failed") : response({});
		throw new Error("unexpected request");
	});
	vi.stubGlobal("fetch", fetch); render(<ModelsSection />);
	return { actions, reads: () => reads };
}

it("reloads a conflict and lets a fresh edit save with the new revision", async () => {
	const { actions, reads } = configured({ conflict: true });
	fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
	fireEvent.change(screen.getByDisplayValue("Gateway"), { target: { value: "unsaved draft" } });
	fireEvent.click(screen.getByRole("button", { name: "保存" }));
	await screen.findByText("configuration changed");
	expect(reads()).toBe(2); expect(screen.getByDisplayValue("unsaved draft")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "取消" }));
	fireEvent.click(screen.getByRole("button", { name: "编辑" }));
	fireEvent.click(screen.getByRole("button", { name: "保存" }));
	await waitFor(() => expect(actions).toHaveLength(2));
	expect(actions[1].revision).toBe("rev-2");
});

it("retains credentials if deleting the provider configuration conflicts", async () => {
	const { actions, reads } = configured({ builtin: true, conflict: true });
	fireEvent.click(await screen.findByRole("button", { name: "删除" }));
	fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
	await screen.findByText("configuration changed");
	expect(actions.map((entry) => entry.action)).toEqual(["saveCustomProviders"]); expect(reads()).toBe(2);
});

it("shows a credential removal failure after configuration was removed", async () => {
	const { actions } = configured({ builtin: true, removeFails: true });
	fireEvent.click(await screen.findByRole("button", { name: "删除" }));
	fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
	await screen.findByText(/提供方设置已删除，但凭证未删除：credential removal failed/);
	expect(actions.map((entry) => entry.action)).toEqual(["saveCustomProviders", "removeKey"]);
	expect(screen.getByText("Gateway")).toBeTruthy();
});

it("waits for a key-login acknowledgment before polling and surfaces terminal failure", async () => {
	let acknowledge!: (value: ReturnType<typeof response>) => void;
	const start = new Promise<ReturnType<typeof response>>((resolve) => { acknowledge = resolve; });
	const actions: string[] = [];
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/models?custom=1") return response({ providers: [{ id: "deepseek", name: "DeepSeek", builtIn: true, authReady: false, authConfigured: false, keyManaged: false, authTypes: ["api_key"], apis: ["openai-completions"], modelCount: 1 }], customProviders: { content: '{"providers":{}}', revision: "rev-1", secretProviderIds: [] } });
		const { action } = JSON.parse(String(init?.body)); actions.push(action);
		if (action === "setKey") return start;
		if (action === "loginState") return response({ done: true, prompt: null, notifyLog: [], error: "authentication failed" });
		throw new Error("unexpected request");
	}));
	render(<ModelsSection />);
	fireEvent.click(await screen.findByRole("button", { name: "添加提供方" }));
	fireEvent.change(await screen.findByPlaceholderText("输入 API 密钥，或留空使用环境认证"), { target: { value: "test-key" } });
	fireEvent.click(screen.getByRole("button", { name: "保存" }));
	await waitFor(() => expect(actions).toEqual(["setKey"]));
	await act(async () => acknowledge(response({ accepted: true, done: false })));
	await screen.findByText("authentication failed");
	expect(actions).toEqual(["setKey", "loginState"]);
});

it("does not automatically probe usage for command-backed credentials", async () => {
	const actions: string[] = [];
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/models?custom=1") return response({ providers: [{ id: "deepseek", name: "DeepSeek", builtIn: true, authReady: true, authConfigured: true, authCommand: true, keyManaged: true, authTypes: ["api_key"], apis: ["openai-completions"], modelCount: 1 }], customProviders: { content: '{"providers":{}}', revision: "rev-1", secretProviderIds: [] } });
		actions.push(JSON.parse(String(init?.body)).action); return response({});
	}));
	render(<ModelsSection />); await screen.findByRole("button", { name: "编辑" });
	expect(actions).toEqual([]);
});
