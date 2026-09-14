import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("../src/lib/growth-service", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/lib/growth-service")>();
	return { ...actual, snapshot: vi.fn(), hasSessionSteps: vi.fn() };
});

import { GrowthError, hasSessionSteps, snapshot } from "../src/lib/growth-service";
import { createGrowthTracker } from "../src/lib/growth-tracker";
import type { WebEvent } from "../src/lib/types";

it("reports a terminal size error even after a recent transient failure and stops rescanning", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-failure-"));
	const events: WebEvent[] = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event) });
	try {
		vi.mocked(hasSessionSteps).mockResolvedValue(false);
		vi.mocked(snapshot)
			.mockRejectedValueOnce(new GrowthError("temporary failure", "failed"))
			.mockRejectedValueOnce(new GrowthError("workspace too large", "too-large"));
		await tracker.prepare();
		await tracker.prepare();
		expect(vi.mocked(snapshot)).toHaveBeenCalledTimes(2);
		expect(events.filter((event) => event.type === "growth_error").map((event) => event.message)).toEqual([
			"temporary failure",
			"workspace too large",
		]);
		await expect(tracker.snapshotNow()).rejects.toMatchObject({ code: "too-large" });
		tracker.onEvent({ type: "agent_start" } as never);
		tracker.onEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" } as never);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(vi.mocked(snapshot)).toHaveBeenCalledTimes(2);
	} finally {
		tracker.dispose();
		await fs.rm(cwd, { recursive: true, force: true });
		vi.clearAllMocks();
	}
});

it("disables automatic tracking after a manual snapshot hits a terminal error", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-manual-failure-"));
	const events: WebEvent[] = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event) });
	try {
		vi.mocked(snapshot).mockRejectedValueOnce(new GrowthError("workspace too large", "too-large"));
		await expect(tracker.snapshotNow()).rejects.toMatchObject({ code: "too-large" });
		expect(events.filter((event) => event.type === "growth_error").map((event) => event.message)).toEqual(["workspace too large"]);
		tracker.onEvent({ type: "agent_start" } as never);
		await expect(tracker.snapshotNow()).rejects.toMatchObject({ code: "too-large" });
		expect(vi.mocked(snapshot)).toHaveBeenCalledTimes(1);
	} finally {
		tracker.dispose();
		await fs.rm(cwd, { recursive: true, force: true });
		vi.clearAllMocks();
	}
});

it("clears a transient manual snapshot error after a successful retry", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-manual-retry-"));
	const events: WebEvent[] = [];
	const tracker = createGrowthTracker({ cwd, sessionPath: path.join(cwd, "session.jsonl"), publish: (event) => events.push(event) });
	try {
		vi.mocked(snapshot)
			.mockRejectedValueOnce(new GrowthError("temporary failure", "failed"))
			.mockResolvedValueOnce(null);
		await expect(tracker.snapshotNow()).rejects.toMatchObject({ code: "failed" });
		expect(tracker.getError()).toBe("temporary failure");
		await expect(tracker.snapshotNow()).resolves.toBeNull();
		expect(tracker.getError()).toBeNull();
		expect(events.filter((event) => event.type === "growth_error").map((event) => event.message)).toEqual(["temporary failure", null]);
	} finally {
		tracker.dispose();
		await fs.rm(cwd, { recursive: true, force: true });
		vi.clearAllMocks();
	}
});
