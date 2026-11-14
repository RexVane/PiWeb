import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { recycleTemporaryDirectory } from "../src/lib/recycle-temporary";

const state = vi.hoisted(() => ({ create: vi.fn(), refresh: vi.fn(), sessions: vi.fn(), reload: vi.fn() }));
vi.mock("../src/lib/model-runtime-safe", () => ({ createPiWebModelRuntime: state.create }));
vi.mock("../src/lib/session-model-runtime", () => ({ refreshSessionModelRuntimes: state.sessions }));
let root: string;
let pi: typeof import("../src/lib/pi");
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-export-refresh-")); });
afterAll(async () => { await recycleTemporaryDirectory(root); });
beforeEach(async () => {
	vi.resetModules();
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	state.refresh.mockReset().mockResolvedValue(undefined);
	state.sessions.mockReset().mockResolvedValue(undefined);
	state.reload.mockReset();
	state.create.mockReset().mockImplementation(async () => ({ refresh: state.refresh, credentials: { store: { reload: state.reload } } }));
	pi = await import("../src/lib/pi");
	await pi.getModelRuntime();
});
afterEach(() => { vi.unstubAllEnvs(); });
function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

it("joins a shared model refresh and does not expose its new generation before completion", async () => {
	const gate = deferred(); state.refresh.mockReturnValueOnce(gate.promise);
	const version = pi.modelRuntimeVersion();
	const first = pi.refreshModelRuntime();
	let finished = false;
	const second = pi.refreshModelRuntimeIfFilesChanged().then(() => { finished = true; });
	await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
	expect(finished).toBe(false);
	expect(pi.modelRuntimeVersion()).toBe(version);
	gate.resolve(); await Promise.all([first, second]);
	expect(finished).toBe(true); expect(state.reload).toHaveBeenCalledTimes(1); expect(state.sessions).toHaveBeenCalledTimes(1);
	expect(pi.modelRuntimeVersion()).toBe(version + 1);
});

it("refreshes again if a different write arrives during the shared refresh", async () => {
	const gate = deferred(); state.refresh.mockReturnValueOnce(gate.promise);
	const first = pi.refreshModelRuntime();
	await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
	await fs.writeFile(path.join(root, "models.json"), JSON.stringify({ revision: Date.now() }));
	const second = pi.refreshModelRuntimeIfFilesChanged();
	gate.resolve(); await Promise.all([first, second]);
	expect(state.refresh).toHaveBeenCalledTimes(2);
});

it("an explicit save waits for its new revision after joining an older refresh", async () => {
	const old = deferred(), saved = deferred();
	state.refresh.mockReturnValueOnce(old.promise).mockReturnValueOnce(saved.promise);
	const first = pi.refreshModelRuntime();
	await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
	await fs.writeFile(path.join(root, "models.json"), JSON.stringify({ revision: Date.now(), saved: true }));
	let applied = false;
	const second = pi.refreshModelRuntime().then(() => { applied = true; });
	old.resolve(); await first;
	await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(2));
	expect(applied).toBe(false);
	saved.resolve(); await second;
	expect(applied).toBe(true);
});

it.each(["save", "read"] as const)("a third %s waiter also awaits the replacement refresh", async (kind) => {
	const old = deferred(), saved = deferred();
	state.refresh.mockReturnValueOnce(old.promise).mockReturnValueOnce(saved.promise);
	const first = pi.refreshModelRuntime();
	await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
	await fs.writeFile(path.join(root, "models.json"), JSON.stringify({ revision: "third-waiter", kind }));
	const second = pi.refreshModelRuntime();
	let thirdFinished = false;
	const third = (kind === "save" ? pi.refreshModelRuntime() : pi.refreshModelRuntimeIfFilesChanged())
		.then(() => { thirdFinished = true; });
	try {
		old.resolve(); await first;
		await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(2));
		expect(thirdFinished).toBe(false);
	} finally {
		saved.resolve(); await Promise.all([second, third]);
	}
	expect(thirdFinished).toBe(true);
	expect(state.refresh).toHaveBeenCalledTimes(2);
});

it.each(["save", "read"] as const)("a third %s waiter receives a replacement refresh failure", async (kind) => {
	const old = deferred(), saved = deferred();
	const failure = new Error("replacement revision failed");
	state.refresh.mockReturnValueOnce(old.promise).mockReturnValueOnce(saved.promise);
	const first = pi.refreshModelRuntime();
	await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
	await fs.writeFile(path.join(root, "models.json"), JSON.stringify({ revision: "failed-handoff", kind }));
	const second = pi.refreshModelRuntime();
	const third = kind === "save" ? pi.refreshModelRuntime() : pi.refreshModelRuntimeIfFilesChanged();
	const settled = Promise.allSettled([second, third]);
	old.resolve(); await first;
	await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(2));
	saved.reject(failure);
	expect(await settled).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
	await pi.getModelRuntime();
	expect(state.create).toHaveBeenCalledTimes(2);
});

it("follows a second handoff when files change again before the replacement completes", async () => {
	const old = deferred(), middle = deferred(), latest = deferred();
	state.refresh.mockReturnValueOnce(old.promise).mockReturnValueOnce(middle.promise).mockReturnValueOnce(latest.promise);
	const first = pi.refreshModelRuntime();
	await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
	await fs.writeFile(path.join(root, "models.json"), '{"revision":"middle"}');
	const second = pi.refreshModelRuntime();
	let thirdFinished = false;
	const third = pi.refreshModelRuntimeIfFilesChanged().then(() => { thirdFinished = true; });
	try {
		old.resolve(); await first;
		await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(2));
		await fs.writeFile(path.join(root, "models.json"), '{"revision":"latest-revision"}');
		middle.resolve(); await second;
		await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(3));
		expect(thirdFinished).toBe(false);
	} finally {
		middle.resolve(); latest.resolve(); await Promise.all([second, third]);
	}
	expect(thirdFinished).toBe(true);
	expect(state.refresh).toHaveBeenCalledTimes(3);
});

it("keeps a revision pending until the session runtimes finish applying it", async () => {
	const sessions = deferred(); state.sessions.mockReturnValueOnce(sessions.promise);
	const version = pi.modelRuntimeVersion();
	const first = pi.refreshModelRuntime();
	let finished = false;
	const second = pi.refreshModelRuntimeIfFilesChanged().then(() => { finished = true; });
	try {
		await vi.waitFor(() => expect(state.sessions).toHaveBeenCalledTimes(1));
		expect(finished).toBe(false);
		expect(pi.modelRuntimeVersion()).toBe(version);
	} finally {
		sessions.resolve(); await Promise.all([first, second]);
	}
	expect(finished).toBe(true);
	expect(pi.modelRuntimeVersion()).toBe(version + 1);
});

it("clears a failed refresh so a later read can create a replacement runtime", async () => {
	state.refresh.mockRejectedValueOnce(new Error("fixture failed"));
	const one = pi.refreshModelRuntime();
	const two = pi.refreshModelRuntimeIfFilesChanged();
	await expect(one).rejects.toThrow("fixture failed");
	await expect(two).rejects.toThrow("fixture failed");
	await pi.getModelRuntime();
	expect(state.create).toHaveBeenCalledTimes(2);
	await pi.refreshModelRuntime();
	expect(state.refresh).toHaveBeenCalledTimes(2);
});
