/**
 * 上下文圆环里改窗口（重做 PR #27）：写在 pi 实际取值的那一层、与设置页共用校验，
 * 写完只给用这个模型的会话换新模型对象，不重载会话资源。
 * 用真实的 pi ModelRuntime 读临时目录里的 models.json，验证「写进去的值就是 pi 取到的值」。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	runtime: null as ModelRuntime | null,
	refreshSessionModels: vi.fn(() => 0),
	reloadSessionsForCwd: vi.fn(async () => 0),
}));
async function loadRuntime(): Promise<ModelRuntime> {
	mocks.runtime = await ModelRuntime.create({
		modelsPath: path.join(process.env.PI_CODING_AGENT_DIR!, "models.json"),
		refreshOnCreate: false, allowModelNetwork: false,
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
	});
	return mocks.runtime;
}
vi.mock("../src/lib/pi", () => ({
	getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
	getModelRuntime: async () => mocks.runtime ?? loadRuntime(),
	refreshModelRuntime: async () => { await loadRuntime(); },
	refreshModelRuntimeIfFilesChanged: async () => undefined,
	modelRuntimeVersion: () => 0,
}));
vi.mock("../src/lib/agent-manager", () => ({
	refreshSessionModels: mocks.refreshSessionModels,
	reloadSessionsForCwd: mocks.reloadSessionsForCwd,
}));

import { withContextWindow } from "../src/lib/model-draft";
import { contextWindowInfo, CustomProvidersValidationError, setModelContextWindow } from "../src/lib/models-service";
import { POST } from "../src/app/api/models/route";

/** pi 内置目录里的模型（原值 200000），用来验证 modelOverrides 那一层 */
const BUILTIN = { provider: "anthropic", id: "claude-haiku-4-5", window: 200_000 };

let agentDir: string;
let file: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-context-window-"));
	file = path.join(agentDir, "models.json");
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	mocks.runtime = null;
	mocks.refreshSessionModels.mockClear();
	mocks.reloadSessionsForCwd.mockClear();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fs.rm(agentDir, { recursive: true, force: true });
});

const readConfig = async () => JSON.parse(await fs.readFile(file, "utf8"));
const effective = async (provider: string, id: string) => (mocks.runtime ?? await loadRuntime()).getModel(provider, id)?.contextWindow;

describe("withContextWindow：写在 pi 实际取值的那一层", () => {
	it("models[] 定义的模型改那几条（同 ID 重复也都改），不另建覆盖；入参不变", () => {
		const input = { gw: { baseUrl: "http://x/v1", models: [{ id: "m", contextWindow: 1 }, { id: "other" }, { id: "m" }] } };
		const next = withContextWindow(input, "gw", "m", 64_000) as any;
		expect(next.gw.models.map((model: any) => model.contextWindow)).toEqual([64_000, undefined, 64_000]);
		expect(next.gw.modelOverrides).toBeUndefined();
		expect(input.gw.models[0].contextWindow).toBe(1);
	});

	it("已有覆盖写了窗口就改覆盖（它压过 models[]，只改 models[] 不生效）", () => {
		const next = withContextWindow({ gw: { models: [{ id: "m", contextWindow: 1 }], modelOverrides: { m: { contextWindow: 2, maxTokens: 9 } } } }, "gw", "m", 3) as any;
		expect(next.gw.modelOverrides.m).toEqual({ contextWindow: 3, maxTokens: 9 });
		expect(next.gw.models[0].contextWindow).toBe(1);
	});

	it("其余模型写 modelOverrides，同一条覆盖的其它字段保留；没有这个 provider 就新建", () => {
		expect(withContextWindow({ anthropic: { modelOverrides: { x: { maxTokens: 8 } } } }, "anthropic", "x", 5)).toEqual({ anthropic: { modelOverrides: { x: { maxTokens: 8, contextWindow: 5 } } } });
		expect(withContextWindow({}, "anthropic", "x", 5)).toEqual({ anthropic: { modelOverrides: { x: { contextWindow: 5 } } } });
	});
});

