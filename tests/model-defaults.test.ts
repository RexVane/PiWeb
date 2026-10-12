import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import type { ModelScopeRuntime } from "../src/lib/models/model-scope";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	resolveModelScopeWithDiagnostics: vi.fn(),
}));
vi.mock("../src/lib/pi", () => ({ getModelRuntime: vi.fn(), getSettingsManager: vi.fn() }));

import { DEFAULT_MODEL_PER_PROVIDER, pickInitialModel } from "../src/lib/model-defaults";

afterEach(() => {
	vi.mocked(resolveModelScopeWithDiagnostics).mockReset();
});

/** 只实现 pickInitialModel 用到的三个方法；作用域解析由上面的 mock 控制 */
function fakeRuntime(models: Array<{ provider: string; id: string }>, configured: string[]) {
	const all = models.map((m) => ({ ...m, name: m.id }));
	const runtime = {
		getModel: (provider: string, id: string) => all.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (provider: string) => configured.includes(provider),
		getAvailableSnapshot: () => all.filter((m) => configured.includes(m.provider)),
	};
	return runtime as unknown as ModelScopeRuntime;
}

describe("pi's default model table", () => {
	it("matches the installed SDK's defaultModelPerProvider entry by entry, in order", () => {
		// SDK 升级后这里会先红：照着新源码把 DEFAULT_MODEL_PER_PROVIDER 对上
		const source = readFileSync(path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js"), "utf8");
		const body = /export const defaultModelPerProvider = \{([\s\S]*?)\n\};/.exec(source)?.[1] ?? "";
		const pairs = [...body.matchAll(/^\s*"?([^":\s]+)"?:\s*"([^"]+)",?$/gm)].map((m) => [m[1], m[2]]);
		expect(pairs.length).toBeGreaterThan(40);
		expect(pairs).toEqual(Object.entries(DEFAULT_MODEL_PER_PROVIDER));
	});
});

describe("pickInitialModel follows pi's findInitialModel order", () => {
	it("takes the first enabled model in scope before anything else", async () => {
		const scoped = { provider: "openai", id: "gpt-5.5" };
		vi.mocked(resolveModelScopeWithDiagnostics).mockResolvedValueOnce({ scopedModels: [{ model: scoped as never }], diagnostics: [] });
		const runtime = fakeRuntime([scoped, { provider: "deepseek", id: "deepseek-v4-pro" }], ["openai", "deepseek"]);
		await expect(pickInitialModel(runtime, { patterns: ["openai/*"], defaultProvider: "deepseek", defaultModelId: "deepseek-v4-pro" }))
			.resolves.toBe(scoped);
	});

	it("uses the configured default model when it has credentials", async () => {
		const runtime = fakeRuntime([{ provider: "anthropic", id: "claude-opus-4-8" }, { provider: "deepseek", id: "deepseek-v4-pro" }], ["anthropic", "deepseek"]);
		await expect(pickInitialModel(runtime, { patterns: [], defaultProvider: "deepseek", defaultModelId: "deepseek-v4-pro" }))
			.resolves.toMatchObject({ provider: "deepseek", id: "deepseek-v4-pro" });
	});

	it("skips a configured default that has no credentials", async () => {
		const runtime = fakeRuntime([{ provider: "anthropic", id: "claude-opus-4-8" }, { provider: "deepseek", id: "deepseek-v4-pro" }], ["anthropic"]);
		await expect(pickInitialModel(runtime, { patterns: [], defaultProvider: "deepseek", defaultModelId: "deepseek-v4-pro" }))
			.resolves.toMatchObject({ provider: "anthropic", id: "claude-opus-4-8" });
	});

	it("walks pi's known-provider table order, not the order models were listed", async () => {
		// 表里 anthropic 排在 openai 前面，即使 openai 的模型先列出来也选 anthropic
		const runtime = fakeRuntime([{ provider: "openai", id: "gpt-5.5" }, { provider: "anthropic", id: "claude-opus-4-8" }], ["openai", "anthropic"]);
		await expect(pickInitialModel(runtime, { patterns: [] })).resolves.toMatchObject({ provider: "anthropic", id: "claude-opus-4-8" });
	});

	it("falls back to the first available model when no known default is available", async () => {
		const runtime = fakeRuntime([{ provider: "acme", id: "x-1" }, { provider: "acme", id: "x-2" }], ["acme"]);
		await expect(pickInitialModel(runtime, { patterns: [] })).resolves.toMatchObject({ provider: "acme", id: "x-1" });
	});

	it("returns nothing when no model has credentials", async () => {
		const runtime = fakeRuntime([{ provider: "anthropic", id: "claude-opus-4-8" }], []);
		await expect(pickInitialModel(runtime, { patterns: [] })).resolves.toBeUndefined();
	});
});
