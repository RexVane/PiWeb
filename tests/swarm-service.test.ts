import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
import { beginMaintenance, RuntimeBusyError } from "../src/lib/runtime-activity";
const worker = vi.hoisted(() => ({
  fail: false,
  failIndex: -1,
  holdIndex: -1,
  release: undefined as undefined | (() => void),
  denyRootTrust: false,
  root: "",
}));

vi.mock("../src/lib/pi", () => ({
  getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
  getModelRuntime: async () => ({}),
  getSettingsManager: () => ({}),
  resolveProjectTrust: (cwd: string) => ({ trusted: !(worker.denyRootTrust && cwd === worker.root) }),
  withResourceLock: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: class {
    async reload() { /* no project resources in this fixture */ }
    getExtensions() { return { runtime: { invalidate() { /* noop */ } } }; }
  },
  SessionManager: { inMemory: () => ({}) },
  defineTool: (tool: unknown) => tool,
  createAgentSession: async ({ cwd }: { cwd: string }) => ({
    session: {
      messages: [{ role: "assistant", stopReason: worker.fail || Number(path.basename(cwd)) === worker.failIndex ? "error" : "stop", errorMessage: worker.fail || Number(path.basename(cwd)) === worker.failIndex ? "provider unavailable" : undefined, content: [{ type: "text", text: "Changed file.txt" }] }],
      async prompt() {
        if (Number(path.basename(cwd)) === worker.holdIndex) await new Promise<void>((resolve) => { worker.release = resolve; });
        if (!worker.fail && Number(path.basename(cwd)) !== worker.failIndex) await fs.writeFile(path.join(cwd, "file.txt"), "worker change\n", "utf8");
      },
      async abort() { /* noop */ },
      dispose() { /* noop */ },
    },
  }),
}));

describe("isolated swarm patch lifecycle", () => {
  let root: string;
  let agentDir: string;
  let service: typeof import("../src/lib/swarm-service");

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-swarm-test-"));
    worker.root = root;
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-swarm-agent-test-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await exec("git", ["init", root], { windowsHide: true });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root, windowsHide: true });
    await exec("git", ["config", "user.name", "Test"], { cwd: root, windowsHide: true });
    await exec("git", ["config", "core.autocrlf", "false"], { cwd: root, windowsHide: true });
    await fs.writeFile(path.join(root, "file.txt"), "base\n");
    await fs.mkdir(path.join(root, "subdir"));
    await fs.writeFile(path.join(root, "subdir", ".keep"), "");
    await exec("git", ["add", "file.txt", "subdir/.keep"], { cwd: root, windowsHide: true });
    await exec("git", ["commit", "-m", "base"], { cwd: root, windowsHide: true });
    service = await import("../src/lib/swarm-service");
  });

  afterEach(async () => {
    worker.release?.();
    worker.release = undefined;
    worker.fail = false;
    worker.failIndex = -1;
    worker.holdIndex = -1;
    worker.denyRootTrust = false;
    await fs.writeFile(path.join(root, "file.txt"), "base\n");
  });

  afterAll(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const temp = path.resolve(os.tmpdir());
    if (root?.startsWith(`${temp}${path.sep}`)) await fs.rm(root, { recursive: true, force: true });
    if (agentDir?.startsWith(`${temp}${path.sep}`)) await fs.rm(agentDir, { recursive: true, force: true });
  });

  it("keeps worker changes isolated until one patch is accepted", async () => {
    const started = await service.startSwarm(root, [{ title: "Edit file", instruction: "Change file.txt" }]);
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("base\n");
    let job = started;
    for (let attempt = 0; attempt < 100 && job.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await service.getSwarm(started.id);
    }
    expect(job.status).toBe("completed");
    expect(job.tasks[0].status).toBe("completed");
    expect(job.tasks[0].patch).toContain("worker change");
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("base\n");
    await fs.writeFile(path.join(root, "file.txt"), "manual edit\n");
    await expect(service.acceptSwarmTask(started.id, 0, root)).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("manual edit\n");
    await fs.writeFile(path.join(root, "file.txt"), "base\n");
    const accepted = await service.acceptSwarmTask(started.id, 0, root);
    expect(accepted.tasks[0].accepted).toBe(true);
    expect((await service.getSwarm(started.id)).tasks[0].accepted).toBe(true);
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("worker change\n");
    await expect(service.acceptSwarmTask(started.id, 0, root)).rejects.toThrow("no unapplied patch");
  }, 30_000);

  it("does not allow accepting a finished task while another task is running", async () => {
    worker.holdIndex = 1;
    const started = await service.startSwarm(root, [
      { title: "First", instruction: "Change file.txt" },
      { title: "Second", instruction: "Change file.txt" },
    ]);
    try {
      expect(() => beginMaintenance()).toThrow(RuntimeBusyError);
      let job = started;
      for (let attempt = 0; attempt < 100 && (job.tasks[0].status !== "completed" || !worker.release); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        job = await service.getSwarm(started.id);
      }
      expect(job.status).toBe("running");
      expect(job.tasks[0].status).toBe("completed");
      expect(worker.release).toBeTypeOf("function");
      await expect(service.acceptSwarmTask(started.id, 0, root)).rejects.toThrow("wait for all swarm tasks");
      expect((await service.getSwarm(started.id)).tasks[0].accepted).not.toBe(true);
    } finally {
      worker.release?.();
    }
    let job = await service.getSwarm(started.id);
    for (let attempt = 0; attempt < 100 && job.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await service.getSwarm(started.id);
    }
    expect(job.status).toBe("completed");
    await vi.waitFor(() => { const release = beginMaintenance(); release(); });
    expect((await service.acceptSwarmTask(started.id, 0, root)).tasks[0].accepted).toBe(true);
  }, 30_000);

  it("marks a provider error response as failed instead of completed", async () => {
    worker.fail = true;
    const started = await service.startSwarm(root, [{ title: "Edit file", instruction: "Change file.txt" }]);
    let job = started;
    for (let attempt = 0; attempt < 100 && job.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await service.getSwarm(started.id);
    }
    expect(job.status).toBe("failed");
    expect(job.tasks[0].status).toBe("failed");
    expect(job.tasks[0].error).toContain("provider unavailable");
    expect(job.tasks[0].patch).toBeUndefined();
  }, 30_000);

  it("marks a partial worker failure as failed while preserving completed patches", async () => {
    worker.failIndex = 1;
    const started = await service.startSwarm(root, [
      { title: "First", instruction: "Change file.txt" },
      { title: "Second", instruction: "Change file.txt" },
    ]);
    let job = started;
    for (let attempt = 0; attempt < 100 && job.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await service.getSwarm(started.id);
    }
    expect(job.status).toBe("failed");
    expect(job.tasks[0].status).toBe("completed");
    expect(job.tasks[1].status).toBe("failed");
    expect((await service.acceptSwarmTask(started.id, 0, root)).tasks[0].accepted).toBe(true);
  }, 30_000);

  it("checks trust at the repository root even when started from a subdirectory", async () => {
    worker.denyRootTrust = true;
    await expect(service.startSwarm(path.join(root, "subdir"), [{ title: "Edit file", instruction: "Change file.txt" }]))
      .rejects.toThrow("trust this project");
  });
});
