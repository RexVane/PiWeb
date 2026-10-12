import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, dispose: () => {} }),
}));
vi.mock("../src/lib/pi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/pi")>()),
	getModelRuntime: vi.fn(),
	getSettingsManager: vi.fn(),
	refreshModelRuntime: vi.fn(),
}));

import { execute } from "../src/lib/agent-manager";
import { getModelRuntime, getSettingsManager, refreshModelRuntime } from "../src/lib/pi";

type Managed = Parameters<typeof execute>[0];
type Model = { provider: string; id: string; name?: string; reasoning?: boolean };

/** 只实现 execute 用到的部分：按 provider 列模型、按 id 取模型 */
function runtimeWith(models: Model[]) {
	return {
		getModels: (provider: string) => models.filter((m) => m.provider === provider),
		getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
	};
}

function settingsWith(perModel: Record<string, string> = {}, defaultLevel?: string) {
	return {
		getModelThinkingLevel: (provider: string, id: string) => perModel[`${provider}/${id}`],
		getDefaultThinkingLevel: () => defaultLevel,
	};
}

interface FakeSession {
	model: Model;
	thinkingLevel: string;
	isIdle: boolean;
	isStreaming: boolean;
	agent: { state: { model: Model } };
	modelRuntime: ReturnType<typeof runtimeWith>;
	getAvailableThinkingLevels: () => string[];
	setModel: ReturnType<typeof vi.fn>;
	setThinkingLevel: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
}

/** 假会话：setThinkingLevel 只记录，不做 SDK 的钳制（这里的用例不依赖钳制） */
function fakeSession(model: Model, thinkingLevel: string): FakeSession {
	const session: FakeSession = {
		model,
		thinkingLevel,
		isIdle: true,
		isStreaming: false,
		agent: { state: { model } },
		modelRuntime: runtimeWith([]),
		getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high"],
		setModel: vi.fn(async (next: Model) => {
			session.model = next;
			session.agent.state.model = next;
		}),
		setThinkingLevel: vi.fn((level: string) => {
			session.thinkingLevel = level;
		}),
		reload: vi.fn(async () => {}),
	};
	return session;
}

function managed(session: FakeSession, extra: Record<string, unknown> = {}): Managed {
	return {
		session, creating: null, disposed: false, promptSubmitting: false, runActive: false,
		resourceReloading: false, resourceReloadPending: false, cwd: "/workspace", sessionPath: "/s",
		seq: 0, buffer: [], subscribers: new Set(), lastActive: 0, ...extra,
	} as unknown as Managed;
}

afterEach(() => vi.clearAllMocks());

const previous: Model = { provider: "a", id: "old" };
// reasoning: true，否则 pi-ai 的 clampThinkingLevel 会把任何档位都钳成 off
const fresh: Model = { provider: "b", id: "new", reasoning: true };

describe("new-session model pick (setModel with fresh)", () => {
	it("applies the new-session rule instead of keeping the level the session had before", async () => {
		vi.mocked(getModelRuntime).mockResolvedValue(runtimeWith([previous, fresh]) as never);
		vi.mocked(getSettingsManager).mockReturnValue(settingsWith() as never);
		const session = fakeSession(previous, "high");
		const result = await execute(managed(session), { cmd: "setModel", provider: "b", modelId: "new", fresh: true });
		expect(result).toMatchObject({ ok: true });
		expect(session.thinkingLevel).toBe("medium");
	});

	it("uses the per-model override before the settings default", async () => {
		vi.mocked(getModelRuntime).mockResolvedValue(runtimeWith([previous, fresh]) as never);
		vi.mocked(getSettingsManager).mockReturnValue(settingsWith({ "b/new": "minimal" }, "low") as never);
		const session = fakeSession(previous, "high");
		await execute(managed(session), { cmd: "setModel", provider: "b", modelId: "new", fresh: true });
		expect(session.thinkingLevel).toBe("minimal");
	});

	it("keeps SDK's switch behaviour for a model change inside a session (no fresh flag)", async () => {
		vi.mocked(getModelRuntime).mockResolvedValue(runtimeWith([previous, fresh]) as never);
		vi.mocked(getSettingsManager).mockReturnValue(settingsWith() as never);
		const session = fakeSession(previous, "high");
		await execute(managed(session), { cmd: "setModel", provider: "b", modelId: "new" });
		expect(session.thinkingLevel).toBe("high");
		expect(session.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("does not override a level the user explicitly picked", async () => {
		vi.mocked(getModelRuntime).mockResolvedValue(runtimeWith([previous, fresh]) as never);
		vi.mocked(getSettingsManager).mockReturnValue(settingsWith() as never);
		const session = fakeSession(previous, "high");
		await execute(managed(session, { desiredThinkingLevel: "low" }), { cmd: "setModel", provider: "b", modelId: "new", fresh: true });
		expect(session.thinkingLevel).toBe("low");
	});
});

describe("/reload", () => {
	it("refreshes the shared model catalog and swaps the session's model object for the fresh one", async () => {
		const oldModel: Model = { provider: "a", id: "m", name: "old" };
		const newModel: Model = { provider: "a", id: "m", name: "new" };
		const session = fakeSession(oldModel, "medium");
		session.modelRuntime = runtimeWith([newModel]);
		const result = await execute(managed(session), { cmd: "reload" });
		expect(result).toEqual({ ok: true });
		expect(refreshModelRuntime).toHaveBeenCalledTimes(1);
		expect(session.reload).toHaveBeenCalledTimes(1);
		expect(session.agent.state.model).toBe(newModel);
	});

	it("refuses while the session is busy and leaves the catalog alone", async () => {
		const session = fakeSession({ provider: "a", id: "m" }, "medium");
		session.isIdle = false;
		expect(await execute(managed(session), { cmd: "reload" })).toEqual({ ok: false, error: "session is busy" });
		expect(refreshModelRuntime).not.toHaveBeenCalled();
		expect(session.reload).not.toHaveBeenCalled();
	});
});
