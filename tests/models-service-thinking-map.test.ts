/**
 * 思考档位映射的写入路径（探测报告确认后走的就是这条）：
 * 与 setModelContextWindow 同一套分层与原子写入——真实 pi ModelRuntime 读临时
 * models.json，验证「写进去的 thinkingLevelMap 就是 pi 计算档位时用的那份」。
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

import { withThinkingLevelMap } from "../src/lib/model-draft";
import { CustomProvidersValidationError, setModelThinkingLevelMap } from "../src/lib/models-service";
import { POST } from "../src/app/api/models/route";

let agentDir: string;
let file: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-thinking-map-"));
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
const levels = async (provider: string, id: string) => (mocks.runtime ?? await loadRuntime()).getModel(provider, id);

describe("withThinkingLevelMap：与 withContextWindow 同一条分层", () => {
	it("models[] 定义的模型改那几条，不另建覆盖；入参不变", () => {
		const input = { gw: { baseUrl: "http://x/v1", models: [{ id: "m", reasoning: true }, { id: "other" }, { id: "m" }] } };
		const map = { off: "none", low: "low", max: null };
		const next = withThinkingLevelMap(input, "gw", "m", map) as any;
		expect(next.gw.models.map((model: any) => model.thinkingLevelMap)).toEqual([map, undefined, map]);
		expect(next.gw.modelOverrides).toBeUndefined();
		expect((input as any).gw.models[0].thinkingLevelMap).toBeUndefined();
	});

	it("已有覆盖写了 thinkingLevelMap 就改覆盖；只改 models[] 不生效", () => {
		const next = withThinkingLevelMap({ gw: { models: [{ id: "m" }], modelOverrides: { m: { thinkingLevelMap: { high: "high" }, maxTokens: 9 } } } }, "gw", "m", { high: "high", max: null }) as any;
		expect(next.gw.modelOverrides.m).toEqual({ thinkingLevelMap: { high: "high", max: null }, maxTokens: 9 });
		expect(next.gw.models[0].thinkingLevelMap).toBeUndefined();
	});

	it("其余模型写 modelOverrides，同一条覆盖的其它字段保留；没有 provider 就新建", () => {
		expect(withThinkingLevelMap({ anthropic: { modelOverrides: { x: { maxTokens: 8 } } } }, "anthropic", "x", { low: "low" }))
			.toEqual({ anthropic: { modelOverrides: { x: { maxTokens: 8, thinkingLevelMap: { low: "low" } } } } });
		expect(withThinkingLevelMap({}, "anthropic", "x", {})).toEqual({ anthropic: { modelOverrides: { x: { thinkingLevelMap: {} } } } });
	});
});

describe("setModelThinkingLevelMap", () => {
	it("自定义模型：写进 models[]，pi 取到的档位随之变化，密钥和其它字段原样保留", async () => {
		await fs.writeFile(file, JSON.stringify({ opaque: { keep: 1 }, providers: { gw: { baseUrl: "https://gw.test/v1", api: "openai-completions", apiKey: "sk-keep", models: [{ id: "m", reasoning: true, maxTokens: 4096 }] } } }));
		const before = await levels("gw", "m");
		expect(before?.reasoning).toBe(true);
		const info = await setModelThinkingLevelMap("gw", "m", { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: "high", max: "max" });
		expect(info.thinkingLevels).toEqual(["off", "low", "high", "xhigh", "max"]);
		const saved = await readConfig();
		expect(saved.opaque).toEqual({ keep: 1 });
		expect(saved.providers.gw.apiKey).toBe("sk-keep");
		expect(saved.providers.gw.models[0].thinkingLevelMap).toEqual({ off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: "high", max: "max" });
		expect(mocks.refreshSessionModels).toHaveBeenCalledWith("gw", "m");
		expect(mocks.reloadSessionsForCwd).not.toHaveBeenCalled();
	});

	it("目录里没有的模型拒绝；不合法的映射拒绝且文件不动", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { gw: { baseUrl: "https://gw.test/v1", api: "openai-completions", models: [{ id: "m", reasoning: true }] } } }));
		await expect(setModelThinkingLevelMap("gw", "no-such", { low: "low" })).rejects.toBeInstanceOf(CustomProvidersValidationError);
		await expect(setModelThinkingLevelMap("gw", "m", { bogus: "x" } as Record<string, string | null>)).rejects.toBeInstanceOf(CustomProvidersValidationError);
		await expect(setModelThinkingLevelMap("gw", "m", { low: 3 } as unknown as Record<string, string | null>)).rejects.toBeInstanceOf(CustomProvidersValidationError);
		expect((await readConfig()).providers.gw.models[0].thinkingLevelMap).toBeUndefined();
		expect(mocks.refreshSessionModels).not.toHaveBeenCalled();
	});
});

describe("/api/models 的 thinkingLevelMap 动作", () => {
	const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

	it("写入回 pi 支持的档位；缺字段 400，映射不合法 400", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { gw: { baseUrl: "https://gw.test/v1", api: "openai-completions", models: [{ id: "m", reasoning: true }] } } }));
		const saved = await post({ action: "setThinkingLevelMap", providerId: "gw", modelId: "m", thinkingLevelMap: { off: "none", low: "low", max: null } });
		const payload = await saved.json();
		expect(payload.success).toBe(true);
		expect(payload.data.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect((await readConfig()).providers.gw.models[0].thinkingLevelMap).toEqual({ off: "none", low: "low", max: null });

		expect((await post({ action: "setThinkingLevelMap", providerId: "gw", thinkingLevelMap: {} })).status).toBe(400);
		expect((await post({ action: "setThinkingLevelMap", providerId: "gw", modelId: "m" })).status).toBe(400);
		expect((await post({ action: "setThinkingLevelMap", providerId: "gw", modelId: "m", thinkingLevelMap: { bogus: "x" } })).status).toBe(400);
	});
});
