import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("../src/lib/growth-service", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/growth-service")>();
	return { ...actual, commitRound: vi.fn(), recordWorkspaceChanges: vi.fn() };
});

import { GrowthError, commitRound, recordWorkspaceChanges } from "../src/lib/growth-service";
import { createGrowthTracker } from "../src/lib/growth-tracker";
import type { WebEvent } from "../src/lib/types";

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
		await fs.rm(cwd, { recursive: true, force: true });
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
		await fs.rm(cwd, { recursive: true, force: true });
		vi.clearAllMocks();
	}
});

it("asks once before creating a repository, records nothing meanwhile, and takes a baseline after consent", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-consent-"));
	const events: WebEvent[] = [];
	let decision: boolean | null = null;
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [], consent: async () => decision });
	const needsConsent = () => new GrowthError("needs consent", "needs-consent", { reason: "nested", parent: "/outer" });
	try {
		vi.mocked(recordWorkspaceChanges).mockImplementation(async (_cwd, _session, options) => {
			if (!options?.allowInit) throw needsConsent();
			return null;
		});
		vi.mocked(commitRound).mockImplementation(async (_cwd, _meta, options) => {
			if (!options?.allowInit) throw needsConsent();
			return null;
		});
		await tracker.prepare();
		tracker.onEvent({ type: "agent_start" } as never);
		tracker.onEvent({ type: "agent_settled" } as never);
		await tracker.prepare();
		// 只问一次；没回答之前不再去探测仓库，也不报错
		const asks = events.filter((event) => event.type === "growth_consent");
		expect(asks).toEqual([{ type: "growth_consent", request: { cwd, reason: "nested", parent: "/outer" }, ts: expect.any(Number) }]);
		expect(tracker.getConsentRequest()).toMatchObject({ reason: "nested" });
		expect(vi.mocked(recordWorkspaceChanges)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(commitRound)).not.toHaveBeenCalled();
		expect(events.some((event) => event.type === "growth_error")).toBe(false);
		await expect(tracker.recordNow()).rejects.toMatchObject({ code: "needs-consent" });

		decision = true;
		await tracker.consentAnswered(true);
		expect(tracker.getConsentRequest()).toBeNull();
		expect(events.at(-1)).toMatchObject({ type: "growth_consent", request: null });
		expect(vi.mocked(recordWorkspaceChanges).mock.calls.at(-1)?.[2]).toMatchObject({ allowInit: true });
		tracker.onEvent({ type: "agent_start" } as never);
		tracker.onEvent({ type: "agent_settled" } as never);
		await vi.waitFor(() => expect(vi.mocked(commitRound)).toHaveBeenCalledWith(cwd, expect.objectContaining({ kind: "round" }), expect.objectContaining({ allowInit: true })));
	} finally {
		tracker.dispose();
		await fs.rm(cwd, { recursive: true, force: true });
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
		expect(vi.mocked(recordWorkspaceChanges)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(commitRound)).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		await expect(tracker.recordNow()).rejects.toMatchObject({ code: "unavailable" });
	} finally {
		tracker.dispose();
		await fs.rm(cwd, { recursive: true, force: true });
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
		await fs.rm(cwd, { recursive: true, force: true });
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
		await fs.rm(cwd, { recursive: true, force: true });
		vi.clearAllMocks();
	}
});
