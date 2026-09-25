import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { DefaultResourceLoader, SessionManager, createAgentSession, defineTool, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BoundaryError, isPathInside, resolveWorkspacePath, samePath } from "./path-security";
import { getAgentDir, getModelRuntime, getSettingsManager, resolveProjectTrust, withResourceLock } from "./pi";

const exec = promisify(execFile);
const STORE = path.join(getAgentDir(), "piweb-swarms");
const MAX_TASKS = 3;
const MAX_FILE_BYTES = 200_000;
const MAX_PATCH_BYTES = 2_000_000;
const TASK_TIMEOUT_MS = 10 * 60_000;
const jobs = new Map<string, SwarmJob>();
const controllers = new Map<string, AbortController>();
const saveQueues = new Map<string, Promise<void>>();
const accepting = new Set<string>();
const worktreeQueues = new Map<string, Promise<void>>();

export interface SwarmTaskInput { title: string; instruction: string }
export interface SwarmTask extends SwarmTaskInput {
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  report?: string;
  patch?: string;
  error?: string;
  accepted?: boolean;
}
export interface SwarmJob {
  id: string;
  cwd: string;
  root: string;
  base: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: number;
  finishedAt?: number;
  tasks: SwarmTask[];
}

function publicJob(job: SwarmJob): SwarmJob { return structuredClone(job); }
function jobFile(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new BoundaryError("invalid swarm id");
  return path.join(STORE, "jobs", `${id}.json`);
}
function save(job: SwarmJob): Promise<void> {
  const previous = saveQueues.get(job.id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const file = jobFile(job.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(job), "utf8");
    await fs.rename(tmp, file);
  });
  saveQueues.set(job.id, next);
  return next;
}
async function git(cwd: string, args: string[], maxBuffer = 4_000_000): Promise<string> {
  const result = await exec("git", args, {
    cwd, timeout: 30_000, maxBuffer, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout;
}
function worktreeGit(root: string, args: string[]): Promise<string> {
  const previous = worktreeQueues.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => git(root, args));
  worktreeQueues.set(root, next.then(() => undefined, () => undefined));
  return next;
}
function errorText(error: unknown): string {
  const value = error as { stderr?: unknown; message?: unknown };
  return String(value?.stderr || value?.message || error).trim().slice(0, 1000);
}
async function workspace(cwdValue: unknown): Promise<{ cwd: string; root: string; base: string }> {
  const cwd = await resolveWorkspacePath(cwdValue);
  const root = path.resolve((await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new BoundaryError("workspace is not a Git repository");
  })).trim());
  if (!isPathInside(root, cwd)) throw new BoundaryError("invalid repository root");
  if (!resolveProjectTrust(root).trusted) throw new BoundaryError("trust this project before running swarm tasks");
  const status = await git(root, ["status", "--porcelain", "-z"]);
  if (status) throw new BoundaryError("commit or stash workspace changes before starting a swarm");
  return { cwd, root, base: (await git(root, ["rev-parse", "HEAD"])).trim() };
}
function checkedInput(value: unknown): SwarmTaskInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TASKS) throw new BoundaryError("provide one to three tasks");
  return value.map((item) => {
    const title = item?.title;
    const instruction = item?.instruction;
    if (typeof title !== "string" || !title.trim() || title.length > 80 || typeof instruction !== "string" || !instruction.trim() || instruction.length > 4000) {
      throw new BoundaryError("invalid swarm task");
    }
    return { title: title.trim(), instruction: instruction.trim() };
  });
}
export async function resolveSwarmToolPath(root: string, value: string): Promise<string> {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new BoundaryError("invalid file path");
  const target = path.resolve(root, value);
  if (!isPathInside(root, target)) throw new BoundaryError("path escapes isolated worktree");
  const rel = path.relative(root, target).split(path.sep);
  if (rel.some((part) => part === ".git" || part === "node_modules")) throw new BoundaryError("protected worktree path");
  let ancestor = target;
  for (;;) {
    const real = await fs.realpath(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (real) {
      if (!isPathInside(root, real)) throw new BoundaryError("symlink escapes isolated worktree");
      break;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new BoundaryError("invalid worktree path");
    ancestor = parent;
  }
  return target;
}
function toolText(text: string) { return { content: [{ type: "text" as const, text }], details: undefined }; }
function fileTools(root: string): ToolDefinition[] {
  return [
    defineTool({
      name: "swarm_read", label: "Read isolated file", description: "Read a UTF-8 file inside this isolated worktree.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, args) {
        const file = await resolveSwarmToolPath(root, args.path);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new BoundaryError("file is not readable or is too large");
        return toolText(await fs.readFile(file, "utf8"));
      },
    }),
    defineTool({
      name: "swarm_list", label: "List isolated directory", description: "List files and directories inside this isolated worktree.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, args) {
        const dir = await resolveSwarmToolPath(root, args.path);
        const entries = (await fs.readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
          .slice(0, 200).map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);
        return toolText(entries.join("\n") || "(empty)");
      },
    }),
    defineTool({
      name: "swarm_search", label: "Search isolated files", description: "Find a literal text string in tracked source files inside this isolated worktree.",
      parameters: Type.Object({ query: Type.String(), path: Type.Optional(Type.String()) }),
      async execute(_id, args) {
        if (!args.query || args.query.length > 200) throw new BoundaryError("invalid search query");
        const start = await resolveSwarmToolPath(root, args.path || ".");
        const found: string[] = [];
        let scanned = 0;
        async function walk(dir: string): Promise<void> {
          if (scanned >= 1000 || found.length >= 100) return;
          for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(file);
            else if (entry.isFile()) {
              scanned += 1;
              if ((await fs.stat(file)).size > MAX_FILE_BYTES) continue;
              const content = await fs.readFile(file, "utf8");
              content.split("\n").forEach((line, index) => {
                if (found.length < 100 && line.includes(args.query)) found.push(`${path.relative(root, file)}:${index + 1}: ${line.slice(0, 300)}`);
              });
            }
            if (scanned >= 1000 || found.length >= 100) break;
          }
        }
        const stat = await fs.stat(start);
        if (stat.isDirectory()) await walk(start);
        else if (stat.isFile()) {
          const content = await fs.readFile(start, "utf8");
          content.split("\n").forEach((line, index) => {
            if (found.length < 100 && line.includes(args.query)) found.push(`${path.relative(root, start)}:${index + 1}: ${line.slice(0, 300)}`);
          });
        }
        return toolText(found.join("\n") || "No matches");
      },
    }),
    defineTool({
      name: "swarm_edit", label: "Edit isolated file", description: "Replace one exact, unique text occurrence in an isolated file.",
      executionMode: "sequential",
      parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
      async execute(_id, args) {
        const file = await resolveSwarmToolPath(root, args.path);
        if (!args.oldText || args.newText.length > MAX_FILE_BYTES) throw new BoundaryError("invalid edit");
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new BoundaryError("file is not editable or is too large");
        const before = await fs.readFile(file, "utf8");
        const offset = before.indexOf(args.oldText);
        if (offset < 0 || before.indexOf(args.oldText, offset + 1) >= 0) throw new BoundaryError("oldText must match exactly once");
        const after = before.slice(0, offset) + args.newText + before.slice(offset + args.oldText.length);
        if (Buffer.byteLength(after) > MAX_FILE_BYTES) throw new BoundaryError("edited file is too large");
        await fs.writeFile(file, after, "utf8");
        return toolText(`Updated ${path.relative(root, file)}`);
      },
    }),
    defineTool({
      name: "swarm_write", label: "Write isolated file", description: "Create or replace a UTF-8 file inside this isolated worktree.",
      executionMode: "sequential",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_id, args) {
        if (Buffer.byteLength(args.content) > MAX_FILE_BYTES) throw new BoundaryError("file is too large");
        const file = await resolveSwarmToolPath(root, args.path);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, args.content, "utf8");
        return toolText(`Wrote ${path.relative(root, file)}`);
      },
    }),
  ];
}
function reportOf(session: AgentSession): string {
  const answer = [...session.messages].reverse().find((message) => message.role === "assistant");
  if (!answer || answer.role !== "assistant") throw new Error("agent returned no assistant response");
  if (answer.stopReason !== "stop") throw new Error(answer.errorMessage || `agent stopped: ${answer.stopReason}`);
  return answer.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").slice(0, 20_000);
}
async function runTask(job: SwarmJob, index: number, signal: AbortSignal): Promise<void> {
  const task = job.tasks[index];
  const worktree = path.join(STORE, "worktrees", job.id, String(index));
  let created = false;
  let child: AgentSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    if (signal.aborted) throw new Error("cancelled");
    task.status = "running";
    await save(job);
    await fs.mkdir(path.dirname(worktree), { recursive: true });
    await worktreeGit(job.root, ["worktree", "add", "--detach", worktree, job.base]);
    created = true;
    if (signal.aborted) throw new Error("cancelled");
    const loader = new DefaultResourceLoader({
      cwd: worktree, agentDir: getAgentDir(), settingsManager: getSettingsManager(worktree),
      noExtensions: true, noPromptTemplates: true, noThemes: true,
      appendSystemPrompt: ["You are a PiWeb swarm worker in an isolated Git worktree. Use only swarm_* tools. Never access other directories. Make only the assigned changes, then report what changed and what you could not verify. Do not claim tests ran; no command execution is available."],
    });
    try {
      await withResourceLock(() => loader.reload());
      if (signal.aborted) throw new Error("cancelled");
      const result = await createAgentSession({
        cwd: worktree, agentDir: getAgentDir(), sessionManager: SessionManager.inMemory(worktree),
        modelRuntime: await getModelRuntime(), settingsManager: getSettingsManager(worktree),
        resourceLoader: loader, tools: ["swarm_read", "swarm_list", "swarm_search", "swarm_edit", "swarm_write"],
        customTools: fileTools(worktree),
      });
      child = result.session;
      if (signal.aborted) throw new Error("cancelled");
      const abort = () => { void child?.abort().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { timedOut = true; abort(); }, TASK_TIMEOUT_MS);
      try { await child.prompt(`${task.title}\n\n${task.instruction}`, { source: "rpc", expandPromptTemplates: false }); }
      finally { signal.removeEventListener("abort", abort); }
      if (timedOut) throw new Error("task timed out after ten minutes");
      if (signal.aborted) throw new Error("cancelled");
      task.report = reportOf(child);
      await git(worktree, ["add", "-N", "--", "."]);
      const patch = await git(worktree, ["diff", "--binary", "HEAD", "--", "."], MAX_PATCH_BYTES + 1024);
      if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Error("patch exceeds 2 MB limit");
      task.patch = patch;
      task.status = "completed";
    } finally {
      child?.dispose();
      loader.getExtensions().runtime.invalidate();
    }
  } catch (error) {
    task.status = signal.aborted ? "cancelled" : "failed";
    task.error = errorText(error);
  } finally {
    if (timer) clearTimeout(timer);
    if (created) await worktreeGit(job.root, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
    if (isPathInside(path.join(STORE, "worktrees"), worktree)) await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined);
    await save(job);
  }
}
export async function startSwarm(cwdValue: unknown, taskValue: unknown): Promise<SwarmJob> {
  const tasks = checkedInput(taskValue);
  const { cwd, root, base } = await workspace(cwdValue);
  if ([...jobs.values()].some((job) => samePath(job.root, root) && job.status === "running")) throw new BoundaryError("a swarm is already running for this repository");
  const job: SwarmJob = { id: randomUUID(), cwd, root, base, status: "running", createdAt: Date.now(), tasks: tasks.map((task) => ({ ...task, status: "pending" })) };
  jobs.set(job.id, job);
  const controller = new AbortController();
  controllers.set(job.id, controller);
  try {
    await save(job);
  } catch (error) {
    controllers.delete(job.id);
    jobs.delete(job.id);
    throw error;
  }
  void Promise.all(job.tasks.map((_, index) => runTask(job, index, controller.signal))).then(async () => {
    job.status = controller.signal.aborted ? "cancelled" : job.tasks.every((task) => task.status === "completed") ? "completed" : "failed";
    job.finishedAt = Date.now();
    controllers.delete(job.id);
    await save(job);
  }).catch(async () => {
    job.status = "failed";
    job.finishedAt = Date.now();
    controllers.delete(job.id);
    await save(job).catch(() => undefined);
  });
  return publicJob(job);
}
export async function getSwarm(id: string): Promise<SwarmJob> {
  const live = jobs.get(id);
  if (live) return publicJob(live);
  const raw = await fs.readFile(jobFile(id), "utf8").catch(() => { throw new BoundaryError("swarm not found"); });
  const job = JSON.parse(raw) as SwarmJob;
  if (job.status === "running") job.status = "interrupted";
  return publicJob(job);
}
export async function listSwarms(cwdValue: unknown): Promise<SwarmJob[]> {
  const cwd = await resolveWorkspacePath(cwdValue);
  const files = await fs.readdir(path.join(STORE, "jobs")).catch(() => []);
  const loaded = await Promise.all(files.filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).map((name) => getSwarm(name.slice(0, -5)).catch(() => null)));
  return loaded.filter((job): job is SwarmJob => !!job && samePath(job.cwd, cwd)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}
