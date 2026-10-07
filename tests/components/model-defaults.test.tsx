// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ModelSelector, type ModelChoice } from "@/components/ModelSelector";
import { SettingsPanel } from "@/components/SettingsPanel";
import type { ModelDefaults } from "@/lib/thinking";

vi.mock("@/lib/theme", () => ({ applyPebrelTheme: () => {}, loadPebrelTheme: () => "dsh", loadThemeMode: () => "system" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const levels = ["off", "minimal", "low", "medium", "high"];
const choices: ModelChoice[] = [
	{ provider: "p", id: "fast", name: "Fast", reasoning: true, thinkingLevels: levels, contextWindow: 1000 },
	{ provider: "p", id: "deep", name: "Deep", reasoning: true, thinkingLevels: levels, contextWindow: 1000 },
];

function selector(props: Partial<Parameters<typeof ModelSelector>[0]> = {}) {
	const onSaveDefault = vi.fn(async () => true);
	const defaults: ModelDefaults = { provider: "p", modelId: "fast", thinkingLevel: "low", modelThinkingLevels: { "p/deep": "minimal" } };
	render(
		<ModelSelector
			model={{ provider: "p", id: "deep", name: "Deep" }}
			thinkingLevel="high"
			thinkingLevels={levels}
			models={choices}
			providerNames={{ p: "Prov" }}
			authByProvider={{ p: true }}
			onSelectModel={vi.fn()}
			onSelectLevel={vi.fn()}
			defaults={defaults}
			onSaveDefault={onSaveDefault}
			{...props}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: /^Prov\/Deep/ }));
	return { onSaveDefault };
}

describe("model selector marks pi's defaults and saves new ones", () => {
	it("tags the default model and the level a new session would use, and saves the current pick", async () => {
		const { onSaveDefault } = selector();
		expect(within(screen.getByRole("menuitemradio", { name: /Fast/ })).getByText("默认")).toBeTruthy();
		expect(within(screen.getByRole("menuitemradio", { name: /Deep/ })).queryByText("默认")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
		await waitFor(() => expect(onSaveDefault).toHaveBeenCalledWith("p", "deep", "high"));

		// 思考子页：deep 有单独设置 minimal，优先于全局 low；每档带说明
		fireEvent.click(screen.getByRole("button", { name: /思考/ }));
		const minimal = screen.getByRole("menuitemradio", { name: /minimal/ });
		expect(within(minimal).getByText("默认")).toBeTruthy();
		expect(within(minimal).getByText("极简，约 1k tokens")).toBeTruthy();
		expect(within(screen.getByRole("menuitemradio", { name: /^low/ })).queryByText("默认")).toBeNull();
	});

	it("shows the pick as already default when model and level both match", () => {
		selector({ thinkingLevel: "minimal", defaults: { provider: "p", modelId: "deep", thinkingLevel: null, modelThinkingLevels: { "p/deep": "minimal" } } });
		expect(screen.queryByRole("button", { name: "设为默认" })).toBeNull();
		expect(screen.getByText("已是默认")).toBeTruthy();
	});

	it("does not send a level for a model that only has off", async () => {
		const { onSaveDefault } = selector({ thinkingLevel: "off", thinkingLevels: ["off"], defaults: null });
		fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
		await waitFor(() => expect(onSaveDefault).toHaveBeenCalledWith("p", "deep", undefined));
	});
});

/** SelectOption 的弹层挂在 body 末尾：同名的芯片在前、弹层选项在最后 */
const pickOption = (name: string) => fireEvent.click(screen.getAllByRole("button", { name }).at(-1)!);

type Settings = {
	thinking: { defaultLevel: string | null; modelLevels: Record<string, string>; budgets: Record<string, number> };
	defaultModel: { provider: string; modelId: string } | null;
};

/** 设置页 + 假后端：PUT 按 pi-settings 的语义合并（null 删除），返回合并后的设置 */
function settingsPage(initial: Settings) {
	let current = structuredClone(initial);
	const puts: unknown[] = [];
	const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
	const merge = (base: Record<string, unknown>, patch: Record<string, unknown> = {}) => {
		const out = { ...base };
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete out[key];
			else out[key] = value;
		}
		return out;
	};
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/models?custom=1") {
			return ok({
				providers: [
					{ id: "p", name: "Prov", builtIn: true, authReady: true, authConfigured: true, keyManaged: true, authTypes: ["api_key"], apis: [], modelCount: 2 },
					{ id: "x", name: "Locked", builtIn: true, authReady: false, authConfigured: false, keyManaged: false, authTypes: ["api_key"], apis: [], modelCount: 1 },
				],
				models: [
					{ provider: "p", id: "deep", name: "Deep", reasoning: true, thinkingLevels: levels },
					{ provider: "p", id: "plain", name: "Plain", reasoning: false, thinkingLevels: ["off"] },
					{ provider: "x", id: "locked", name: "Locked Model", reasoning: true, thinkingLevels: levels },
				],
				customProviders: { content: "{}", revision: "missing", secretProviderIds: [] },
			});
		}
		if (url === "/api/pi-settings") {
			if (init?.method === "PUT") {
				const patch = JSON.parse(String(init.body));
				puts.push(patch);
				if (patch.defaultModel !== undefined) current.defaultModel = patch.defaultModel;
				if (patch.thinking?.defaultLevel !== undefined) current.thinking.defaultLevel = patch.thinking.defaultLevel;
				current.thinking.modelLevels = merge(current.thinking.modelLevels, patch.thinking?.modelLevels) as Record<string, string>;
				current.thinking.budgets = merge(current.thinking.budgets, patch.thinking?.budgets) as Record<string, number>;
			}
			return ok({ compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, ...current });
		}
		if (url === "/api/security") return ok({ defaultProjectTrust: "ask" });
		if (url === "/api/version") return ok({ piWeb: "0.test", piEngine: "0.test" });
		if (url === "/api/web-auth") return ok({ enabled: false });
		throw new Error(`unexpected URL ${url}`);
	}));
	render(<SettingsPanel open cwd="/w" toolPreset="standard" onClose={vi.fn()} onToolPresetChange={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "模型" }));
	return { puts, current: () => current };
}

