import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { recycleGeneratedFixture } from "../fixtures/system-trash";

vi.mock("../../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

let root: string;
let pi: typeof import("../../src/lib/pi");
let manager: typeof import("../../src/lib/agent-manager");
const managed: import("../../src/lib/agent-manager").Managed[] = [];

beforeAll(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-discovery-recovery-")));
	const agent = path.join(root, "agent");
	await fs.mkdir(agent);
	await fs.writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", compaction: { enabled: false } }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in discovery recovery regressions"); }));
	vi.resetModules();
	pi = await import("../../src/lib/pi");
	manager = await import("../../src/lib/agent-manager");
}, 90_000);
afterEach(async () => {
	vi.restoreAllMocks();
	for (const m of managed.splice(0)) await manager.disposeSession(m);
});
afterAll(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await recycleGeneratedFixture(root);
});

async function workspace() {
	const cwd = await fs.mkdtemp(path.join(root, "workspace-"));
	await fs.writeFile(path.join(cwd, "AGENTS.md"), "Original discovery instructions.");
	return cwd;
}
async function flushBackground() {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("discovery loader recovery through the real Pi loader", () => {
	it("preserves an initial load's failure and retries only on the next readiness request", async () => {
		const cwd = await workspace();
		const loader = pi.getResourceLoader(cwd);
		const failure = new Error("Initial discovery is temporarily unavailable");
		const reload = vi.spyOn(loader, "reload").mockRejectedValueOnce(failure);
		await expect(pi.resourceLoaderReady(cwd)).rejects.toBe(failure);
		await flushBackground();
		expect(reload).toHaveBeenCalledTimes(1);
		expect(pi.resourceLoaderVersion(cwd)).toBe(0);
		expect(pi.resourceLoaderIsStale(cwd)).toBe(true);
		await pi.resourceLoaderReady(cwd);
		// First successful discovery may read twice to stabilize newly discovered source roots.
		const reads = reload.mock.calls.length;
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(reads).toBeLessThanOrEqual(3);
		expect(pi.resourceLoaderVersion(cwd)).toBe(1);
		expect(pi.resourceLoaderIsStale(cwd)).toBe(false);
		await flushBackground();
		expect(reload).toHaveBeenCalledTimes(reads);
	});

	it("keeps persistent failures bounded and shares one failed recovery across concurrent readers", async () => {
		const cwd = await workspace();
		await pi.resourceLoaderReady(cwd);
		const version = pi.resourceLoaderVersion(cwd);
		const failure = new Error("Discovery remains unavailable");
		const reload = vi.spyOn(pi.getResourceLoader(cwd), "reload").mockRejectedValue(failure);
		await expect(pi.reloadLoader(cwd)).rejects.toBe(failure);
		const results = await Promise.allSettled([pi.resourceLoaderReady(cwd), pi.resourceLoaderReady(cwd), pi.resourceLoaderReady(cwd)]);
		expect(results).toEqual(Array.from({ length: 3 }, () => ({ status: "rejected", reason: failure })));
		await flushBackground();
		expect(reload).toHaveBeenCalledTimes(2);
		expect(pi.resourceLoaderVersion(cwd)).toBe(version);
		expect(pi.resourceLoaderIsStale(cwd)).toBe(true);
		await expect(pi.resourceLoaderReady(cwd)).rejects.toBe(failure);
		await flushBackground();
		expect(reload).toHaveBeenCalledTimes(3);
	});

	it("shares one in-flight successful recovery across readiness and freshness requests", async () => {
		const cwd = await workspace();
		await pi.resourceLoaderReady(cwd);
		const version = pi.resourceLoaderVersion(cwd);
		const loader = pi.getResourceLoader(cwd);
		const reloadResources = loader.reload.bind(loader);
		const failure = new Error("Transient discovery failure");
		const reload = vi.spyOn(loader, "reload").mockRejectedValueOnce(failure);
		await expect(pi.reloadLoader(cwd)).rejects.toBe(failure);
		let entered = false;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		reload.mockImplementation(async (options) => { entered = true; await gate; await reloadResources(options); });
		const requests = [pi.resourceLoaderReady(cwd), pi.resourceLoaderReady(cwd), pi.refreshResourceLoaderIfStale(cwd)];
		try {
			await vi.waitFor(() => expect(entered).toBe(true));
			expect(reload).toHaveBeenCalledTimes(2);
		} finally { release(); }
		await Promise.all(requests);
		expect(reload).toHaveBeenCalledTimes(2);
		expect(pi.resourceLoaderVersion(cwd)).toBe(version + 1);
		expect(pi.resourceLoaderIsStale(cwd)).toBe(false);
	});

	it("does not let an older queued failure mark a newer successful reload as failed", async () => {
		const cwd = await workspace();
		await pi.resourceLoaderReady(cwd);
		const version = pi.resourceLoaderVersion(cwd);
		const loader = pi.getResourceLoader(cwd);
		const reloadResources = loader.reload.bind(loader);
		const failure = new Error("Older queued reload failed");
		let entered = false;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const reload = vi.spyOn(loader, "reload").mockImplementationOnce(async () => { entered = true; await gate; throw failure; }).mockImplementation(reloadResources);
		const first = pi.reloadLoader(cwd).catch((error: unknown) => error);
		await vi.waitFor(() => expect(entered).toBe(true));
		const second = pi.reloadLoader(cwd);
		const reader = pi.resourceLoaderReady(cwd);
		release();
		expect(await first).toBe(failure);
		await Promise.all([second, reader]);
		await pi.resourceLoaderReady(cwd);
		expect(reload).toHaveBeenCalledTimes(2);
		expect(pi.resourceLoaderVersion(cwd)).toBe(version + 1);
		expect(pi.resourceLoaderIsStale(cwd)).toBe(false);
	});

	it.each(["snapshot", "prompt"] as const)("recovers a transient discovery failure before the next %s uses updated session instructions", async (boundary) => {
		const cwd = await workspace();
		const { sessionPath } = await manager.createNewSession(cwd);
		const m = manager.getManaged(sessionPath);
		managed.push(m);
		const session = await manager.ensureSession(m);
		const discoveryReload = vi.spyOn(pi.getResourceLoader(cwd), "reload").mockRejectedValueOnce(new Error("Temporary discovery interruption"));
		const sessionReload = vi.spyOn(session.resourceLoader, "reload");
		const updated = "Updated instructions after the discovery interruption.";
		await fs.writeFile(path.join(cwd, "AGENTS.md"), updated);
		await expect(pi.reloadLoader(cwd)).rejects.toThrow("Temporary discovery interruption");
		await flushBackground();
		expect(discoveryReload).toHaveBeenCalledTimes(1);
		expect(session.systemPrompt).not.toContain(updated);
		if (boundary === "snapshot") await manager.buildSnapshot(m);
		else {
			const prompt = vi.spyOn(session, "prompt").mockImplementation(async (_text, options) => {
				expect(session.systemPrompt).toContain(updated);
				options?.preflightResult?.("started");
			});
			expect(await manager.execute(m, { cmd: "prompt", text: "Continue after recovery" })).toMatchObject({ ok: true });
			expect(prompt).toHaveBeenCalledTimes(1);
		}
		expect(discoveryReload).toHaveBeenCalledTimes(2);
		expect(sessionReload).toHaveBeenCalledTimes(1);
		expect(session.systemPrompt).toContain(updated);
		expect(m.resourceReloadPending).toBe(false);
		expect(m.resourceVersion).toBe(pi.resourceLoaderVersion(cwd));
	});
});