export async function cancelSwarm(id: string, cwdValue: unknown): Promise<SwarmJob> {
  const job = await getSwarm(id);
  const cwd = await resolveWorkspacePath(cwdValue);
  if (!samePath(job.cwd, cwd)) throw new BoundaryError("swarm belongs to another workspace");
  const controller = controllers.get(id);
  if (!controller || job.status !== "running") throw new BoundaryError("swarm is not running");
  controller.abort();
  return getSwarm(id);
}
export async function acceptSwarmTask(id: string, index: number, cwdValue: unknown): Promise<SwarmJob> {
  const job = jobs.get(id) ?? await getSwarm(id);
  const cwd = await resolveWorkspacePath(cwdValue);
  if (!samePath(job.cwd, cwd)) throw new BoundaryError("swarm belongs to another workspace");
  if (job.status === "running") throw new BoundaryError("wait for all swarm tasks to finish before accepting changes");
  if (!resolveProjectTrust(job.root).trusted) throw new BoundaryError("trust this project before accepting changes");
  if (!Number.isInteger(index) || index < 0 || index >= job.tasks.length) throw new BoundaryError("invalid task index");
  const task = job.tasks[index];
  if (task.status !== "completed" || !task.patch || task.accepted) throw new BoundaryError("task has no unapplied patch");
  if (accepting.has(job.root)) throw new BoundaryError("another patch is being accepted");
  accepting.add(job.root);
  const patchFile = path.join(STORE, `accept-${randomUUID()}.patch`);
  try {
    const head = (await git(job.root, ["rev-parse", "HEAD"])).trim();
    if (head !== job.base) throw new BoundaryError("repository HEAD changed; review the patch again before applying");
    await fs.mkdir(STORE, { recursive: true });
    await fs.writeFile(patchFile, task.patch, "utf8");
    await git(job.root, ["apply", "--check", "--binary", patchFile]);
    await git(job.root, ["apply", "--binary", patchFile]);
    task.accepted = true;
    jobs.set(id, job);
    await save(job);
    return publicJob(job);
  } finally {
    accepting.delete(job.root);
    if (isPathInside(STORE, patchFile)) await fs.rm(patchFile, { force: true }).catch(() => undefined);
  }
}
