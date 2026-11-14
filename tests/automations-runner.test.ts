import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationConflictError, getAutomationsSnapshot, launchAutomationTask, runDueAutomations, startAutomationScheduler } from "@/lib/automations/runner";
import { createAutomationTask, listAutomations } from "@/lib/automations/store";
import type { Managed } from "@/lib/agent-manager";
import type { WebEvent } from "@/lib/types";

const tempDirs: string[] = [];

async function makeWorkspaceAndStore() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-automations-runner-"));
	tempDirs.push(dir);
	const workspaceDir = path.join(dir, "workspace");
	await fs.mkdir(workspaceDir, { recursive: true });
	return { storePath: path.join(dir, "web-automations.json"), workspaceDir };
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("automations runner", () => {
	it("finishes a session already disposed by another action without retrying abort forever", async () => {
		const { storePath, workspaceDir } = await makeWorkspaceAndStore();
		const task = await createAutomationTask({ name: "Already closed", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "hours" } }, storePath);
		const managed = { session: null, runActive: false, disposed: false } as unknown as Managed;
		const dispose = vi.fn(async () => {});
		const execute = vi.fn(async (_m: Managed, command: { cmd: string }) => {
			if (command.cmd === "prompt") { managed.disposed = true; return { ok: false, error: "Session was closed" }; }
			return { ok: true };
		});
		const launched = await launchAutomationTask(task, "manual", { storePath, deps: {
			createNewSession: async () => ({ sessionPath: path.join(workspaceDir, "closed.jsonl") }), getManaged: () => managed,
			execute, disposeSession: dispose, observeManagedEvents: () => () => {},
		} });
		expect(await launched.done).toMatchObject({ status: "error", error: "Session was closed" });
		expect(dispose).toHaveBeenCalledOnce();
		expect(execute.mock.calls.some(([, command]) => command.cmd === "abort")).toBe(false);
		expect((await getAutomationsSnapshot(storePath)).activeTaskIds).toEqual([]);
	});
	it("retries claim releases after storage recovers without leaving live-owner reservations stuck", async () => {
		const { storePath, workspaceDir } = await makeWorkspaceAndStore();
		for (let i = 0; i < 2; i++) await createAutomationTask({ name: `Recover ${i}`, prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "minutes" } }, storePath, 0);
		const rename = fs.rename.bind(fs);
		let failing = false, injectFailure = true;
		vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
			if (String(target) === storePath && injectFailure) {
				const proposed = JSON.parse(await fs.readFile(source, "utf8"));
				if (proposed.runs.some((run: { status: string }) => run.status === "running")) failing = true;
				if (failing) throw new Error("fixture storage outage");
			}
			await rename(source, target);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = {
			createNewSession: async () => ({ sessionPath: path.join(workspaceDir, "offline.jsonl") }),
			getManaged: () => ({ session: null, runActive: false }) as unknown as Managed,
			execute: async () => ({ ok: true }), observeManagedEvents: () => () => {},
		};
		expect(await runDueAutomations({ now: 63_000, storePath, deps })).toEqual([]);
		expect((await listAutomations(storePath)).tasks.filter((task) => task.scheduledClaim)).toHaveLength(2);
		injectFailure = false;
		expect(await runDueAutomations({ now: 64_000, storePath, deps })).toHaveLength(2);
		await vi.waitFor(async () => expect((await listAutomations(storePath)).runs.filter((run) => run.status === "success")).toHaveLength(2));
		expect((await listAutomations(storePath)).tasks.some((task) => task.scheduledClaim)).toBe(false);
	});
	it("waits for an accepted extension command and its shutdown before releasing the run", async () => {
		const { storePath, workspaceDir } = await makeWorkspaceAndStore();
		const task = await createAutomationTask({ name: "Slow command", prompt: "/slow", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "hours" } }, storePath);
		const managed = { runActive: false, commandRunning: false, session: null } as unknown as Managed;
		let observer: (event: WebEvent) => void = () => {};
		let finishShutdown!: () => void;
		const cleanup = new Promise<void>((resolve) => { finishShutdown = resolve; });
		const dispose = vi.fn(() => cleanup);
		const execute = vi.fn(async (_managed: Managed, command: { cmd: string }) => {
			if (command.cmd === "prompt") managed.commandRunning = true;
			if (command.cmd === "abort") managed.commandRunning = false;
			return { ok: true };
		});
		const launched = await launchAutomationTask(task, "manual", { storePath, deps: {
			createNewSession: async () => ({ sessionPath: path.join(workspaceDir, "slow.jsonl") }), getManaged: () => managed,
			execute, disposeSession: dispose, observeManagedEvents: (_m, listener) => { observer = listener; return () => {}; },
		} });
		await vi.waitFor(() => expect(managed.commandRunning).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 90));
		expect((await listAutomations(storePath)).runs[0].status).toBe("running");
		expect(managed.headless).toBe(true);
		observer({ type: "interaction_unavailable", reason: "headless", method: "askQuestions", ts: Date.now() });
		await vi.waitFor(() => expect(dispose).toHaveBeenCalled());
		expect((await getAutomationsSnapshot(storePath)).activeTaskIds).toContain(task.id);
		expect(managed.headless).toBe(true);
		finishShutdown();
		expect(await launched.done).toMatchObject({ status: "error", error: expect.stringContaining("需要人工输入") });
		expect(managed.headless).toBe(false);
		expect(execute.mock.calls.some(([, command]) => command.cmd === "abort")).toBe(true);
	});
	it("stops headless input requests immediately and records the unmet input", async () => {
		const { storePath, workspaceDir } = await makeWorkspaceAndStore();
		const task = await createAutomationTask({ name: "Needs input", prompt: "Ask", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "hours" } }, storePath);
		let observer: (event: WebEvent) => void = () => {};
		const managed = { runActive: true, session: { agent: { waitForIdle: () => new Promise(() => {}) } } } as unknown as Managed;
		const dispose = vi.fn();
		const launched = await launchAutomationTask(task, "manual", { storePath, deps: {
			createNewSession: async () => ({ sessionPath: path.join(workspaceDir, "needs-input.jsonl") }), getManaged: () => managed, disposeSession: dispose,
			observeManagedEvents: (_managed, listener) => { observer = listener; return () => {}; },
			execute: async (_managed, command) => {
				if (command.cmd === "prompt") {
					expect(managed.headless).toBe(true);
					observer({ type: "interaction_unavailable", reason: "headless", method: "askQuestions", ts: Date.now() });
				}
				return { ok: true };
			},
		} });
		expect(await launched.done).toMatchObject({ status: "error", error: expect.stringContaining("需要人工输入") });
		expect(dispose).toHaveBeenCalledOnce();
		expect(managed.headless).toBe(false);
	});
	it("retries a failed completion write without rerunning the task or losing its successful result", async () => {
		const { storePath, workspaceDir } = await makeWorkspaceAndStore();
		const task = await createAutomationTask({ name: "Save result", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "hours" } }, storePath);
		const originalRename = fs.rename.bind(fs);
		let failures = 2;
		vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
			if (String(destination) === storePath && failures > 0) {
				const content = JSON.parse(await fs.readFile(source, "utf8"));
				if (content.runs[0]?.status !== "running") {
					failures -= 1;
					throw new Error("Temporary result write failure");
				}
			}
			await originalRename(source, destination);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const managed = { runActive: false, session: null, sm: { getBranch: () => [{ type: "message", message: { role: "assistant", content: "Saved outcome", stopReason: "stop" } }] } } as unknown as Managed;
		const execute = vi.fn(async () => ({ ok: true }));
		const launched = await launchAutomationTask(task, "manual", { storePath, deps: {
			createNewSession: async () => ({ sessionPath: path.join(workspaceDir, "finished.jsonl") }), getManaged: () => managed, execute, observeManagedEvents: () => () => {},
		} });
		await expect(launched.done).rejects.toThrow("Temporary result write failure");
		await runDueAutomations({ storePath, now: task.createdAt });
		expect((await listAutomations(storePath)).runs[0].status).toBe("running");
		const snapshot = await getAutomationsSnapshot(storePath);
		expect(snapshot.runs[0]).toMatchObject({ status: "success", summary: "Saved outcome" });
		expect(snapshot.activeTaskIds).toEqual([]);
		expect(execute.mock.calls).toHaveLength(3);
	});

	it("times out stalled setup and prevents it from submitting a prompt after the deadline", async () => {
		const { storePath, workspaceDir } = await makeWorkspaceAndStore();
		const task = await createAutomationTask({ name: "Deadline", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "hours" } }, storePath);
		let release!: () => void;
		const setup = new Promise<void>((resolve) => { release = resolve; });
		const managed = { runActive: false, session: null, sm: { getBranch: () => [] } } as unknown as Managed;
		const dispose = vi.fn();
		const commands: string[] = [];
		const launched = await launchAutomationTask(task, "manual", { storePath, deps: {
			createNewSession: async () => ({ sessionPath: path.join(workspaceDir, "deadline.jsonl") }), getManaged: () => managed, disposeSession: dispose, timeoutMs: 100,
			observeManagedEvents: () => () => {},
			execute: async (_m, command) => { commands.push(command.cmd); if (command.cmd === "setToolPreset") await setup; return { ok: true }; },
		} });
		const finished = await Promise.race([launched.done, new Promise<undefined>((resolve) => setTimeout(resolve, 600))]);
		release();
		await launched.done;
		expect(finished).toMatchObject({ status: "error", error: expect.stringContaining("timed out") });
		expect(dispose).toHaveBeenCalledWith(managed);
		expect(commands).not.toContain("prompt");
		expect((await getAutomationsSnapshot(storePath)).activeTaskIds).toEqual([]);
	});

	it("uses the current branch when falling back to a saved assistant result", async () => {
		const { storePath, workspaceDir } = await makeWorkspaceAndStore();
		const task = await createAutomationTask({ name: "Branch result", prompt: "Check", cwd: workspaceDir, schedule: { kind: "interval", every: 1, unit: "hours" } }, storePath);
		const message = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
		const managed = { runActive: false, session: null, sm: { getEntries: () => [message("Other branch")], getBranch: () => [message("Current branch")] } } as unknown as Managed;
		const launched = await launchAutomationTask(task, "manual", { storePath, deps: {
			createNewSession: async () => ({ sessionPath: path.join(workspaceDir, "branch.jsonl") }),
			getManaged: () => managed,
			execute: async () => ({ ok: true }),
			observeManagedEvents: () => () => {},
		} });
		expect(await launched.done).toMatchObject({ status: "success", summary: "Current branch" });
	});
	it("keeps replacement stop handles and separate store schedulers isolated", async () => {
		const first = await makeWorkspaceAndStore();
		const second = await makeWorkspaceAndStore();
		const oldStop = startAutomationScheduler({ storePath: first.storePath, intervalMs: 60_000 });
		const currentStop = startAutomationScheduler({ storePath: first.storePath, intervalMs: 60_000 });
		const otherStop = startAutomationScheduler({ storePath: second.storePath, intervalMs: 60_000 });
		try {
			oldStop();
			expect((await getAutomationsSnapshot(first.storePath)).schedulerStarted).toBe(true);
			otherStop();
			expect((await getAutomationsSnapshot(first.storePath)).schedulerStarted).toBe(true);
			expect((await getAutomationsSnapshot(second.storePath)).schedulerStarted).toBe(false);
		} finally {
			currentStop();
			otherStop();
		}
		// Finish startup I/O before the temporary directories are cleaned up.
		await vi.waitFor(async () => {
			expect(await fs.stat(`${first.storePath}.lock`).then(() => true, () => false)).toBe(false);
			expect(await fs.stat(`${second.storePath}.lock`).then(() => true, () => false)).toBe(false);
		});
	});
	it("creates a new session, sets preset/model, runs prompt, and saves run summary", async () => {
		const { storePath, workspaceDir } = await makeWorkspaceAndStore();
		const task = await createAutomationTask(
			{
				name: "Daily Status",
				prompt: "Check repo status",
				cwd: workspaceDir,
				schedule: { kind: "interval", every: 10, unit: "minutes" },
				toolPreset: "readonly",
				model: { provider: "openai", id: "gpt-5" },
			},
			storePath,
		);

		let listener: ((evt: WebEvent) => void) | null = null;
		const commands: unknown[] = [];
		const fakeManaged = { runActive: false, session: null, sm: { getEntries: () => [] } } as unknown as Managed;
		const sessionPath = path.join(workspaceDir, "sessions", "run-1.jsonl");

		const { run, done } = await launchAutomationTask(task, "manual", {
			storePath,
			deps: {
				createNewSession: vi.fn(async () => ({ sessionPath })),
				getManaged: vi.fn(() => fakeManaged),
				disposeSession: vi.fn(async () => {}),
				observeManagedEvents: vi.fn((_m, cb) => {
					listener = cb;
					return () => { listener = null; };
				}),
				execute: vi.fn(async (_m, cmd) => {
					commands.push(cmd);
					if (cmd.cmd === "prompt") {
						queueMicrotask(() => {
							listener?.({ type: "status", isStreaming: true, state: "running", ts: 1 });
							listener?.({
								type: "message",
								phase: "end",
								ts: 2,
								message: {
									role: "assistant",
									content: [{ type: "text", text: "Repo is clean on main." }],
									stopReason: "stop",
									timestamp: 2,
								},
							});
							listener?.({ type: "status", isStreaming: false, state: "idle", ts: 3 });
						});
					}
					return { ok: true };
				}),
			},
		});

		expect(run.status).toBe("running");
		const finished = await done;
		expect(finished?.status).toBe("success");
		expect(finished?.sessionPath).toBe(sessionPath);
		expect(finished?.summary).toBe("Repo is clean on main.");
		expect(commands.map((c: any) => c.cmd)).toEqual(["rename", "setToolPreset", "setModel", "prompt"]);
		expect((commands[1] as any).preset).toBe("readonly");
		expect((commands[2] as any)).toMatchObject({ cmd: "setModel", provider: "openai", modelId: "gpt-5" });
	});

	it("records assistant errors cleanly and rejects overlapping concurrent manual launches", async () => {
		const { storePath, workspaceDir } = await makeWorkspaceAndStore();
		const task = await createAutomationTask(
			{
				name: "Fail Cleanly",
				prompt: "Do something",
				cwd: workspaceDir,
				schedule: { kind: "interval", every: 1, unit: "hours" },
			},
			storePath,
		);

		let listener: ((evt: WebEvent) => void) | null = null;
		let releaseTurn!: () => void;
		const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
		const fakeManaged = { runActive: false, session: null, sm: { getEntries: () => [] } } as unknown as Managed;

		const first = await launchAutomationTask(task, "manual", {
			storePath,
			deps: {
				createNewSession: vi.fn(async () => ({ sessionPath: path.join(workspaceDir, "s2.jsonl") })),
				getManaged: vi.fn(() => fakeManaged),
				disposeSession: vi.fn(async () => {}),
				observeManagedEvents: vi.fn((_m, cb) => {
					listener = cb;
					return () => { listener = null; };
				}),
				execute: vi.fn(async (_m, cmd) => {
					if (cmd.cmd === "prompt") {
						void turnGate.then(() => {
							listener?.({ type: "status", isStreaming: true, state: "running", ts: 1 });
							listener?.({
								type: "message",
								phase: "end",
								ts: 2,
								message: {
									role: "assistant",
									content: [],
									stopReason: "error",
									errorMessage: "API key invalid",
									timestamp: 2,
								},
							});
							listener?.({ type: "status", isStreaming: false, state: "idle", ts: 3 });
						});
					}
					return { ok: true };
				}),
			},
		});

		await expect(launchAutomationTask(task, "manual", { storePath })).rejects.toBeInstanceOf(AutomationConflictError);
		releaseTurn();
		const done = await first.done;
		expect(done?.status).toBe("error");
		expect(done?.error).toBe("API key invalid");

		const snap = await listAutomations(storePath);
		expect(snap.tasks[0].lastRunStatus).toBe("error");
	});

	it("triggers due scheduled tasks on tick", async () => {
		const { storePath, workspaceDir } = await makeWorkspaceAndStore();
		const t0 = new Date(2026, 4, 10, 10, 0, 0, 0).getTime();
		await createAutomationTask(
			{
				name: "Every 5m",
				prompt: "Ping",
				cwd: workspaceDir,
				schedule: { kind: "interval", every: 5, unit: "minutes" },
			},
			storePath,
			t0,
		);

		let listener: ((evt: WebEvent) => void) | null = null;
		const fakeManaged = { runActive: false, session: null, sm: { getEntries: () => [] } } as unknown as Managed;
		const dueAt = t0 + 5 * 60_000 + 1_000;
		const runs = await runDueAutomations({
			now: dueAt,
			storePath,
			deps: {
				createNewSession: vi.fn(async () => ({ sessionPath: path.join(workspaceDir, "sched.jsonl") })),
				getManaged: vi.fn(() => fakeManaged),
				observeManagedEvents: vi.fn((_m, cb) => {
					listener = cb;
					return () => { listener = null; };
				}),
				execute: vi.fn(async (_m, cmd) => {
					if (cmd.cmd === "prompt") {
						queueMicrotask(() => {
							listener?.({ type: "status", isStreaming: true, state: "running", ts: 1 });
							listener?.({
								type: "message",
								phase: "end",
								ts: 2,
								message: { role: "assistant", content: [{ type: "text", text: "Pong" }], stopReason: "stop", timestamp: 2 },
							});
							listener?.({ type: "status", isStreaming: false, state: "idle", ts: 3 });
						});
					}
					return { ok: true };
				}),
			},
		});
		expect(runs).toHaveLength(1);
		// Next run advanced cleanly by 5m from dueAt, and wait for background run settlement before temp cleanup
		await vi.waitFor(async () => {
			const current = await listAutomations(storePath);
			expect(current.runs[0]?.status).toBe("success");
			expect(current.runs[0]?.summary).toBe("Pong");
			expect(current.tasks[0].nextRunAt).toBe(t0 + 10 * 60_000);
		});
	});
});
