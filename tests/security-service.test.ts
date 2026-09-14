import fs from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSettingsManager: vi.fn(), reloadSettingsManagers: vi.fn(), syncProjectTrust: vi.fn(),
	reloadAllLoaders: vi.fn(), reloadSessionsForCwd: vi.fn(),
}));
vi.mock("../src/lib/pi", () => ({
	getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
	getSettingsManager: mocks.getSettingsManager,
	reloadSettingsManagers: mocks.reloadSettingsManagers,
	syncProjectTrust: mocks.syncProjectTrust,
	reloadAllLoaders: mocks.reloadAllLoaders,
}));
vi.mock("../src/lib/agent-manager", () => ({ reloadSessionsForCwd: mocks.reloadSessionsForCwd }));

import { getSecurity, setProjectTrust } from "../src/lib/security-service";
import { PUT } from "../src/app/api/security/route";

it("uses the default only for a missing settings file, not a damaged one", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-security-settings-"));
	const file = path.join(agentDir, "settings.json");
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		expect(await getSecurity()).toEqual({ defaultProjectTrust: "ask" });
		await fs.writeFile(file, JSON.stringify({ defaultProjectTrust: "never" }));
		expect(await getSecurity()).toEqual({ defaultProjectTrust: "never" });
		await fs.writeFile(file, "{broken json");
		await expect(getSecurity()).rejects.toThrow();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

describe("SDK trust persistence", () => {
	let agentDir: string;
	let file: string;
	let manager: SettingsManager;
	let mode: "ok" | "deny" | "drop";
	let readError: Error | undefined;

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-security-write-"));
		file = path.join(agentDir, "settings.json");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		await fs.writeFile(file, JSON.stringify({ defaultProjectTrust: "always", theme: "dark" }));
		mode = "ok";
		readError = undefined;
		// Real SettingsManager: the storage contract throws, but setters/flush only
		// record errors, matching a filesystem EACCES without platform-specific chmod.
		manager = SettingsManager.fromStorage({
			withLock(scope, update) {
				if (scope === "project") { update(undefined); return; }
				if (readError) throw readError;
				const current = readFileSync(file, "utf8");
				const next = update(current);
				if (next === undefined) return;
				if (mode === "deny") throw Object.assign(new Error("EACCES: settings write denied"), { code: "EACCES" });
				if (mode === "ok") writeFileSync(file, next, "utf8");
			},
		});
		mocks.getSettingsManager.mockReset().mockReturnValue(manager);
		mocks.reloadSettingsManagers.mockReset().mockImplementation(async () => { await manager.reload(); });
		mocks.syncProjectTrust.mockReset();
		mocks.reloadAllLoaders.mockReset().mockResolvedValue([]);
		mocks.reloadSessionsForCwd.mockReset().mockResolvedValue(0);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	function expectNoResourceReload() {
		expect(mocks.reloadSettingsManagers).not.toHaveBeenCalled();
		expect(mocks.syncProjectTrust).not.toHaveBeenCalled();
		expect(mocks.reloadAllLoaders).not.toHaveBeenCalled();
		expect(mocks.reloadSessionsForCwd).not.toHaveBeenCalled();
	}

	it("flushes and verifies persistence before applying the new trust to sessions", async () => {
		mocks.syncProjectTrust.mockImplementation(() => {
			expect(JSON.parse(readFileSync(file, "utf8")).defaultProjectTrust).toBe("never");
		});
		await setProjectTrust("never");
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ defaultProjectTrust: "never", theme: "dark" });
		expect(mocks.syncProjectTrust).toHaveBeenCalledOnce();
		expect(mocks.reloadAllLoaders).toHaveBeenCalledOnce();
		expect(mocks.reloadSessionsForCwd).toHaveBeenCalledOnce();
		expect(manager.drainErrors()).toEqual([]);
	});

	it("surfaces swallowed SDK write errors and does not reload resources", async () => {
		mode = "deny";
		await expect(setProjectTrust("never")).rejects.toThrow("EACCES");
		expect(await getSecurity()).toEqual({ defaultProjectTrust: "always" });
		expectNoResourceReload();
		expect(manager.drainErrors()).toEqual([]);
	});

	it("does not claim success for a storage backend silently dropping writes", async () => {
		mode = "drop";
		await expect(setProjectTrust("never")).rejects.toThrow("not persisted");
		expect(await getSecurity()).toEqual({ defaultProjectTrust: "always" });
		expectNoResourceReload();
	});

	it("propagates SDK reload/load errors before calling the trust setter", async () => {
		readError = new Error("EACCES: settings read denied");
		const setter = vi.spyOn(manager, "setDefaultProjectTrust");
		await expect(setProjectTrust("never")).rejects.toThrow("EACCES");
		expect(setter).not.toHaveBeenCalled();
		expectNoResourceReload();
	});

	it("rejects malformed files rather than allowing the SDK to replace them", async () => {
		await fs.writeFile(file, "{broken json");
		const setter = vi.spyOn(manager, "setDefaultProjectTrust");
		await expect(setProjectTrust("never")).rejects.toThrow();
		expect(setter).not.toHaveBeenCalled();
		expect(await fs.readFile(file, "utf8")).toBe("{broken json");
		expectNoResourceReload();
	});

	it("returns an API error instead of 200 when the disk still says always", async () => {
		mode = "deny";
		const response = await PUT(new Request("http://localhost/api/security", {
			method: "PUT", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ defaultProjectTrust: "never" }),
		}));
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining("EACCES") });
		expect(await getSecurity()).toEqual({ defaultProjectTrust: "always" });
		expectNoResourceReload();
	});

	it("surfaces errors recorded during the post-write reload before trusting resources", async () => {
		mocks.reloadSettingsManagers.mockImplementation(async () => {
			readError = new Error("post-write settings reload failed");
			await manager.reload();
		});
		await expect(setProjectTrust("never")).rejects.toThrow("post-write settings reload failed");
		expect(mocks.syncProjectTrust).not.toHaveBeenCalled();
		expect(mocks.reloadAllLoaders).not.toHaveBeenCalled();
		expect(mocks.reloadSessionsForCwd).not.toHaveBeenCalled();
	});
});
