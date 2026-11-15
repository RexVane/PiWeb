import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

let root: string;
let manager: typeof import("../src/lib/agent-manager");
let pi: typeof import("../src/lib/pi");
let catalog: typeof import("../src/lib/models-service");
const managed: import("../src/lib/agent-manager").Managed[] = [];
const provider = (host: string) => ({
	baseUrl: `https://${host}.invalid/v1`, api: "openai-completions", apiKey: `${host}-key`,
	models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
});

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-provider-isolation-"));
	const agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir);
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", compaction: { enabled: false } }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
	vi.resetModules();
	pi = await import("../src/lib/pi");
	manager = await import("../src/lib/agent-manager");
	catalog = await import("../src/lib/models-service");
});
afterAll(async () => {
	for (const m of managed) await manager.disposeSessionPath(m.sessionPath);
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await fs.rm(root, { recursive: true, force: true });
});

async function create(name: string, extension?: string) {
	const cwd = path.join(root, name);
	await fs.mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
	const file = path.join(cwd, ".pi", "extensions", "provider.js");
	if (extension) await fs.writeFile(file, extension);
	const { sessionPath } = await manager.createNewSession(cwd);
	const m = manager.getManaged(sessionPath);
	managed.push(m);
	return { m, session: await manager.ensureSession(m), file };
}

