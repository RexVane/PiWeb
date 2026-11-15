import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recycleFixture } from "./lib/sandbox/fixtures";

let agentDir: string;
type Timers = { timer?: ReturnType<typeof setTimeout>; repeat?: ReturnType<typeof setInterval>; running?: Promise<void> };
const state = globalThis as typeof globalThis & {
	__piWebReaper?: ReturnType<typeof setInterval>;
	__piWebArchivedRetention?: Timers;
};

beforeEach(async () => {
	agentDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-no-archive-cleanup-")));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.spyOn(os, "homedir").mockReturnValue(path.join(agentDir, "unrelated-home"));
});

afterEach(async () => {
	clearInterval(state.__piWebReaper);
	delete state.__piWebReaper;
	const legacy = state.__piWebArchivedRetention;
	clearTimeout(legacy?.timer); clearInterval(legacy?.repeat);
	await legacy?.running;
	delete state.__piWebArchivedRetention;
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await recycleFixture(agentDir);
});

it("keeps old archived session files and metadata when application background timers run", async () => {
	const directory = path.join(agentDir, "sessions", "--ws--");
	await fs.mkdir(directory, { recursive: true });
	const sessionPath = path.join(directory, "old.jsonl");
	const content = JSON.stringify({ type: "session", version: 3, id: "old", timestamp: new Date().toISOString(), cwd: "/ws" }) + "\n";
	await fs.writeFile(sessionPath, content);
	const archivedAt = Date.now() - 90 * 24 * 60 * 60 * 1000;
	await fs.utimes(sessionPath, new Date(archivedAt), new Date(archivedAt));
	const key = process.platform === "win32" ? sessionPath.toLowerCase() : sessionPath;
	const registry = path.join(agentDir, "web-workspaces.json");
	const original = JSON.stringify({ workspaces: [], archivedSessions: [sessionPath], archivedAt: { [key]: archivedAt } });
	await fs.writeFile(registry, original);
	vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
	await import("../src/lib/agent-manager");
	await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 5_000);
	// Await a legacy sweep if one regresses back into startup, so a pending
	// filesystem removal cannot produce a false pass.
	await state.__piWebArchivedRetention?.running;
	expect(await fs.readFile(sessionPath, "utf8")).toBe(content);
	expect(await fs.readFile(registry, "utf8")).toBe(original);
});
