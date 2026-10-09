import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

vi.mock("../../../src/lib/growth/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

let root: string;
let cwd: string;
let agentDir: string;
let manager: typeof import("../../../src/lib/agent/agent-manager");
let models: typeof import("../../../src/lib/models/models-service");
let target: Awaited<ReturnType<typeof ModelRuntime.create>> extends { getModels(provider?: string): readonly (infer M)[] } ? M : never;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-model-refresh-"));
	cwd = path.join(root, "workspace");
	agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	// 内置的、能思考的模型（优先 xAI，与用户现场一致）
	const builtin = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const all = builtin.getProviders().flatMap((provider) => builtin.getModels(provider.id));
	target = (all.find((model) => model.provider === "xai" && model.reasoning) ?? all.find((model) => model.reasoning))!;
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "always", compaction: { enabled: false },
		defaultProvider: target.provider, defaultModel: target.id, defaultThinkingLevel: "max",
	}));
	// 退化条目：只写 id 的同 ID 模型整条替换了内置定义（pi 升级前手动加的）
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { [target.provider]: { api: target.api, apiKey: "test-only", models: [{ id: target.id }] } },
	}));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in model refresh regression"); }));
	vi.resetModules();
	manager = await import("../../../src/lib/agent/agent-manager");
	models = await import("../../../src/lib/models/models-service");
}, 90_000);

afterAll(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await fs.rm(root, { recursive: true, force: true });
});

describe("saving models.json refreshes open sessions", () => {
	it("swaps the live session's model for the new definition and re-derives its thinking level", async () => {
		const { sessionPath } = await manager.createNewSession(cwd);
		const m = manager.getManaged(sessionPath);
		try {
			const session = await manager.ensureSession(m);
			expect(session.model).toMatchObject({ provider: target.provider, id: target.id, reasoning: false });
			expect(session.getAvailableThinkingLevels()).toEqual(["off"]);
			expect(session.thinkingLevel).toBe("off");

			const events: Array<{ type: string; thinkingLevel?: string; thinkingLevels?: string[] }> = [];
			expect(manager.subscribe(m, (_seq, json) => events.push(JSON.parse(json)), m.seq)).toBe(true);
			// 删掉退化条目（密钥由服务端原样补回）→ 回到内置定义
			await models.writeCustomProviders(JSON.stringify({ providers: { [target.provider]: {} } }));

			const levels = getSupportedThinkingLevels(target);
			const expectedLevel = clampThinkingLevel(target, "max");
			expect(m.session).toBe(session);
			expect(session.model).toMatchObject({ id: target.id, reasoning: true, contextWindow: target.contextWindow });
			expect(session.getAvailableThinkingLevels()).toEqual(levels);
			expect(session.thinkingLevel).toBe(expectedLevel);
			expect(events.filter((event) => event.type === "model").at(-1)).toMatchObject({ thinkingLevel: expectedLevel, thinkingLevels: levels });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			manager.disposeSession(m);
		}
	}, 90_000);
});