describe("session model provider isolation", () => {
	it("keeps project providers, same-name overrides and model selection within the owning session", async () => {
		const extension = (host: string) => `export default pi => pi.registerProvider('audit-provider', ${JSON.stringify(provider(host))});`;
		const a = await create("a", extension("a"));
		const b = await create("b", extension("b"));
		const c = await create("c");
		const shared = await pi.getModelRuntime();
		expect(a.session.modelRuntime).not.toBe(b.session.modelRuntime);
		expect(shared.getModel("audit-provider", "probe")).toBeUndefined();
		expect(c.session.modelRuntime.getModel("audit-provider", "probe")).toBeUndefined();
		expect(a.session.modelRuntime.getModel("audit-provider", "probe")?.baseUrl).toBe("https://a.invalid/v1");
		expect(b.session.modelRuntime.getModel("audit-provider", "probe")?.baseUrl).toBe("https://b.invalid/v1");
		expect(await manager.execute(a.m, { cmd: "setModel", provider: "audit-provider", modelId: "probe" })).toMatchObject({ ok: true });
		expect(await manager.execute(c.m, { cmd: "setModel", provider: "audit-provider", modelId: "probe" })).toMatchObject({ ok: false });
		expect((await catalog.listModelsForPiWeb(a.session.modelRuntime)).models.find((m) => m.provider === "audit-provider")?.baseUrl).toBe("https://a.invalid/v1");
		expect((await catalog.listModelsForPiWeb(b.session.modelRuntime)).models.find((m) => m.provider === "audit-provider")?.baseUrl).toBe("https://b.invalid/v1");
		expect((await catalog.listModelsForPiWeb(c.session.modelRuntime)).models.some((m) => m.provider === "audit-provider")).toBe(false);
		await fs.writeFile(a.file, "export default pi => {};");
		await a.session.reload();
		expect(a.session.modelRuntime.getModel("audit-provider", "probe")).toBeUndefined();
		expect(b.session.modelRuntime.getModel("audit-provider", "probe")?.baseUrl).toBe("https://b.invalid/v1");
		b.session.modelRuntime.unregisterProvider("audit-provider");
		expect(shared.getRegisteredProviderIds()).not.toContain("audit-provider");
	});

	it("refreshes shared model configuration without replacing or leaking session overrides", async () => {
		const file = path.join(process.env.PI_CODING_AGENT_DIR!, "models.json");
		await fs.writeFile(file, JSON.stringify({ providers: { stored: provider("old") } }));
		await pi.refreshModelRuntime();
		const a = await create("config-a", `export default pi => pi.registerProvider('private-a', ${JSON.stringify(provider("a"))});`);
		const b = await create("config-b");
		const before = a.session.modelRuntime;
		await fs.writeFile(file, JSON.stringify({ providers: { stored: provider("new") } }));
		await pi.refreshModelRuntime();
		expect(a.session.modelRuntime).toBe(before);
		for (const session of [a.session, b.session]) {
			expect(session.modelRuntime.getModel("stored", "probe")?.baseUrl).toBe("https://new.invalid/v1");
		}
		expect(a.session.modelRuntime.getModel("private-a", "probe")).toBeDefined();
		expect(b.session.modelRuntime.getModel("private-a", "probe")).toBeUndefined();
		await fs.writeFile(file, JSON.stringify({ providers: {} }));
		await pi.refreshModelRuntime();
		expect(a.session.modelRuntime.getModel("stored", "probe")).toBeUndefined();
		expect(b.session.modelRuntime.getModel("stored", "probe")).toBeUndefined();
	});

	it("removes native and virtual extension registrations on reload without altering another session", async () => {
		const a = await create("native-a");
		const b = await create("native-b");
		const builtin = a.session.modelRuntime.getProvider("anthropic")!;
		a.session.modelRuntime.registerNativeProvider({ ...builtin, id: "native-private", getModels: () => [] });
		a.session.modelRuntime.registerVirtualModel({ provider: "virtual-private", id: "route", name: "Private route", route: () => { throw new Error("not called"); } });
		expect(a.session.modelRuntime.getRegisteredProviderIds()).toContain("native-private");
		expect(a.session.modelRuntime.getModel("virtual-private", "route")).toBeDefined();
		expect(b.session.modelRuntime.getProvider("native-private")).toBeUndefined();
		expect(b.session.modelRuntime.getModel("virtual-private", "route")).toBeUndefined();
		await pi.refreshModelRuntime();
		expect(a.session.modelRuntime.getModel("virtual-private", "route")).toBeDefined();
		await a.session.reload();
		expect(a.session.modelRuntime.getProvider("native-private")).toBeUndefined();
		expect(a.session.modelRuntime.getModel("virtual-private", "route")).toBeUndefined();
	});

	it("retains persisted remote models and removes deleted builtin overrides on refresh", async () => {
		const shared = await pi.getModelRuntime();
		const base = shared.getModels("anthropic")[0];
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		const remote = { ...base, id: "audit-remote", name: "Remote model", contextWindow: 123456 };
		const cached = { models: [remote], lastModified: Date.now() + 86400000, checkedAt: Date.now(), etag: '"audit"' };
		await fs.writeFile(path.join(agentDir, "models-store.json"), JSON.stringify({ anthropic: cached }));
		await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { modelOverrides: { [base.id]: { contextWindow: 12345 } } } } }));
		await pi.refreshModelRuntime();
		const a = await create("remote-a");
		expect(a.session.modelRuntime.getModel("anthropic", "audit-remote")?.contextWindow).toBe(123456);
		expect(a.session.modelRuntime.getModel("anthropic", base.id)?.contextWindow).toBe(12345);
		await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
		await pi.refreshModelRuntime();
		expect(a.session.modelRuntime.getModel("anthropic", base.id)?.contextWindow).toBe(base.contextWindow);
		expect(a.session.modelRuntime.getModel("anthropic", "audit-remote")?.contextWindow).toBe(123456);
		await a.session.reload();
		expect(a.session.modelRuntime.getModel("anthropic", "audit-remote")?.contextWindow).toBe(123456);
		expect(JSON.parse(await fs.readFile(path.join(agentDir, "models-store.json"), "utf8"))).toEqual({ anthropic: cached });
	});

	it("serves only the requested session's model catalog and validates the session boundary", async () => {
		const a = await create("api-a", `export default pi => pi.registerProvider('api-private', ${JSON.stringify(provider("api"))});`);
		const b = await create("api-b");
		const { GET } = await import("../src/app/api/models/route");
		const list = async (query: string) => {
			const result = await GET(new Request(`http://localhost/api/models?${query}`));
			return { status: result.status, body: await result.json() };
		};
		const first = await list(`session=${pi.encodeSessionId(a.m.sessionPath)}`);
		expect(first.status).toBe(200);
		expect(first.body.data.models.some((m: { provider: string }) => m.provider === "api-private")).toBe(true);
		expect((await list(`session=${pi.encodeSessionId(b.m.sessionPath)}`)).body.data.models.some((m: { provider: string }) => m.provider === "api-private")).toBe(false);
		expect((await list("full=1")).body.data.models.some((m: { provider: string }) => m.provider === "api-private")).toBe(false);
		expect((await list(`session=${pi.encodeSessionId(path.join(root, "outside.jsonl"))}`)).status).toBe(400);
	});

	it("discovers an automation workspace's providers without starting a session or consuming its discovery queue", async () => {
		const cwd = path.join(root, "catalog-workspace");
		await fs.mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "extensions", "provider.js"), `export default pi => {
			pi.registerProvider('workspace-private', ${JSON.stringify(provider("workspace"))});
			pi.on('session_start', () => { throw new Error('catalog must not start a session'); });
		};`);
		const { GET } = await import("../src/app/api/models/route");
		const read = async () => {
			const result = await GET(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(cwd)}`));
			expect(result.status).toBe(200);
			return result.json();
		};
		for (let i = 0; i < 2; i += 1) {
			expect((await read()).data.models.some((model: { provider: string }) => model.provider === "workspace-private")).toBe(true);
		}
		expect((await pi.getModelRuntime()).getProvider("workspace-private")).toBeUndefined();
		expect(pi.getResourceLoader(cwd).getExtensions().runtime.pendingProviderRegistrations).toHaveLength(1);
		expect((await catalog.listWorkspaceModelsForPiWeb(path.join(root, "api-b"))).models.some((model) => model.provider === "workspace-private")).toBe(false);
	});

	it("applies toolPreset, model, and thinking in one createNewSession call and rejects invalid options", async () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { stored: provider("one") } }));
		await pi.refreshModelRuntime();

		const cwd = path.join(root, "single-rtt");
		await fs.mkdir(cwd, { recursive: true });
		await expect(manager.createNewSession(cwd, { provider: "stored" } as any)).rejects.toThrow();

		const { sessionPath, setupApplied } = await manager.createNewSession(cwd, {
			toolPreset: "full",
			provider: "stored",
			modelId: "probe",
			thinking: "off",
		});
		expect(setupApplied).toBe(true);
		const m = manager.getManaged(sessionPath);
		managed.push(m);
		expect(m.toolPreset).toBe("full");

		const snapshot = await manager.buildSnapshot(m);
		expect(snapshot.toolPreset).toBe("full");
		expect(snapshot.toolPreferenceSaved).toBe(true);
		expect(snapshot.model).toMatchObject({ provider: "stored", id: "probe" });
		expect(snapshot.thinkingLevel).toBe("off");
	});
});
