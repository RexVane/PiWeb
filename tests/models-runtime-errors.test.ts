import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ runtime: undefined as unknown, root: "" }));
vi.mock("../src/lib/pi", () => ({ getModelRuntime: async () => mocks.runtime, getAgentDir: () => mocks.root, refreshModelRuntimeIfFilesChanged: async () => false, modelRuntimeVersion: () => 1 }));
import { invalidateModelList, listModels } from "../src/lib/models-service";
afterEach(async () => { invalidateModelList(); if (mocks.root) await fs.rm(mocks.root, { recursive: true, force: true }); mocks.root = ""; });
it("reports SDK configuration errors instead of a partial successful directory", async () => {
	mocks.runtime = { getError: () => "models.json provider is malformed" };
	await expect(listModels()).rejects.toThrow(/模型目录配置无效.*malformed/);
});
it("does not cache a temporary authentication probe failure as logged out for sixty seconds", async () => {
	mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-auth-probe-"));
	const check = vi.fn().mockRejectedValueOnce(new Error("temporary probe failure")).mockResolvedValueOnce({ source: "env" });
	mocks.runtime = { getError: () => undefined, getProviders: () => [{ id: "test", name: "Test" }], getModels: () => [], getProviderAuthStatus: () => ({ configured: true }), hasConfiguredAuth: () => true, checkAuth: check };
	const first = await listModels(); expect(first.providers[0].authError).toBe("temporary probe failure");
	// Only expire the short model list cache, keeping the distinct auth cache intact.
	const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 6000);
	try { const second = await listModels(); expect(second.providers[0].authReady).toBe(true); expect(check).toHaveBeenCalledTimes(2); }
	finally { vi.restoreAllMocks(); }
});
it("never executes configured credential commands just to list providers", async () => {
	mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-auth-command-"));
	await fs.writeFile(path.join(mocks.root, "models.json"), JSON.stringify({ providers: { test: { apiKey: "!should-never-run", baseUrl: "https://example.test", api: "openai-completions" } } }));
	const check = vi.fn();
	mocks.runtime = { getError: () => undefined, getProviders: () => [{ id: "test", name: "Test" }], getModels: () => [], getProviderAuthStatus: () => ({ configured: true }), hasConfiguredAuth: () => true, checkAuth: check };
	expect((await listModels()).providers[0].authError).toContain("打开目录不会执行");
	expect(check).not.toHaveBeenCalled();
});
