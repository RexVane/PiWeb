import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	refreshModelRuntime: vi.fn(),
	getModelRuntime: vi.fn(),
	applyContextWindow: vi.fn(),
}));
vi.mock("../src/lib/pi", () => ({
	getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
	refreshModelRuntime: mocks.refreshModelRuntime,
	getModelRuntime: mocks.getModelRuntime,
}));
vi.mock("../src/lib/agent-manager", () => ({
	reloadSessionsForCwd: vi.fn(),
	refreshSessionModels: vi.fn(),
	applyContextWindow: mocks.applyContextWindow,
}));

import { CustomProvidersValidationError, setModelContextWindow } from "../src/lib/models-service";

let agentDir: string;
let file: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-ctxwin-"));
	file = path.join(agentDir, "models.json");
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is forbidden"); }));
	mocks.refreshModelRuntime.mockReset().mockResolvedValue(undefined);
	mocks.getModelRuntime.mockReset().mockResolvedValue({ getModel: () => undefined });
	mocks.applyContextWindow.mockReset().mockResolvedValue(1);
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await fs.rm(agentDir, { recursive: true, force: true });
});

describe("setModelContextWindow", () => {
	it("writes a per-model override, keeps other fields, and applies it live", async () => {
		await fs.writeFile(file, JSON.stringify({ providers: { openai: { baseUrl: "https://example.test/v1", api: "openai-completions", models: [{ id: "gpt-5" }] } } }, null, 2));
		await setModelContextWindow("openai", "gpt-5", 200_000);
		const saved = JSON.parse(await fs.readFile(file, "utf8"));
		expect(saved.providers.openai.modelOverrides["gpt-5"]).toEqual({ contextWindow: 200_000 });
		expect(saved.providers.openai.models).toEqual([{ id: "gpt-5" }]);
		expect(mocks.refreshModelRuntime).toHaveBeenCalled();
		expect(mocks.applyContextWindow).toHaveBeenCalledWith("openai", "gpt-5", 200_000);
	});

	it("creates models.json when missing", async () => {
		await setModelContextWindow("anthropic", "claude-opus", 1_000_000);
		const saved = JSON.parse(await fs.readFile(file, "utf8"));
		expect(saved.providers.anthropic.modelOverrides["claude-opus"].contextWindow).toBe(1_000_000);
	});

	it("rejects an invalid window", async () => {
		await expect(setModelContextWindow("openai", "gpt-5", 0)).rejects.toBeInstanceOf(CustomProvidersValidationError);
		await expect(setModelContextWindow("openai", "gpt-5", 1.5)).rejects.toBeInstanceOf(CustomProvidersValidationError);
		await expect(setModelContextWindow("", "gpt-5", 128_000)).rejects.toBeInstanceOf(CustomProvidersValidationError);
	});
});