describe("setModelContextWindow", () => {
	it("内置模型：写进 modelOverrides，pi 取到新值，内置原值照样给出；只换绑会话不重载", async () => {
		expect(await contextWindowInfo(BUILTIN.provider, BUILTIN.id)).toEqual({ contextWindow: BUILTIN.window, builtin: BUILTIN.window });
		const info = await setModelContextWindow(BUILTIN.provider, BUILTIN.id, 128_000);
		expect(info).toEqual({ contextWindow: 128_000, builtin: BUILTIN.window });
		expect(await readConfig()).toEqual({ providers: { anthropic: { modelOverrides: { "claude-haiku-4-5": { contextWindow: 128_000 } } } } });
		expect(await effective(BUILTIN.provider, BUILTIN.id)).toBe(128_000);
		expect(mocks.refreshSessionModels).toHaveBeenCalledWith(BUILTIN.provider, BUILTIN.id);
		expect(mocks.reloadSessionsForCwd).not.toHaveBeenCalled();
		expect((await fs.readdir(agentDir)).sort()).toEqual(["models.json"]);
	});

	it("自定义模型：改 models[] 那一条，密钥和其它字段原样保留，没有内置原值", async () => {
		await fs.writeFile(file, JSON.stringify({ opaque: { keep: 1 }, providers: { gw: { baseUrl: "https://gw.test/v1", api: "openai-completions", apiKey: "sk-keep", models: [{ id: "m", maxTokens: 4096 }] } } }));
		const info = await setModelContextWindow("gw", "m", 64_000);
		expect(info).toEqual({ contextWindow: 64_000, builtin: null });
		const saved = await readConfig();
		expect(saved.opaque).toEqual({ keep: 1 });
		expect(saved.providers.gw).toEqual({ baseUrl: "https://gw.test/v1", api: "openai-completions", apiKey: "sk-keep", models: [{ id: "m", maxTokens: 4096, contextWindow: 64_000 }] });
		expect(await effective("gw", "m")).toBe(64_000);
	});

	it("已有覆盖压着 models[] 时改覆盖，pi 取到的确实变了", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { gw: { baseUrl: "https://gw.test/v1", api: "openai-completions", apiKey: "k", models: [{ id: "m", contextWindow: 10_000 }], modelOverrides: { m: { contextWindow: 20_000 } } } } }));
		expect(await effective("gw", "m")).toBe(20_000);
		await setModelContextWindow("gw", "m", 30_000);
		expect(await effective("gw", "m")).toBe(30_000);
		expect((await readConfig()).providers.gw.models[0].contextWindow).toBe(10_000);
	});

	it("目录里没有的模型、非正整数都拒绝，文件不动", async () => {
		await expect(setModelContextWindow("anthropic", "no-such-model", 1000)).rejects.toBeInstanceOf(CustomProvidersValidationError);
		for (const bad of [0, -1, 1.5, Number.NaN]) {
			await expect(setModelContextWindow(BUILTIN.provider, BUILTIN.id, bad)).rejects.toBeInstanceOf(CustomProvidersValidationError);
		}
		await expect(fs.access(file)).rejects.toThrow();
		expect(mocks.refreshSessionModels).not.toHaveBeenCalled();
	});
});

describe("/api/models 的窗口动作", () => {
	const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

	it("查询给当前值与内置原值；保存回生效值；缺字段 400，校验失败 400", async () => {
		const info = await post({ action: "contextWindowInfo", providerId: BUILTIN.provider, modelId: BUILTIN.id });
		expect(await info.json()).toEqual({ success: true, data: { contextWindow: BUILTIN.window, builtin: BUILTIN.window } });

		const saved = await post({ action: "setContextWindow", providerId: BUILTIN.provider, modelId: BUILTIN.id, contextWindow: 100_000 });
		expect(await saved.json()).toEqual({ success: true, data: { contextWindow: 100_000, builtin: BUILTIN.window } });

		expect((await post({ action: "setContextWindow", providerId: BUILTIN.provider, contextWindow: 1 })).status).toBe(400);
		expect((await post({ action: "setContextWindow", providerId: BUILTIN.provider, modelId: BUILTIN.id })).status).toBe(400);
		expect((await post({ action: "setContextWindow", providerId: BUILTIN.provider, modelId: BUILTIN.id, contextWindow: 0 })).status).toBe(400);
	});
});
