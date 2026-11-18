import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { recycleFixture } from "./fixtures/recycle";

vi.mock("../src/lib/growth-tracker", () => ({ GROWTH_TRACKER_VERSION: 1, createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, dispose: () => {} }) }));

type Managed = ReturnType<typeof import("../src/lib/agent-manager")["getManaged"]>;
type Control = { starts: number; shutdowns: number; armed: boolean; entered: boolean; released: boolean; gate: Promise<void> };
const state = globalThis as typeof globalThis & { __piwebLifecycleFixture?: Control; __piWebSessions: Map<string, Managed> };
let root: string, cwd: string;
let manager: typeof import("../src/lib/agent-manager");
const instances: Managed[] = [];
let release = () => {};

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-managed-lifecycle-"));
	cwd = path.join(root, "workspace");
	const agent = path.join(root, "agent");
	await fs.mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
	await fs.mkdir(agent);
	await fs.writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", compaction: { enabled: false } }));
	await fs.writeFile(path.join(cwd, ".pi", "extensions", "lifecycle.js"), `export default function(pi) {
		pi.on("session_start", () => { if (globalThis.__piwebLifecycleFixture) globalThis.__piwebLifecycleFixture.starts++; });
		pi.on("session_shutdown", async () => { const control = globalThis.__piwebLifecycleFixture; if (!control) return; control.shutdowns++; if (!control.armed) return; control.armed = false; control.entered = true; await control.gate; pi.appendEntry("old_shutdown_tail", { saved: true }); control.released = true; });
	}`);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in lifecycle regression"); }));
	manager = await import("../src/lib/agent-manager");
}, 90_000);

afterAll(async () => {
	release();
	delete state.__piwebLifecycleFixture;
	for (const m of instances) await manager.disposeSession(m);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await recycleFixture(root);
});

async function cold() {
	const { sessionPath } = await manager.createNewSession(cwd);
	const m = manager.getManaged(sessionPath);
	instances.push(m);
	return m;
}

it("evicts the least recently used cold sessions past 64 while preserving viewed sessions", async () => {
	const coldSessions: Managed[] = [];
	for (let index = 0; index < 70; index++) {
		const m = await cold();
		m.lastActive = index;
		if (index === 0) manager.holdViewer(m, 60_000);
		coldSessions.push(m);
	}
	const retained = [...state.__piWebSessions.values()].filter((m) => !m.session && !m.creating && !m.disposed);
	expect(retained).toHaveLength(64);
	expect(coldSessions[0].disposed).toBe(false);
	for (const m of coldSessions.slice(1, 7)) expect(m.disposed).toBe(true);
	for (const m of coldSessions.slice(7)) expect(m.disposed).toBe(false);
	for (const m of coldSessions) await manager.disposeSession(m);
});

it("joins repeated disposal and waits for the old shutdown hook before reopening the same file", async () => {
	const control: Control = { starts: 0, shutdowns: 0, armed: true, entered: false, released: false, gate: new Promise<void>((resolve) => { release = resolve; }) };
	state.__piwebLifecycleFixture = control;
	const old = await cold();
	old.sm.appendMessage({ role: "user", content: "seed saved session", timestamp: Date.now() });
	const original = await manager.ensureSession(old);
	expect(control.starts).toBe(1);
	const dispose = vi.spyOn(original, "dispose");
	const first = manager.disposeSession(old);
	const second = manager.disposeSession(old);
	expect(second).toBe(first);
	let firstDone = false, pathDone = false, reopened = false;
	void first.then(() => { firstDone = true; });
	const joined = manager.disposeSessionPath(old.sessionPath).then(() => { pathDone = true; });
	await vi.waitFor(() => expect(control.entered).toBe(true));
	const fresh = manager.getManaged(old.sessionPath);
	instances.push(fresh);
	const open = manager.ensureSession(fresh).then((session) => { reopened = true; return session; });
	try {
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(firstDone).toBe(false);
		expect(pathDone).toBe(false);
		expect(reopened).toBe(false);
		expect(control.starts).toBe(1);
		expect(dispose).not.toHaveBeenCalled();
	} finally { release(); }
	const next = await open;
	await Promise.all([first, second, joined]);
	expect(control.released).toBe(true);
	expect(dispose).toHaveBeenCalledTimes(1);
	expect(next).not.toBe(original);
	expect(control.starts).toBe(2);
	expect(fresh.sm.getEntries()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "custom", customType: "old_shutdown_tail", data: { saved: true } })]));
	dispose.mockRestore();
});

it("refuses a new prompt while the user's command remains active", async () => {
	const m = await cold();
	m.bashActive = true;
	try {
		expect(await manager.execute(m, { cmd: "prompt", text: "must wait for the command" })).toMatchObject({ ok: false, error: "session is busy accepting another command" });
		expect(m.session).toBeNull();
		expect(m.promptSubmitting).toBe(false);
	} finally { m.bashActive = false; }
});
