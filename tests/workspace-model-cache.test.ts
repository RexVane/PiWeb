import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { recycleTemporaryDirectory } from "../src/lib/recycle-temporary";

const state = vi.hoisted(() => ({
	agentDir: "", version: 1, trusted: true, name: "Base", authenticated: false,
	loaders: new Map<string, { version: number; providers: Array<{ name: string; config: { name: string } }> }>(),
	objects: new Map<string, object>(), refresh: vi.fn(), create: vi.fn(), release: vi.fn(), prepare: vi.fn(),
}));
vi.mock("../src/lib/pi", () => ({
	getAgentDir: () => state.agentDir,
	getModelRuntime: async () => ({}), modelRuntimeVersion: () => state.version,
	refreshModelRuntimeIfFilesChanged: async () => false,
	resolveProjectTrust: () => ({ required: true, trusted: state.trusted }),
	resourceLoaderReady: async () => {},
	refreshResourceLoaderIfStale: (...args: unknown[]) => state.prepare(...args),
	resourceLoaderVersion: (cwd: string) => state.loaders.get(cwd)?.version ?? 1,
	withResourceLock: async (run: () => unknown) => run(),
	getResourceLoader: (cwd: string) => {
		let loader = state.objects.get(cwd);
		if (!loader) {
			loader = { getExtensions: () => ({ runtime: { pendingProviderRegistrations: state.trusted ? state.loaders.get(cwd)?.providers ?? [] : [], pendingNativeProviderRegistrations: [], pendingVirtualModelRegistrations: [] } }) };
			state.objects.set(cwd, loader);
		}
		return loader;
	},
}));
vi.mock("../src/lib/session-model-runtime", () => ({
	createSessionModelRuntime: (...args: unknown[]) => state.create(...args),
	releaseSessionModelRuntime: (...args: unknown[]) => state.release(...args),
}));
vi.mock("../src/lib/models/model-scope", () => ({
	filterModelsByPiScope: async (models: Array<{ provider: string; id: string }>, patterns: string[]) => models.filter((model) => patterns.includes(`${model.provider}/${model.id}`)),
}));
import { invalidateModelList, listWorkspaceModelsForPiWeb } from "../src/lib/models-service";