describe("settings → models: pi's default model, thinking level, per-model levels and budgets", () => {
	it("edits pi's own settings keys and only offers usable models", async () => {
		const { puts, current } = settingsPage({ thinking: { defaultLevel: null, modelLevels: { "p/gone": "high" }, budgets: { high: 30000 } }, defaultModel: { provider: "x", modelId: "locked" } });
		const block = await screen.findByRole("region", { name: "默认模型与思考强度" });
		const defaultModel = await within(block).findByRole("combobox", { name: "默认模型" }) as HTMLSelectElement;
		await waitFor(() => expect(defaultModel.value).toBe("x/locked"));
		// 没有凭证的提供商：当前默认标为不可用，其他模型不列出
		expect(within(defaultModel).getByRole("option", { name: "Locked Model · Locked（当前不可用）" })).toBeTruthy();
		expect(within(defaultModel).getAllByRole("option").map((option) => option.textContent)).toEqual(["未设置（pi 自动选择）", "Locked Model · Locked（当前不可用）", "Deep", "Plain"]);

		fireEvent.change(defaultModel, { target: { value: "p/deep" } });
		await waitFor(() => expect(puts).toContainEqual({ defaultModel: { provider: "p", modelId: "deep" } }));
		await waitFor(() => expect(defaultModel.value).toBe("p/deep"));

		fireEvent.click(within(block).getByRole("button", { name: "未设置（medium）" }));
		pickOption("high · 深入，约 16k tokens");
		await waitFor(() => expect(current().thinking.defaultLevel).toBe("high"));
		expect(puts).toContainEqual({ thinking: { defaultLevel: "high" } });

		// 不在目录里的旧条目照样能删；只有会思考的模型能加
		fireEvent.click(within(block).getByRole("button", { name: "移除 p/gone" }));
		await waitFor(() => expect(current().thinking.modelLevels).toEqual({}));
		await within(block).findByText("还没有单独设置的模型");
		const pick = within(block).getByRole("combobox", { name: "选择模型" }) as HTMLSelectElement;
		expect(within(pick).getAllByRole("option").map((option) => option.textContent)).toEqual(["选择模型", "Deep · Prov"]);
		fireEvent.change(pick, { target: { value: "p/deep" } });
		fireEvent.click(within(block).getByRole("button", { name: "添加" }));
		// 先填它现在会用的强度（全局默认 high）
		await waitFor(() => expect(current().thinking.modelLevels).toEqual({ "p/deep": "high" }));
		const row = await within(block).findByRole("group", { name: "Deep · Prov" });
		fireEvent.click(within(row).getByRole("button", { name: "high · 深入，约 16k tokens" }));
		pickOption("low · 轻度，约 2k tokens");
		await waitFor(() => expect(current().thinking.modelLevels).toEqual({ "p/deep": "low" }));
		expect(within(block).queryByRole("combobox", { name: "选择模型" })).toBeNull();

		const medium = within(block).getByRole("spinbutton", { name: "medium 的预算" }) as HTMLInputElement;
		const high = within(block).getByRole("spinbutton", { name: "high 的预算" }) as HTMLInputElement;
		expect(medium.placeholder).toBe("8192");
		expect(high.value).toBe("30000");
		fireEvent.change(medium, { target: { value: "12000" } });
		fireEvent.blur(medium);
		await waitFor(() => expect(current().thinking.budgets).toEqual({ high: 30000, medium: 12000 }));
		fireEvent.change(high, { target: { value: "" } });
		fireEvent.blur(high);
		await waitFor(() => expect(current().thinking.budgets).toEqual({ medium: 12000 }));
		const writes = puts.length;
		fireEvent.change(medium, { target: { value: "0" } });
		fireEvent.blur(medium);
		expect(await within(block).findByRole("alert")).toBeTruthy();
		expect(puts).toHaveLength(writes);

		fireEvent.change(defaultModel, { target: { value: "" } });
		await waitFor(() => expect(current().defaultModel).toBeNull());
	});
});
