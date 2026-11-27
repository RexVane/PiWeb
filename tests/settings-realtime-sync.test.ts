import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { recycleGeneratedFixture } from "./fixtures/system-trash";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

let root: string;
let agentDir: string;
let pi: typeof import("../src/lib/pi");
let manager: typeof import("../src/lib/agent-manager");
let fingerprintMod: typeof import("../src/lib/resource-fingerprint");
let defaultsRoute: typeof import("../src/app/api/models/defaults/route");
let resourcesRoute: typeof import("../src/app/api/agent/resources/route");
let eventsRoute: typeof import("../src/app/api/agent/[id]/events/route");

const managed: Array<ReturnType<typeof import("../src/lib/agent-manager")["getManaged"]>> = [];

async function writeJson(file: string, data: unknown) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function writeText(file: string, content: string) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
}

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-realtime-"));
	agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await writeJson(path.join(agentDir, "models.json"), {
		providers: {
			"test-provider": {
				baseUrl: "https://test.invalid/v1",
				api: "openai-completions",
				apiKey: "test-key",
				models: [
					{
						id: "reasoner-1",
						name: "Reasoner 1",
						reasoning: true,
						input: ["text"],
						contextWindow: 16384,
						maxTokens: 2048,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	});
	await writeJson(path.join(agentDir, "settings.json"), {
		defaultProjectTrust: "always",
		defaultProvider: "test-provider",
		defaultModel: "reasoner-1",
		defaultThinkingLevel: "low",
		compaction: { enabled: false },
	});
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("HOME", path.join(root, "home"));
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in settings realtime sync test"); }));
	vi.resetModules();
	pi = await import("../src/lib/pi");
	manager = await import("../src/lib/agent-manager");
	fingerprintMod = await import("../src/lib/resource-fingerprint");
	defaultsRoute = await import("../src/app/api/models/defaults/route");
	resourcesRoute = await import("../src/app/api/agent/resources/route");
	eventsRoute = await import("../src/app/api/agent/[id]/events/route");
}, 90_000);

afterEach(async () => {
	for (const session of managed.splice(0)) {
		await manager.disposeSession(session).catch(() => undefined);
	}
	fingerprintMod.stopAllResourceWatchers();
});

afterAll(async () => {
	fingerprintMod.stopAllResourceWatchers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await recycleGeneratedFixture(root);
});

describe("external settings.json and resource real-time synchronization", () => {
	it("refreshes /api/models/defaults and /api/agent/resources immediately after external .pi/settings.json and global edits", async () => {
		const cwd = path.join(root, "ws-routes");
		await writeJson(path.join(cwd, ".pi", "settings.json"), { defaultThinkingLevel: "low" });

		const initialDefaults = await (await defaultsRoute.GET(new Request(`http://localhost/api/models/defaults?cwd=${encodeURIComponent(cwd)}`))).json();
		expect(initialDefaults).toMatchObject({
			success: true,
			data: {
				model: { provider: "test-provider", id: "reasoner-1" },
				defaultThinkingLevel: "low",
			},
		});

		await writeJson(path.join(cwd, ".pi", "settings.json"), { defaultThinkingLevel: "high" });
		await writeText(path.join(cwd, ".pi", "prompts", "audit.md"), "---\ndescription: Audit prompt\n---\nRun audit.\n");
		await writeText(path.join(agentDir, "prompts", "global-note.md"), "---\ndescription: Global prompt\n---\nGlobal note.\n");

		const updatedDefaults = await (await defaultsRoute.GET(new Request(`http://localhost/api/models/defaults?cwd=${encodeURIComponent(cwd)}`))).json();
		expect(updatedDefaults).toMatchObject({
			success: true,
			data: {
				defaultThinkingLevel: "high",
			},
		});

		const updatedResources = await (await resourcesRoute.GET(new Request(`http://localhost/api/agent/resources?cwd=${encodeURIComponent(cwd)}`))).json();
		expect(updatedResources.success).toBe(true);
		expect(updatedResources.data.promptTemplates.map((p: { name: string }) => p.name)).toEqual(
			expect.arrayContaining(["audit", "global-note"]),
		);

		// Removing project override falls back to global defaultThinkingLevel, and global edits take effect immediately.
		await writeJson(path.join(cwd, ".pi", "settings.json"), {});
		await writeJson(path.join(agentDir, "settings.json"), {
			defaultProjectTrust: "always",
			defaultProvider: "test-provider",
			defaultModel: "reasoner-1",
			defaultThinkingLevel: "medium",
			compaction: { enabled: false },
		});
		const fallbackDefaults = await (await defaultsRoute.GET(new Request(`http://localhost/api/models/defaults?cwd=${encodeURIComponent(cwd)}`))).json();
		expect(fallbackDefaults.data.defaultThinkingLevel).toBe("medium");
	});

	it("streams workspace_changed over /api/agent/resources?stream=1 and leaks zero fs.watch handles on disconnect", async () => {
		const cwd = path.join(root, "ws-stream");
		await writeJson(path.join(cwd, ".pi", "settings.json"), { defaultThinkingLevel: "low" });
		await pi.refreshSettingsManagerIfStale(cwd);
		await pi.refreshResourceLoaderIfStale(cwd, { fresh: true });

		const controller = new AbortController();
		const response = await resourcesRoute.GET(
			new Request(`http://localhost/api/agent/resources?cwd=${encodeURIComponent(cwd)}&stream=1`, { signal: controller.signal }),
		);
		expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let text = "";
		const pump = (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
		})();

		await vi.waitFor(() => {
			expect(text).toContain('"type":"ready"');
			expect(fingerprintMod.activeResourceWatcherCount()).toBeGreaterThan(0);
			expect(fingerprintMod.activeResourceWatchHandleCount()).toBeGreaterThan(0);
		});

		await writeJson(path.join(cwd, ".pi", "settings.json"), { defaultThinkingLevel: "high" });
		await vi.waitFor(() => {
			expect(text).toContain('"type":"workspace_changed"');
		}, { timeout: 5_000 });

		controller.abort();
		await reader.cancel().catch(() => undefined);
		await pump;

		await vi.waitFor(() => {
			expect(fingerprintMod.activeResourceWatcherCount()).toBe(0);
			expect(fingerprintMod.activeResourceWatchHandleCount()).toBe(0);
		});
	});

	it("pushes updated prompt templates and non-overridden defaults via session SSE while preserving explicit per-session thinking", async () => {
		const cwd = path.join(root, "ws-session-sse");
		await writeJson(path.join(cwd, ".pi", "settings.json"), { defaultThinkingLevel: "low" });

		// Session 1: created without explicit per-session thinking override (tracks workspace default)
		const createdAuto = await manager.createNewSession(cwd, { provider: "test-provider", modelId: "reasoner-1" });
		const autoSession = manager.getManaged(createdAuto.sessionPath);
		managed.push(autoSession);
		await manager.ensureSession(autoSession);
		expect(autoSession.session!.thinkingLevel).toBe("low");

		// Session 2: user explicitly selects "minimal" in-session (must NEVER be overwritten)
		const createdExplicit = await manager.createNewSession(cwd, { provider: "test-provider", modelId: "reasoner-1" });
		const explicitSession = manager.getManaged(createdExplicit.sessionPath);
		managed.push(explicitSession);
		await manager.ensureSession(explicitSession);
		await manager.execute(explicitSession, { cmd: "setThinkingLevel", level: "minimal" });
		expect(explicitSession.session!.thinkingLevel).toBe("minimal");

		// Session 3: pre-existing persisted session opened from disk (must preserve its recorded thinking)
		const preExistingSm = pi.SessionManager.create(cwd);
		preExistingSm.appendModelChange("test-provider", "reasoner-1");
		preExistingSm.appendThinkingLevelChange("medium");
		preExistingSm.appendMessage({ role: "user", content: "Existing turn", timestamp: 1 });
		const preExistingPath = preExistingSm.getSessionFile()!;
		const preExistingSession = manager.getManaged(preExistingPath);
		managed.push(preExistingSession);
		await manager.ensureSession(preExistingSession);
		expect(preExistingSession.session!.thinkingLevel).toBe("medium");

		// Connect SSE stream to autoSession
		const autoController = new AbortController();
		const autoStream = await eventsRoute.GET(
			new Request(`http://localhost/api/agent/${encodeURIComponent(pi.encodeSessionId(autoSession.sessionPath))}/events`, { signal: autoController.signal }),
			{ params: Promise.resolve({ id: pi.encodeSessionId(autoSession.sessionPath) }) },
		);
		const autoReader = autoStream.body!.getReader();
		const decoder = new TextDecoder();
		let sseText = "";
		const autoPump = (async () => {
			for (;;) {
				const { done, value } = await autoReader.read();
				if (done) break;
				sseText += decoder.decode(value, { stream: true });
			}
		})();

		const explicitEvents: string[] = [];
		const explicitSend = (_seq: number, json: string) => { explicitEvents.push(json); };
		expect(manager.subscribe(explicitSession, explicitSend, explicitSession.seq)).toBe(true);

		await vi.waitFor(() => {
			expect(sseText).toContain('"type":"snapshot"');
			expect(fingerprintMod.activeResourceWatcherCount()).toBeGreaterThan(0);
		});

		// Edit .pi/settings.json and add a prompt template externally on disk
		await writeJson(path.join(cwd, ".pi", "settings.json"), { defaultThinkingLevel: "high" });
		await writeText(path.join(cwd, ".pi", "prompts", "live-template.md"), "---\ndescription: Live template\n---\nHello.\n");

		await vi.waitFor(() => {
			expect(autoSession.session!.thinkingLevel).toBe("high");
			expect(sseText).toContain('"thinkingLevel":"high"');
			expect(sseText).toContain('"name":"live-template"');
			expect(explicitEvents.some((frame) => frame.includes('"name":"live-template"'))).toBe(true);
		}, { timeout: 6_000 });

		// Strict invariants: explicit and pre-existing sessions keep their thinking levels
		expect(explicitSession.session!.thinkingLevel).toBe("minimal");
		expect(preExistingSession.session!.thinkingLevel).toBe("medium");

		// Cleanup leaves zero fs.watch handles
		autoController.abort();
		await autoReader.cancel().catch(() => undefined);
		await autoPump;
		manager.unsubscribe(explicitSession, explicitSend);
		await manager.disposeSession(autoSession);
		await manager.disposeSession(explicitSession);
		await manager.disposeSession(preExistingSession);
		managed.length = 0;

		await vi.waitFor(() => {
			expect(fingerprintMod.activeResourceWatcherCount()).toBe(0);
			expect(fingerprintMod.activeResourceWatchHandleCount()).toBe(0);
		});
	}, 20_000);
});
