import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	attachRunSession,
	claimDueTasks,
	createAutomationTask,
	deleteAutomationTask,
	listAutomations,
	reconcileInterruptedRuns,
	recordRunFinished,
	recordRunStarted,
	updateAutomationTask,
	inspectAutomationStore,
	repairAutomationStore,
	heartbeatAutomationRun,
	requestAutomationStop,
	hasLiveRunOwner,
	releaseAutomationClaim,
} from "@/lib/automations/store";

const tempDirs: string[] = [];

async function makeFixture(): Promise<{ storePath: string; workspaceDir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-automations-store-"));
	tempDirs.push(dir);
	const workspaceDir = path.join(dir, "workspace");
	await fs.mkdir(workspaceDir, { recursive: true });
	return { storePath: path.join(dir, "web-automations.json"), workspaceDir };
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("automations store", () => {
	it("retains queued occurrences while slots are occupied and preserves the interval phase", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		for (let i = 0; i < 5; i++) await createAutomationTask({ name: `Queue ${i}`, prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "minutes" } }, storePath, 0);
		const claims = await claimDueTasks(74_000, new Set(), storePath, { maxLatenessMs: 120_000 });
		expect(claims).toHaveLength(4);
		const runs = await Promise.all(claims.map((task) => recordRunStarted(task, "schedule", 74_000, storePath)));
		for (const now of [100_000, 150_000, 200_000, 250_000]) await claimDueTasks(now, new Set(), storePath, { maxLatenessMs: 120_000 });
		expect((await listAutomations(storePath)).runs.some((run) => run.status === "skipped")).toBe(false);
		for (const run of runs) await recordRunFinished(run.id, "success", {}, 260_000, storePath);
		const resumed = await claimDueTasks(260_000, new Set(), storePath, { maxLatenessMs: 120_000 });
		expect(resumed).toHaveLength(4);
		expect((await listAutomations(storePath)).tasks.filter((task) => task.scheduledClaim).every((task) => task.nextRunAt === 300_000)).toBe(true);
	});
	it("releases only its exact claim even after a task edit or an unrelated manual run", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const task = await createAutomationTask({ name: "Claim", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "minutes" } }, storePath, 0);
		const manual = await recordRunStarted(task, "manual", 61_000, storePath);
		await recordRunFinished(manual.id, "success", {}, 62_000, storePath);
		const [claim] = await claimDueTasks(63_000, new Set(), storePath);
		await updateAutomationTask(task.id, { name: "Edited" }, storePath, 64_000);
		await releaseAutomationClaim(claim, storePath);
		expect((await listAutomations(storePath)).tasks[0]).toMatchObject({ name: "Edited", nextRunAt: 60_000 });
		const [newClaim] = await claimDueTasks(65_000, new Set(), storePath);
		await releaseAutomationClaim(claim, storePath);
		expect((await listAutomations(storePath)).tasks[0].scheduledClaim?.id).toBe(newClaim.scheduledClaim?.id);
		await updateAutomationTask(task.id, { schedule: { kind: "interval", every: 2, unit: "hours" } }, storePath, 66_000);
		await releaseAutomationClaim(newClaim, storePath);
		expect((await listAutomations(storePath)).tasks[0].nextRunAt).toBe(66_000 + 7_200_000);
	});
	it("rejects a syntactically valid schedule that can never occur", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		await expect(createAutomationTask({ name: "Never", prompt: "Check", cwd: workspaceDir, schedule: { kind: "cron", expr: "0 0 31 2 *" } }, storePath)).rejects.toThrow("no upcoming occurrence");
	});
	it("repairs valid records only after backing up damaged content and checking its preview hash", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const task = await createAutomationTask({ name: "Keep", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "hours" } }, storePath);
		const parsed = JSON.parse(await fs.readFile(storePath, "utf8")); parsed.tasks.push({ id: "broken", schedule: { kind: "unknown" } });
		const damaged = JSON.stringify(parsed); await fs.writeFile(storePath, damaged);
		const preview = await inspectAutomationStore(storePath);
		expect(preview.tasks.map((entry) => entry.id)).toEqual([task.id]); expect(preview.storeError?.canSalvage).toBe(true);
		await expect(repairAutomationStore("salvage", "stale", storePath)).rejects.toThrow("changed");
		const repaired = await repairAutomationStore("salvage", preview.storeError!.expectedHash, storePath);
		expect(await fs.readFile(repaired.backup, "utf8")).toBe(damaged);
		expect((await listAutomations(storePath)).tasks.map((entry) => entry.id)).toEqual([task.id]);
	});
	it("uses instance leases to reject a reused PID and carries stop requests to the owner", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const task = await createAutomationTask({ name: "Stop", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "hours" } }, storePath);
		const run = await recordRunStarted(task, "manual", Date.now(), storePath);
		expect(hasLiveRunOwner({ ...run, ownerInstance: "different-process-instance" })).toBe(false);
		expect(hasLiveRunOwner({ ...run, heartbeatAt: Date.now() - 6 * 60_000 })).toBe(true);
		expect(hasLiveRunOwner({ ...run, ownerBirth: "a-different-process-start" })).toBe(false);
		await requestAutomationStop(task.id, storePath); expect(await heartbeatAutomationRun(run.id, storePath)).toBe(true);
		await recordRunFinished(run.id, "error", { error: "stopped" }, Date.now(), storePath);
	});
	it("retries a transient sharing violation and atomically preserves all existing records", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const task = await createAutomationTask({ name: "Before", prompt: "Check", cwd: workspaceDir, schedule: { kind: "daily", time: "09:00" } }, storePath);
		const originalRename = fs.rename.bind(fs);
		const sharingError = Object.assign(new Error("Reader temporarily holds the destination"), { code: "EPERM" });
		vi.spyOn(fs, "rename").mockRejectedValueOnce(sharingError).mockImplementation(originalRename);
		await updateAutomationTask(task.id, { name: "After" }, storePath);
		expect((await listAutomations(storePath)).tasks).toHaveLength(1);
		expect((await listAutomations(storePath)).tasks[0]).toMatchObject({ id: task.id, name: "After", prompt: "Check" });
		expect((await fs.readdir(path.dirname(storePath))).some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("keeps the destination unchanged and reports a persistent replacement error", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const task = await createAutomationTask({ name: "Keep", prompt: "Check", cwd: workspaceDir, schedule: { kind: "daily", time: "09:00" } }, storePath);
		const before = await fs.readFile(storePath, "utf8");
		const denied = Object.assign(new Error("Replacement denied"), { code: "EPERM" });
		vi.spyOn(fs, "rename").mockRejectedValue(denied);
		await expect(updateAutomationTask(task.id, { name: "Changed" }, storePath)).rejects.toBe(denied);
		expect(await fs.readFile(storePath, "utf8")).toBe(before);
		expect((await fs.readdir(path.dirname(storePath))).some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("creates, updates, toggles, tracks runs, and deletes tasks", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const t0 = new Date(2026, 4, 10, 8, 0, 0, 0).getTime();

		const created = await createAutomationTask(
			{
				name: "Morning Check",
				prompt: "Summarize git status",
				cwd: workspaceDir,
				schedule: { kind: "daily", time: "09:00" },
				toolPreset: "readonly",
				model: { provider: "openai", id: "gpt-5" },
			},
			storePath,
			t0,
		);
		expect(created.enabled).toBe(true);
		expect(created.toolPreset).toBe("readonly");
		expect(created.nextRunAt).toBe(new Date(2026, 4, 10, 9, 0, 0, 0).getTime());

		const paused = await updateAutomationTask(created.id, { enabled: false }, storePath, t0 + 1000);
		expect(paused.enabled).toBe(false);
		expect(paused.nextRunAt).toBeNull();

		const resumed = await updateAutomationTask(created.id, { enabled: true, toolPreset: "full", model: null }, storePath, t0 + 2000);
		expect(resumed.enabled).toBe(true);
		expect(resumed.toolPreset).toBe("full");
		expect(resumed.model).toBeUndefined();

		const run = await recordRunStarted(resumed, "manual", t0 + 3000, storePath);
		await attachRunSession(run.id, created.id, "/tmp/session-1.jsonl", storePath);
		await recordRunFinished(run.id, "success", { summary: "Everything clean." }, t0 + 4000, storePath);

		const snap = await listAutomations(storePath);
		expect(snap.tasks).toHaveLength(1);
		expect(snap.tasks[0].lastRunStatus).toBe("success");
		expect(snap.tasks[0].lastSessionPath).toBe("/tmp/session-1.jsonl");
		expect(snap.runs).toHaveLength(1);
		expect(snap.runs[0].summary).toBe("Everything clean.");

		await deleteAutomationTask(created.id, storePath);
		const afterDelete = await listAutomations(storePath);
		expect(afterDelete.tasks).toHaveLength(0);
		expect(afterDelete.runs).toHaveLength(0);
	});

	it("skips overdue missed schedules cleanly without backlog burst and recovers interrupted runs", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const createdAt = new Date(2026, 4, 10, 8, 0, 0, 0).getTime();
		const dueTask = await createAutomationTask(
			{
				name: "On Time",
				prompt: "Check logs",
				cwd: workspaceDir,
				schedule: { kind: "daily", time: "08:05" },
			},
			storePath,
			createdAt,
		);
		const missedTask = await createAutomationTask(
			{
				name: "Missed While Offline",
				prompt: "Check build",
				cwd: workspaceDir,
				schedule: { kind: "daily", time: "08:01" },
			},
			storePath,
			createdAt,
		);

		const startedRun = await recordRunStarted(dueTask, "schedule", createdAt + 1000, storePath);
		// A legacy record without a live owner represents a run left by a stopped server.
		const interrupted = JSON.parse(await fs.readFile(storePath, "utf8"));
		delete interrupted.runs[0].ownerPid;
		await fs.writeFile(storePath, JSON.stringify(interrupted));
		const recovered = await reconcileInterruptedRuns(new Set(), storePath, createdAt + 5000);
		expect(recovered).toBeGreaterThan(0);

		const afterRecover = await listAutomations(storePath);
		expect(afterRecover.runs.find((r) => r.id === startedRun.id)?.status).toBe("error");
		expect(afterRecover.tasks.find((t) => t.id === dueTask.id)?.lastRunStatus).toBe("error");

		// At 08:05:30: "On Time" (08:05) is 30s late (< 2m grace -> runs); "Missed" (08:01) is 4m30s late (skipped cleanly).
		const checkAt = new Date(2026, 4, 10, 8, 5, 30, 0).getTime();
		const claimed = await claimDueTasks(checkAt, new Set(), storePath, { maxLatenessMs: 120_000 });
		expect(claimed.map((t) => t.id)).toEqual([dueTask.id]);

		// Both tasks now point to tomorrow!
		const updated = await listAutomations(storePath);
		expect(updated.tasks.find((t) => t.id === dueTask.id)?.nextRunAt).toBe(new Date(2026, 4, 11, 8, 5, 0, 0).getTime());
		expect(updated.tasks.find((t) => t.id === missedTask.id)?.nextRunAt).toBe(new Date(2026, 4, 11, 8, 1, 0, 0).getTime());
	});

	it("retains a live instance's run and excludes concurrent launches and deletion", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const task = await createAutomationTask({ name: "Live owner", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "minutes" } }, storePath, 0);
		const run = await recordRunStarted(task, "manual", 1, storePath);
		expect(await reconcileInterruptedRuns(new Set(), storePath, 2)).toBe(0);
		await expect(recordRunStarted(task, "manual", 3, storePath)).rejects.toThrow("already running");
		await expect(deleteAutomationTask(task.id, storePath)).rejects.toThrow("running");
		expect(await claimDueTasks(60_001, new Set(), storePath)).toEqual([]);
		expect((await listAutomations(storePath)).runs[0]).toMatchObject({ id: run.id, status: "running", ownerPid: process.pid });
		await recordRunFinished(run.id, "success", {}, 4, storePath);
		await deleteAutomationTask(task.id, storePath);
		await expect(recordRunStarted(task, "manual", 5, storePath)).rejects.toThrow("not found");
	});

	it("rejects string enable flags without silently enabling a task", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const input = { name: "Validate", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "minutes" } } as const;
		await expect(createAutomationTask({ ...input, enabled: "false" as unknown as boolean }, storePath)).rejects.toThrow("boolean");
		const task = await createAutomationTask({ ...input, enabled: false }, storePath);
		await expect(updateAutomationTask(task.id, { enabled: "false" as unknown as boolean }, storePath)).rejects.toThrow("boolean");
		expect((await listAutomations(storePath)).tasks[0].enabled).toBe(false);
	});

	it("keeps old active ownership records beyond the completed-history limit", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const task = await createAutomationTask({ name: "Long running", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "minutes" } }, storePath);
		const run = await recordRunStarted(task, "manual", 1, storePath);
		const data = JSON.parse(await fs.readFile(storePath, "utf8"));
		data.runs = [...Array.from({ length: 105 }, (_, i) => ({ ...run, id: `completed-${i}`, taskId: `old-${i}`, status: "success" })), run];
		await fs.writeFile(storePath, JSON.stringify(data));
		expect((await listAutomations(storePath)).runs.find((item) => item.id === run.id)?.status).toBe("running");
		await expect(recordRunStarted(task, "manual", 2, storePath)).rejects.toThrow("already running");
	});

	it("does not drop unrecognized stored tasks while saving another task", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const damaged = JSON.stringify({ version: 1, tasks: [{ id: "preserve-me", schedule: { kind: "unknown" }, originalData: true }], runs: [] });
		await fs.writeFile(storePath, damaged);
		await expect(createAutomationTask({ name: "New", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "minutes" } }, storePath)).rejects.toThrow("not modified");
		expect(await fs.readFile(storePath, "utf8")).toBe(damaged);
	});
});
