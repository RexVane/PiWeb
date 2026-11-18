import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { recycleFixture } from "./fixtures/recycle";

vi.mock("../src/lib/growth-service", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/growth-service")>();
	return { ...actual, commitRound: vi.fn(), recordWorkspaceChanges: vi.fn() };
});

import { GrowthError, commitRound, recordWorkspaceChanges, finishGrowthRun } from "../src/lib/growth-service";
import { createGrowthTracker } from "../src/lib/growth-tracker";
import type { WebEvent } from "../src/lib/types";

it("releases active attribution when recording is declined or a terminal failure disables it", async () => {
	for (const terminal of [false, true]) {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-release-"));
		const session = path.join(cwd, "session.jsonl");
		const tracker = createGrowthTracker({ cwd, sessionPath: session, publish: () => {}, entries: () => [], consent: async () => true });
		try {
			tracker.onEvent({ type: "agent_start" } as never);
			if (terminal) { vi.mocked(recordWorkspaceChanges).mockRejectedValueOnce(new GrowthError("too large", "too-large")); await tracker.prepare(); }
			else await tracker.consentAnswered(false);
			expect(finishGrowthRun(cwd, session)).toEqual({});
		} finally { tracker.dispose(); await recycleFixture(cwd); vi.resetAllMocks(); }
	}
});

it("reenables background trackers without taking duplicate baselines", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-enable-"));
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: () => {}, entries: () => [], consent: async () => true });
	try {
		await tracker.consentAnswered(false); await tracker.consentAnswered(true, false);
		expect(recordWorkspaceChanges).not.toHaveBeenCalled();
		vi.mocked(recordWorkspaceChanges).mockResolvedValueOnce(null); await tracker.prepare();
		expect(recordWorkspaceChanges).toHaveBeenCalledOnce();
	} finally { tracker.dispose(); await recycleFixture(cwd); vi.resetAllMocks(); }
});

it("keeps real chat round numbers after a previous snapshot failed", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-ordinal-"));
	const entries: Array<{ type: string; id: string; message: { role: string; content: string } }> = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: () => {}, entries: () => entries, consent: async () => true });
	try {
		vi.mocked(commitRound).mockRejectedValueOnce(new GrowthError("temporary snapshot failure", "failed")).mockResolvedValue(null);
		vi.mocked(recordWorkspaceChanges).mockResolvedValue(null);
		for (let i = 1; i <= 2; i++) {
			tracker.onEvent({ type: "agent_start" } as never);
			entries.push({ type: "message", id: `u${i}`, message: { role: "user", content: `question ${i}` } });
			tracker.onEvent({ type: "agent_settled" } as never); await tracker.prepare();
		}
		expect(vi.mocked(commitRound).mock.calls.map((call) => call[1].roundNumber)).toEqual([1, 2]);
	} finally { tracker.dispose(); await recycleFixture(cwd); vi.resetAllMocks(); }
});

it("reports a terminal size error even after a recent transient failure and stops committing", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-failure-"));
	const events: WebEvent[] = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [], consent: async () => true });
	try {
		vi.mocked(recordWorkspaceChanges)
			.mockRejectedValueOnce(new GrowthError("temporary failure", "failed"))
			.mockRejectedValueOnce(new GrowthError("workspace too large", "too-large"));
		await tracker.prepare();
		await tracker.prepare();
		expect(vi.mocked(recordWorkspaceChanges)).toHaveBeenCalledTimes(2);
		expect(events.filter((event) => event.type === "growth_error").map((event) => event.message)).toEqual([
			"temporary failure",
			"workspace too large",
		]);
		await expect(tracker.recordNow()).rejects.toMatchObject({ code: "too-large" });
		tracker.onEvent({ type: "agent_start" } as never);
		tracker.onEvent({ type: "agent_settled" } as never);
		await tracker.prepare();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(vi.mocked(recordWorkspaceChanges)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(commitRound)).not.toHaveBeenCalled();
	} finally {
		tracker.dispose();
		await recycleFixture(cwd);
		vi.clearAllMocks();
	}
});

it("disables automatic tracking after a manual record hits a terminal error", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-manual-failure-"));
	const events: WebEvent[] = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [], consent: async () => true });
	try {
		vi.mocked(recordWorkspaceChanges).mockRejectedValueOnce(new GrowthError("workspace too large", "too-large"));
		await expect(tracker.recordNow()).rejects.toMatchObject({ code: "too-large" });
		expect(events.filter((event) => event.type === "growth_error").map((event) => event.message)).toEqual(["workspace too large"]);
		tracker.onEvent({ type: "agent_start" } as never);
		tracker.onEvent({ type: "agent_settled" } as never);
		await expect(tracker.recordNow()).rejects.toMatchObject({ code: "too-large" });
		expect(vi.mocked(recordWorkspaceChanges)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(commitRound)).not.toHaveBeenCalled();
	} finally {
		tracker.dispose();
		await recycleFixture(cwd);
		vi.clearAllMocks();
	}
});

it("records by default without asking when the workspace has no saved choice", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-consent-"));
	const events: WebEvent[] = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [], consent: async () => null });
	try {
		vi.mocked(recordWorkspaceChanges).mockImplementation(async (_cwd, _session, options) => {
			expect(options).toMatchObject({ allowInit: true, allowRecording: true });
			return null;
		});
		vi.mocked(commitRound).mockImplementation(async (_cwd, _meta, options) => {
			expect(options).toMatchObject({ allowInit: true, allowRecording: true });
			return null;
		});
		await tracker.prepare();
		tracker.onEvent({ type: "agent_start" } as never);
		tracker.onEvent({ type: "agent_settled" } as never);
		await tracker.prepare();
		expect(recordWorkspaceChanges).toHaveBeenCalledTimes(2);
		expect(commitRound).toHaveBeenCalledOnce();
		await expect(tracker.recordNow()).resolves.toBeNull();
		expect(recordWorkspaceChanges).toHaveBeenCalledTimes(3);
		expect(events).toEqual([]);
	} finally {
		tracker.dispose();
		await recycleFixture(cwd);
		vi.resetAllMocks();
	}
});

