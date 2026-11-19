// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ThinkingLevelEditor } from "@/components/ThinkingLevelEditor";
import { ModelsSection } from "@/components/settings/ModelsSection";
import { thinkingRowsToMap, type ThinkingLevelRow } from "@/lib/thinking-config";
import { TRANSLATIONS } from "@/i18n";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function Editor() {
	const [rows, setRows] = useState<ThinkingLevelRow[]>();
	return <ThinkingLevelEditor rows={rows} onChange={setRows} />;
}

it("adds low/low then medium/medium, prevents duplicate levels and supports custom API values", () => {
	render(<Editor />);
	fireEvent.click(screen.getByRole("button", { name: "添加档位" }));
	expect(screen.getByRole("textbox", { name: "API 参数值 1" })).toHaveProperty("value", "low");
	fireEvent.click(screen.getByRole("button", { name: "添加档位" }));
	expect(screen.getByRole("textbox", { name: "API 参数值 2" })).toHaveProperty("value", "medium");
	fireEvent.click(screen.getByRole("button", { name: "档位 2" }));
	expect(within(screen.getByRole("listbox")).getByRole("option", { name: "low" })).toHaveProperty("disabled", true);
	fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "high" }));
	expect(screen.getByRole("textbox", { name: "API 参数值 2" })).toHaveProperty("value", "high");
	fireEvent.change(screen.getByRole("textbox", { name: "API 参数值 2" }), { target: { value: "deep" } });
	fireEvent.click(screen.getByRole("button", { name: "档位 2" }));
	fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "max" }));
	expect(screen.getByRole("textbox", { name: "API 参数值 2" })).toHaveProperty("value", "deep");
	fireEvent.change(screen.getByRole("textbox", { name: "API 参数值 2" }), { target: { value: "" } });
	expect(screen.getByRole("alert").textContent).toContain("API 参数值不能为空");
	fireEvent.click(screen.getByRole("button", { name: "使用自动档位" }));
	expect(screen.queryByRole("textbox")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "添加档位" }));
	expect(screen.getByRole("textbox")).toHaveProperty("value", "low");
});

function setup(pending = false) {
	const posts: Array<Record<string, unknown>> = [];
	const configuredMap = thinkingRowsToMap([{ level: "high", value: "high" }]);
	const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return { ok: true, json: async () => ({ success: true }) }; }
		return { ok: true, json: async () => ({ success: true, data: {
			providers: [{ id: "custom", name: "Custom", builtIn: false, authReady: true, authConfigured: true, keyManaged: false, authTypes: ["api_key"], apis: ["openai-completions"], modelCount: 1 }],
			models: [{ provider: "custom", id: "m", reasoning: true, thinkingLevels: ["high"], thinkingProbePending: pending }],
			customProviders: { revision: "rev-1", secretProviderIds: [], content: JSON.stringify({ providers: { custom: { baseUrl: "https://models.invalid/v1", api: "openai-completions",
				models: [{ id: "m", name: "Model", input: ["text"], reasoning: true, contextWindow: 128000, maxTokens: 16000, thinkingLevelMap: configuredMap }] } } }) },
		} }) };
	});
	vi.stubGlobal("fetch", fetchMock); render(<ModelsSection />);
	return { fetchMock, posts };
}

it("removes per-model probe buttons and saves manual levels in the provider form", async () => {
	const { posts } = setup();
	await screen.findByText("Custom");
	expect(within(screen.getByTestId("thinking-probe")).queryByRole("button")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "编辑" }));
	fireEvent.click(screen.getByTitle(TRANSLATIONS.zh.capacityFields));
	fireEvent.click(screen.getByRole("button", { name: "添加档位" })); // existing high means first unused is low
	expect(screen.getByRole("textbox", { name: "API 参数值 2" })).toHaveProperty("value", "low");
	fireEvent.click(screen.getByRole("button", { name: "保存" }));
	await waitFor(() => expect(posts).toHaveLength(1));
	expect(posts[0].action).toBe("saveCustomProviders");
	const saved = JSON.parse(String(posts[0].content));
	expect(saved.providers.custom.models[0].thinkingLevelMap).toEqual(thinkingRowsToMap([{ level: "high", value: "high" }, { level: "low", value: "low" }]));
});

it("polls only while server-side thinking work is pending, without posting a manual probe", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const { posts, fetchMock } = setup(true);
	await screen.findByText("后台正在识别未配置的模型档位…");
	const reads = fetchMock.mock.calls.length;
	await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
	expect(fetchMock.mock.calls.length).toBeGreaterThan(reads);
	expect(posts).toHaveLength(0);
});
