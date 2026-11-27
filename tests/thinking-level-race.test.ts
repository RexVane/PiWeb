import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { recycleFixture } from "./fixtures/recycle";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

let root: string;
let cwd: string;
let manager: typeof import("../src/lib/agent-manager");
let pi: typeof import("../src/lib/pi");

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-thinking-race-"));
	cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "xai",
		defaultModel: "grok-4.7",
		defaultThinkingLevel: "xhigh",
		defaultProjectTrust: "always",
	}));
	await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({
		xai: { type: "api_key", key: "test-xai-key" },
	}));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			xai: {
				api: "openai-responses",
				baseUrl: "https://models.invalid/v1",
				apiKey: "test-xai-key",
				models: [
					{
						id: "grok-4.7",
						name: "Grok 4.7",
						reasoning: true,
						thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
					},
					{
						id: "grok-4.7-fast",
						name: "Grok 4.7 Fast",
						reasoning: true,
						thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
					},
				],
			},
		},
	}));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.resetModules();
	pi = await import("../src/lib/pi");
	manager = await import("../src/lib/agent-manager");
}, 90_000);

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	vi.unstubAllEnvs();
	await recycleFixture(root);
});

describe("thinking-level race prevention in agent-manager", () => {
	it("serializes cold setThinkingLevel before prompt and preserves low across cold-to-hot startup", async () => {
		const sm = pi.SessionManager.create(cwd);
		sm.appendModelChange("xai", "grok-4.7");
		sm.appendThinkingLevelChange("xhigh");
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "previous turn" }], timestamp: 1000 });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous reply" }],
			api: "openai-responses",
			provider: "xai",
			model: "grok-4.7",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 2000,
		});
		const sessionPath = sm.getSessionFile()!;
		const m = manager.getManaged(sessionPath);
		const events: Array<{ type: string; thinkingLevel?: string }> = [];
		const stopObserving = manager.observeManagedEvents(m, (evt) => {
			if (evt.type === "model") events.push({ type: evt.type, thinkingLevel: evt.thinkingLevel });
		});

		try {
			const modelsService = await import("../src/lib/models-service");
			const originalList = modelsService.listWorkspaceModelsForPiWeb;
			let releaseCatalog!: () => void;
			const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
			vi.spyOn(modelsService, "listWorkspaceModelsForPiWeb").mockImplementationOnce(async (targetCwd) => {
				await catalogGate;
				return originalList(targetCwd);
			});

			const setLevelPromise = manager.execute(m, { cmd: "setThinkingLevel", level: "low" });
			const promptPromise = manager.execute(m, { cmd: "prompt", text: "hello grok" });

			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(m.creating).toBeNull();
			expect(m.session).toBeNull();

			releaseCatalog();
			const [levelResult, promptResult] = await Promise.all([setLevelPromise, promptPromise]);
			expect(levelResult).toEqual({
				ok: true,
				data: { requested: "low", thinkingLevel: "low", clamped: false },
			});
			expect(promptResult.ok).toBe(true);
			expect(m.session?.thinkingLevel).toBe("low");
			expect(events.map((e) => e.thinkingLevel)).not.toContain("xhigh");
		} finally {
			stopObserving();
			await manager.disposeSession(m);
		}
	}, 60_000);

	it("captures cold snapshot seq before async lookups so concurrent setThinkingLevel is replayed", async () => {
		const { sessionPath } = await manager.createNewSession(cwd, {
			provider: "xai",
			modelId: "grok-4.7",
			thinking: "xhigh",
		});
		const m = manager.getManaged(sessionPath);

		try {
			const workspaceStore = await import("../src/lib/workspace-store");
			const originalCanonical = workspaceStore.canonicalWorkspacePath;
			let releaseCanonical!: () => void;
			const canonicalGate = new Promise<void>((resolve) => { releaseCanonical = resolve; });
			vi.spyOn(workspaceStore, "canonicalWorkspacePath").mockImplementationOnce(async (targetCwd) => {
				await canonicalGate;
				return originalCanonical(targetCwd);
			});

			const snapPromise = manager.buildSnapshot(m);
			await new Promise((resolve) => setTimeout(resolve, 20));
			const levelResult = await manager.execute(m, { cmd: "setThinkingLevel", level: "low" });
			expect(levelResult).toEqual({ ok: true, data: { requested: "low", thinkingLevel: "low", clamped: false } });

			releaseCanonical();
			const snap = await snapPromise;
			expect(snap.seq).toBeLessThan(m.seq);
			expect(snap.thinkingLevel).toBe("xhigh");

			const replayed: string[] = [];
			expect(manager.subscribe(m, (_seq, json) => { replayed.push(json); }, snap.seq)).toBe(true);
			expect(replayed.some((frame) => JSON.parse(frame).type === "model" && JSON.parse(frame).thinkingLevel === "low")).toBe(true);
		} finally {
			await manager.disposeSession(m);
		}
	}, 60_000);

	it("does not emit transient xhigh thinkingLevel during setModel when desiredThinkingLevel is low", async () => {
		const { sessionPath } = await manager.createNewSession(cwd, {
			provider: "xai",
			modelId: "grok-4.7",
			thinking: "low",
		});
		const m = manager.getManaged(sessionPath);
		const publishedLevels: Array<string | undefined> = [];
		const stopObserving = manager.observeManagedEvents(m, (evt) => {
			if (evt.type === "model") publishedLevels.push(evt.thinkingLevel);
		});

		try {
			await manager.ensureSession(m);
			publishedLevels.length = 0;

			const switched = await manager.execute(m, { cmd: "setModel", provider: "xai", modelId: "grok-4.7-fast" });
			expect(switched.ok).toBe(true);
			expect(switched.data?.thinkingLevel).toBe("low");
			expect(publishedLevels).toEqual(["low"]);
			expect(m.session?.thinkingLevel).toBe("low");
		} finally {
			stopObserving();
			await manager.disposeSession(m);
		}
	}, 60_000);

	it("preserves desiredThinkingLevel when cold session has existing messages and ensuresession starts", async () => {
		const sm = pi.SessionManager.create(cwd);
		sm.appendModelChange("xai", "grok-4.7");
		sm.appendThinkingLevelChange("xhigh");
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "msg" }], timestamp: 1000 });
		const sessionPath = sm.getSessionFile()!;
		const m = manager.getManaged(sessionPath);
		m.desiredThinkingLevel = "low";

		try {
			const session = await manager.ensureSession(m);
			expect(session.thinkingLevel).toBe("low");
		} finally {
			await manager.disposeSession(m);
		}
	}, 60_000);
});
