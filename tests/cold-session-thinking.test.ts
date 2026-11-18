import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recycleFixture } from "./fixtures/recycle";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

vi.mock("../src/lib/models-service", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/models-service")>();
	return {
		...actual,
		listWorkspaceModelsForPiWeb: async (cwd: string) => {
			const result = await actual.listWorkspaceModelsForPiWeb(cwd);
			const template = result.models[0];
			if (!template) return result;
			return {
				...result,
				models: [
					...result.models,
					{
						...template,
						provider: "minimax-code",
						id: "MiniMax-M3.1-Flash",
						name: "MiniMax-M3.1-Flash",
						reasoning: true,
						thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
					},
					{
						...template,
						provider: "limited-provider",
						id: "Limited-Model",
						name: "Limited Model",
						reasoning: true,
						thinkingLevels: ["off", "low"],
					},
				],
			};
		},
	};
});

let root: string;
let cwd: string;
let manager: typeof import("../src/lib/agent-manager");

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-cold-thinking-"));
	cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.resetModules();
	manager = await import("../src/lib/agent-manager");
}, 90_000);

afterAll(async () => {
	vi.unstubAllEnvs();
	await recycleFixture(root);
});

describe("cold session thinking level clamping", () => {
	it("preserves xhigh and max on cold setThinkingLevel and setModel when listed in ModelView.thinkingLevels", async () => {
		const { sessionPath } = await manager.createNewSession(cwd, {
			provider: "minimax-code",
			modelId: "MiniMax-M3.1-Flash",
			thinking: "max",
		});
		const m = manager.getManaged(sessionPath);
		try {
			expect(m.session).toBeNull();
			expect((await manager.buildSnapshot(m)).thinkingLevel).toBe("max");

			expect(await manager.execute(m, { cmd: "setThinkingLevel", level: "xhigh" })).toEqual({
				ok: true,
				data: { requested: "xhigh", thinkingLevel: "xhigh", clamped: false },
			});
			expect((await manager.buildSnapshot(m)).thinkingLevel).toBe("xhigh");

			expect(await manager.execute(m, { cmd: "setThinkingLevel", level: "max" })).toEqual({
				ok: true,
				data: { requested: "max", thinkingLevel: "max", clamped: false },
			});
			expect((await manager.buildSnapshot(m)).thinkingLevel).toBe("max");

			expect(await manager.execute(m, { cmd: "setThinkingLevel", level: "minimal" })).toEqual({
				ok: true,
				data: { requested: "minimal", thinkingLevel: "low", clamped: true },
			});

			expect(await manager.execute(m, { cmd: "setThinkingLevel", level: "max" })).toEqual({
				ok: true,
				data: { requested: "max", thinkingLevel: "max", clamped: false },
			});

			expect(await manager.execute(m, {
				cmd: "setModel", provider: "minimax-code", modelId: "MiniMax-M3.1-Flash", fresh: false,
			})).toEqual({
				ok: true,
				data: { thinkingLevel: "max", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
			});

			expect(await manager.execute(m, {
				cmd: "setModel", provider: "limited-provider", modelId: "Limited-Model", fresh: true,
			})).toEqual({
				ok: true,
				data: { thinkingLevel: "low", thinkingLevels: ["off", "low"] },
			});
		} finally {
			await manager.disposeSession(m);
		}
	}, 60_000);
});