it("does not write a snapshot after a setting-read failure and recovers on retry", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-setting-retry-"));
	const events: WebEvent[] = [];
	const consent = vi.fn().mockRejectedValueOnce(new Error("setting unavailable")).mockResolvedValue(null);
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [], consent });
	try {
		vi.mocked(recordWorkspaceChanges).mockResolvedValue(null);
		await tracker.prepare();
		expect(recordWorkspaceChanges).not.toHaveBeenCalled();
		expect(tracker.getError()).toBe("setting unavailable");
		await tracker.prepare();
		expect(recordWorkspaceChanges).toHaveBeenCalledOnce();
		expect(tracker.getError()).toBeNull();
		expect(events.filter((event) => event.type === "growth_error").map((event) => event.message)).toEqual(["setting unavailable", null]);
	} finally {
		tracker.dispose();
		await recycleFixture(cwd);
		vi.resetAllMocks();
	}
});

it("stops tracking quietly when the workspace owner declined", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-declined-"));
	const events: WebEvent[] = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [], consent: async () => false });
	try {
		vi.mocked(recordWorkspaceChanges).mockRejectedValue(new GrowthError("needs consent", "needs-consent", { reason: "not-git" }));
		await tracker.prepare();
		tracker.onEvent({ type: "agent_start" } as never);
		tracker.onEvent({ type: "agent_settled" } as never);
		await tracker.prepare();
		expect(vi.mocked(recordWorkspaceChanges)).toHaveBeenCalledTimes(0);
		expect(vi.mocked(commitRound)).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		await expect(tracker.recordNow()).rejects.toMatchObject({ code: "unavailable" });
	} finally {
		tracker.dispose();
		await recycleFixture(cwd);
		vi.resetAllMocks();
	}
});

it("does not file pi's edits as the user's when the pre-prompt snapshot runs after pi started", async () => {
	// 回归：发 prompt 前的「你的修改」快照 5 秒没拍完就放行，pi 开工后才拍到的改动被记成用户改的
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-late-prepare-"));
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: () => undefined, entries: () => [], consent: async () => true });
	let abortIf: (() => boolean) | undefined;
	try {
		vi.mocked(recordWorkspaceChanges).mockImplementation(async (_cwd, _session, options) => {
			abortIf = options?.abortIf;
			return null;
		});
		const prepared = tracker.prepare();
		await prepared;
		expect(abortIf?.()).toBe(false);
		const late = tracker.prepare();
		tracker.onEvent({ type: "agent_start" } as never);
		await late;
		expect(abortIf?.()).toBe(true);
	} finally {
		tracker.dispose();
		await recycleFixture(cwd);
		vi.resetAllMocks();
	}
});

it("clears a transient manual record error after a successful retry", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-manual-retry-"));
	const events: WebEvent[] = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [], consent: async () => true });
	try {
		vi.mocked(recordWorkspaceChanges)
			.mockRejectedValueOnce(new GrowthError("temporary failure", "failed"))
			.mockResolvedValueOnce(null);
		await expect(tracker.recordNow()).rejects.toMatchObject({ code: "failed" });
		expect(tracker.getError()).toBe("temporary failure");
		await expect(tracker.recordNow()).resolves.toBeNull();
		expect(tracker.getError()).toBeNull();
		expect(events.filter((event) => event.type === "growth_error").map((event) => event.message)).toEqual(["temporary failure", null]);
	} finally {
		tracker.dispose();
		await recycleFixture(cwd);
		vi.clearAllMocks();
	}
});

it("backs off automatic background snapshots after consecutive transient failures until manual recordNow recovers", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-cooldown-"));
	const events: WebEvent[] = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [], consent: async () => true });
	try {
		vi.mocked(recordWorkspaceChanges)
			.mockRejectedValueOnce(new GrowthError("git ls-files timed out", "failed"))
			.mockRejectedValueOnce(new GrowthError("git update-index timed out", "failed"))
			.mockResolvedValueOnce(null);
		await tracker.prepare();
		await tracker.prepare();
		expect(vi.mocked(recordWorkspaceChanges)).toHaveBeenCalledTimes(2);
		// 进入冷却期后，后台自动 prepare / 回合记录不再反复扫盘。
		await tracker.prepare();
		tracker.onEvent({ type: "agent_start" } as never);
		tracker.onEvent({ type: "agent_settled" } as never);
		expect(vi.mocked(recordWorkspaceChanges)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(commitRound)).not.toHaveBeenCalled();
		// 用户手动点“立即记录”不受冷却阻止，成功后清除冷却并恢复自动记录。
		await expect(tracker.recordNow()).resolves.toBeNull();
		expect(vi.mocked(recordWorkspaceChanges)).toHaveBeenCalledTimes(3);
		expect(tracker.getError()).toBeNull();
		vi.mocked(recordWorkspaceChanges).mockResolvedValueOnce(null);
		await tracker.prepare();
		expect(vi.mocked(recordWorkspaceChanges)).toHaveBeenCalledTimes(4);
	} finally {
		tracker.dispose();
		await recycleFixture(cwd);
		vi.clearAllMocks();
	}
});
