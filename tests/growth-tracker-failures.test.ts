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
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [] });
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
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [] });
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

it("clears a transient manual record error after a successful retry", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-manual-retry-"));
	const events: WebEvent[] = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event), entries: () => [] });
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