let root: string;
let workspace: string;
let count = 0;
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-export-model-cache-")); });
afterAll(async () => { await recycleTemporaryDirectory(root); });
beforeEach(async () => {
	invalidateModelList();
	state.agentDir = path.join(root, String(++count), "agent");
	workspace = path.join(root, String(count), "workspace");
	await fs.mkdir(state.agentDir, { recursive: true });
	await fs.mkdir(workspace, { recursive: true });
	state.version = 1; state.trusted = true; state.name = "Base"; state.authenticated = false;
	state.loaders.clear(); state.objects.clear();
	state.prepare.mockReset().mockResolvedValue(false);
	state.release.mockReset().mockResolvedValue(undefined);
	state.refresh.mockReset().mockResolvedValue(undefined);
	state.create.mockReset().mockImplementation(async () => {
		const name = state.name, authenticated = state.authenticated;
		const providers = [{ id: "base", name }];
		return {
			registerProvider: (id: string, config: { name: string }) => providers.push({ id, name: config.name }),
			registerNativeProvider: () => {}, registerVirtualModel: () => {},
			refresh: () => state.refresh(), getError: () => undefined, getProviders: () => providers,
			getProviderAuthStatus: () => ({ configured: authenticated }), hasConfiguredAuth: () => authenticated,
			checkAuth: async () => authenticated ? { source: "fixture" } : undefined,
			getModels: (id: string) => [{ id: "model", name: providers.find((provider) => provider.id === id)!.name, provider: id, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 8192 }],
		};
	});
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in model cache regression"); }));
});
afterEach(() => { invalidateModelList(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
async function replaceSameSize(file: string, first: string, second: string) {
	expect(Buffer.byteLength(first)).toBe(Buffer.byteLength(second));
	await fs.writeFile(file, first);
	const stat = await fs.stat(file);
	return async () => { await fs.writeFile(file, second); await fs.utimes(file, stat.atime, stat.mtime); };
}

it("joins concurrent readers and reuses only an immutable data snapshot", async () => {
	const gate = deferred(); state.refresh.mockImplementationOnce(() => gate.promise);
	const reads = Array.from({ length: 8 }, () => listWorkspaceModelsForPiWeb(workspace));
	await vi.waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
	gate.resolve();
	const results = await Promise.all(reads);
	expect(results.every((value) => value === results[0])).toBe(true);
	expect(await listWorkspaceModelsForPiWeb(path.join(workspace, "."))).toBe(results[0]);
	expect(state.create).toHaveBeenCalledTimes(1); expect(state.release).toHaveBeenCalledTimes(1);
	expect(() => results[0].models[0].input.push("image")).toThrow();
});

it("isolates same-named providers by workspace and agent directory", async () => {
	const other = path.join(path.dirname(workspace), "other"); await fs.mkdir(other);
	state.loaders.set(workspace, { version: 1, providers: [{ name: "private", config: { name: "Workspace A" } }] });
	state.loaders.set(other, { version: 1, providers: [{ name: "private", config: { name: "Workspace B" } }] });
	const a = await listWorkspaceModelsForPiWeb(workspace), b = await listWorkspaceModelsForPiWeb(other);
	expect(a.models.find((model) => model.provider === "private")?.name).toBe("Workspace A");
	expect(b.models.find((model) => model.provider === "private")?.name).toBe("Workspace B");
	state.agentDir = path.join(root, String(count), "second-agent"); await fs.mkdir(state.agentDir);
	state.name = "Second profile";
	expect((await listWorkspaceModelsForPiWeb(workspace)).models.find((model) => model.provider === "base")?.name).toBe("Second profile");
	expect(state.create).toHaveBeenCalledTimes(3);
});

it("invalidates same-size credential rewrites even when the old mtime is restored", async () => {
	const rewrite = await replaceSameSize(path.join(state.agentDir, "auth.json"), '{"a":1}', '{"a":2}');
	expect((await listWorkspaceModelsForPiWeb(workspace)).providers[0].authReady).toBe(false);
	await rewrite(); state.authenticated = true;
	expect((await listWorkspaceModelsForPiWeb(workspace)).providers[0].authReady).toBe(true);
	expect(state.create).toHaveBeenCalledTimes(2);
});

it("rechecks trust immediately and drops providers after trust is revoked", async () => {
	state.loaders.set(workspace, { version: 1, providers: [{ name: "private", config: { name: "Private" } }] });
	expect((await listWorkspaceModelsForPiWeb(workspace)).models.some((model) => model.provider === "private")).toBe(true);
	state.trusted = false;
	expect((await listWorkspaceModelsForPiWeb(workspace)).models.some((model) => model.provider === "private")).toBe(false);
	expect(state.prepare).toHaveBeenLastCalledWith(workspace, { fresh: true });
});

it("uses edited BOM/JSONC model filters immediately and detects project settings rewrites", async () => {
	state.loaders.set(workspace, { version: 1, providers: [{ name: "private", config: { name: "Private" } }] });
	await listWorkspaceModelsForPiWeb(workspace);
	await fs.writeFile(path.join(state.agentDir, "settings.json"), '\uFEFF{ // picker scope\n "enabledModels": ["private/model"],\n}');
	expect((await listWorkspaceModelsForPiWeb(workspace)).models.map((model) => model.provider)).toEqual(["private"]);
	await fs.mkdir(path.join(workspace, ".pi"));
	const rewrite = await replaceSameSize(path.join(workspace, ".pi", "settings.json"), '{"a":1}', '{"a":2}');
	await listWorkspaceModelsForPiWeb(workspace);
	await rewrite(); await listWorkspaceModelsForPiWeb(workspace);
	expect(state.create).toHaveBeenCalledTimes(4);
	expect(state.prepare).toHaveBeenLastCalledWith(workspace, { fresh: true });
});

it("invalidates resource/model generations, models-store edits, and explicit refreshes", async () => {
	await listWorkspaceModelsForPiWeb(workspace);
	state.loaders.set(workspace, { version: 2, providers: [] }); await listWorkspaceModelsForPiWeb(workspace);
	state.version += 1; await listWorkspaceModelsForPiWeb(workspace);
	await fs.writeFile(path.join(state.agentDir, "models-store.json"), "{}"); await listWorkspaceModelsForPiWeb(workspace);
	invalidateModelList(); await listWorkspaceModelsForPiWeb(workspace);
	expect(state.create).toHaveBeenCalledTimes(5);
});

it("discards a result when its input changes while the private runtime is building", async () => {
	const gate = deferred(); state.refresh.mockImplementationOnce(() => gate.promise);
	const read = listWorkspaceModelsForPiWeb(workspace);
	await vi.waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
	state.name = "Changed"; state.version += 1; gate.resolve();
	expect((await read).models[0].name).toBe("Changed");
	expect(state.create).toHaveBeenCalledTimes(2); expect(state.release).toHaveBeenCalledTimes(2);
});

it("does not serve an obsolete successful result after refresh fails and can retry", async () => {
	await listWorkspaceModelsForPiWeb(workspace);
	state.version += 1; state.refresh.mockRejectedValueOnce(new Error("fixture refresh failed"));
	await expect(listWorkspaceModelsForPiWeb(workspace)).rejects.toThrow("fixture refresh failed");
	state.name = "Recovered";
	expect((await listWorkspaceModelsForPiWeb(workspace)).models[0].name).toBe("Recovered");
	expect(state.create).toHaveBeenCalledTimes(3); expect(state.release).toHaveBeenCalledTimes(3);
});

it("expires short-lived snapshots without retaining private runtimes", async () => {
	await listWorkspaceModelsForPiWeb(workspace);
	const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 6_000);
	await listWorkspaceModelsForPiWeb(workspace);
	expect(state.create).toHaveBeenCalledTimes(2); expect(state.release).toHaveBeenCalledTimes(2);
});

it("evicts old workspace snapshots instead of growing without a limit", async () => {
	const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
	await listWorkspaceModelsForPiWeb(workspace);
	for (let index = 0; index < 32; index += 1) {
		const cwd = path.join(path.dirname(workspace), `workspace-${index}`); await fs.mkdir(cwd);
		await listWorkspaceModelsForPiWeb(cwd);
	}
	await listWorkspaceModelsForPiWeb(workspace);
	expect(state.create).toHaveBeenCalledTimes(34);
});

it("bounds total snapshot bytes and does not retain oversized entries", async () => {
	state.name = "x".repeat(9 * 1024 * 1024);
	await listWorkspaceModelsForPiWeb(workspace);
	await listWorkspaceModelsForPiWeb(workspace);
	// The model and provider each include this name, exceeding the 16 MiB budget.
	expect(state.create).toHaveBeenCalledTimes(2);
});

it("limits concurrent distinct-workspace builds while allowing every request to finish", async () => {
	const gate = deferred(); let active = 0, peak = 0;
	state.refresh.mockImplementation(async () => { active += 1; peak = Math.max(peak, active); await gate.promise; active -= 1; });
	const workspaces = await Promise.all(Array.from({ length: 9 }, async (_, index) => {
		const cwd = path.join(path.dirname(workspace), `parallel-${index}`); await fs.mkdir(cwd); return cwd;
	}));
	const reads = workspaces.map((cwd) => listWorkspaceModelsForPiWeb(cwd));
	await vi.waitFor(() => expect(active).toBe(4));
	gate.resolve(); await Promise.all(reads);
	expect(peak).toBe(4); expect(state.create).toHaveBeenCalledTimes(9); expect(state.release).toHaveBeenCalledTimes(9);
});
