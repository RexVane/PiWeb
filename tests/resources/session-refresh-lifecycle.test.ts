import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recycleGeneratedFixture } from "../fixtures/system-trash";

vi.mock("../../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

type Managed = import("../../src/lib/agent-manager").Managed;
let root: string;
let manager: typeof import("../../src/lib/agent-manager");
let pi: typeof import("../../src/lib/pi");
let service: typeof import("../../src/lib/plugins-service");
let host: typeof import("../../src/lib/resources/host");
const managed: Managed[] = [];
const workspaces = new Set<string>();
const control = { failAfterStart: false, throwToolApply: false };
const snippet = "Refresh fixture tool snippet";
const guideline = "Refresh fixture tool guideline";
const userInstructions = "Preserve the user's appended system instructions.";

beforeAll(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-session-refresh-")));
	const agent = path.join(root, "agent");
	await fs.mkdir(agent);
	await fs.writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", compaction: { enabled: false } }));
	await fs.writeFile(path.join(agent, "APPEND_SYSTEM.md"), userInstructions);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in session refresh regressions"); }));
	vi.stubGlobal("__piwebSessionRefreshFixture", control);
	vi.resetModules();
	manager = await import("../../src/lib/agent-manager");
	pi = await import("../../src/lib/pi");
	service = await import("../../src/lib/plugins-service");
	host = await import("../../src/lib/resources/host");
}, 90_000);

beforeEach(() => { control.failAfterStart = false; control.throwToolApply = false; });
afterEach(async () => {
	vi.restoreAllMocks();
	for (const m of managed.splice(0)) await manager.disposeSession(m);
});
afterAll(async () => {
	for (const cwd of workspaces) await host.reconcileResourceHosts(cwd);
	expect(host.resourceHostStatuses()).toEqual([]);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await recycleGeneratedFixture(root);
});

async function fixture() {
	const directory = await fs.mkdtemp(path.join(root, "case-"));
	const cwd = path.join(directory, "workspace");
	const resource = path.join(directory, "resource");
	await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
	await fs.mkdir(path.join(resource, "src"), { recursive: true });
	await fs.mkdir(path.join(resource, "web"));
	await fs.writeFile(path.join(resource, "web/index.html"), "<!doctype html><p>Refresh fixture</p>");
	await fs.writeFile(path.join(resource, "package.json"), JSON.stringify({
		name: "session-refresh-fixture", type: "module", pi: { extensions: ["src/index.ts"] },
		piweb: { apiVersion: 1, id: "refresh-fixture", views: [{ id: "main", entry: "web/index.html", placement: "aboveEditor" }] },
	}));
	await fs.writeFile(path.join(resource, "src/index.ts"), `export default function(pi) {
		pi.registerTool({ name: "refresh_question", label: "Refresh fixture", description: "External refresh fixture",
			promptSnippet: ${JSON.stringify(snippet)}, promptGuidelines: [${JSON.stringify(guideline)}],
			parameters: { type: "object", properties: {} },
			async execute(_id, args, _signal, _update, ctx) {
				const response = await ctx.ui.resources.request("refresh-fixture", "main", args);
				return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
			}
		});
		pi.on("session_start", (event) => {
			const control = globalThis.__piwebSessionRefreshFixture;
			if (event.reason === "reload" && control?.failAfterStart) control.throwToolApply = true;
		});
	}`);
	await fs.writeFile(path.join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [resource] }));
	workspaces.add(cwd);
	return { cwd, resource };
}

async function fresh(cwd: string) {
	const { sessionPath } = await manager.createNewSession(cwd);
	const m = manager.getManaged(sessionPath);
	managed.push(m);
	const session = await manager.ensureSession(m);
	expect(session.getActiveToolNames()).toContain("refresh_question");
	expect(session.systemPrompt).toContain(snippet);
	expect(session.systemPrompt).toContain(guideline);
	return { m, session };
}

async function flushBackground() {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 20));
}

function expectRemoved(session: NonNullable<Managed["session"]>) {
	expect(session.getActiveToolNames()).not.toContain("refresh_question");
	expect(session.getAllTools().map((tool) => tool.name)).not.toContain("refresh_question");
	expect(session.systemPrompt).not.toContain(snippet);
	expect(session.systemPrompt).not.toContain(guideline);
	expect(session.systemPrompt).toContain(userInstructions);
	expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
}

describe("session resource refresh lifecycle through the real Pi SDK", () => {
	it("declares a re-enabled package tool after resuming and navigating old history", async () => {
		const { cwd, resource } = await fixture();
		const first = await fresh(cwd);
		async function sendTurn(m: Managed, session: NonNullable<Managed["session"]>, enabled: boolean) {
			const model = session.modelRuntime.getModels().find((item) => item.provider === "openai")!;
			session.agent.state.model = model;
			vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
			const requests: string[][] = [];
			session.agent.streamFunction = (_model, context) => {
				requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: {
					role: "assistant", content: [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id,
					timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				} });
				return stream;
			};
			expect(await manager.execute(m, { cmd: "prompt", text: "check tool availability" })).toMatchObject({ ok: true });
			await session.waitForIdle();
			expect(requests).toHaveLength(1);
			expect(requests[0].includes("refresh_question")).toBe(enabled);
		}
		await sendTurn(first.m, first.session, true);
		await service.togglePackage(resource, true, "project", cwd);
		await sendTurn(first.m, first.session, false);
		const oldLeaf = first.m.sm.getLeafId()!;
		await manager.disposeSessionPath(first.m.sessionPath);
		await service.togglePackage(resource, false, "project", cwd);
		const reopened = manager.getManaged(first.m.sessionPath);
		managed.push(reopened);
		const session = await manager.ensureSession(reopened);
		expect(session.getActiveToolNames()).toContain("refresh_question");
		await sendTurn(reopened, session, true);
		expect(await manager.execute(reopened, { cmd: "navigate", entryId: oldLeaf })).toMatchObject({ ok: true });
		expect(session.getActiveToolNames()).toContain("refresh_question");
		await sendTurn(reopened, session, true);
		const activeTools = session.agent.state.tools;
		session.agent.state.tools = activeTools.filter((tool) => tool.name !== "refresh_question");
		await sendTurn(reopened, session, true);
		session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "refresh_question"));
		await sendTurn(reopened, session, false);
	});

	it("refreshes an existing session before sending through another module instance", async () => {
		const { cwd } = await fixture();
		const { m, session } = await fresh(cwd);
		const reload = vi.spyOn(session.resourceLoader, "reload");
		const prompt = vi.spyOn(session, "prompt").mockImplementation(async (_text, options) => {
			options?.preflightResult?.("started");
		});
		m.resourceReloadPending = true;
		vi.resetModules();
		const commandManager = await import("../../src/lib/agent-manager");
		expect(commandManager.getManaged(m.sessionPath)).toBe(m);
		expect(await commandManager.execute(m, { cmd: "prompt", text: "next turn" })).toMatchObject({ ok: true });
		expect(reload).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(m.resourceReloadPending).toBe(false);
	});

	it("reports an applied mutation's failed session while refreshing the remaining sessions", async () => {
		const { cwd } = await fixture();
		const a = await fresh(cwd);
		const b = await fresh(cwd);
		const c = await fresh(cwd);
		const failure = new Error("Injected session reload failure");
		const reloadA = vi.spyOn(a.session.resourceLoader, "reload").mockRejectedValue(failure);
		const reloadB = vi.spyOn(b.session.resourceLoader, "reload");
		const reloadC = vi.spyOn(c.session.resourceLoader, "reload");
		const error = await service.toggleResource("refresh-fixture", true, "project", cwd).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(service.ResourceRefreshError);
		expect(error).toMatchObject({ applied: true, cause: expect.any(AggregateError) });
		expect((error as Error).cause).toMatchObject({ errors: expect.arrayContaining([failure]) });
		expect(a.m.resourceReloadPending).toBe(true);
		expect(b.m.resourceReloadPending).toBe(false);
		expect(c.m.resourceReloadPending).toBe(false);
		expectRemoved(b.session);
		expectRemoved(c.session);
		await flushBackground();
		expect(reloadA).toHaveBeenCalledTimes(1);
		expect(reloadB).toHaveBeenCalledTimes(1);
		expect(reloadC).toHaveBeenCalledTimes(1);
	});

	it("propagates final tool application failures and leaves that revision pending", async () => {
		const { cwd } = await fixture();
		const a = await fresh(cwd);
		const b = await fresh(cwd);
		const version = a.m.resourceVersion;
		await pi.reloadLoader(cwd);
		const failure = new Error("Injected tool application failure after session_start");
		const getAllTools = a.session.getAllTools.bind(a.session);
		vi.spyOn(a.session, "getAllTools").mockImplementation(() => {
			if (control.throwToolApply) { control.throwToolApply = false; throw failure; }
			return getAllTools();
		});
		control.failAfterStart = true;
		const error = await manager.reloadSessionsForCwd(cwd).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toContain(failure);
		expect(a.m.resourceVersion).toBe(version);
		expect(a.m.resourceReloadPending).toBe(true);
		expect(a.m.resourceReloading).toBe(false);
		expect(b.m.resourceVersion).toBe(pi.resourceLoaderVersion(cwd));
		expect(b.m.resourceReloadPending).toBe(false);
	});

	it("retries once per snapshot, explicit reload and new submission without starting stale prompts", async () => {
		const { cwd } = await fixture();
		const { m, session } = await fresh(cwd);
		const failure = new Error("Refresh remains unavailable");
		const reload = vi.spyOn(session.resourceLoader, "reload").mockRejectedValue(failure);
		const prompt = vi.spyOn(session, "prompt").mockImplementation(async (_text, options) => { options?.preflightResult?.("started"); });
		await expect(manager.reloadSessionsForCwd(cwd)).rejects.toBeInstanceOf(AggregateError);
		await flushBackground();
		expect(reload).toHaveBeenCalledTimes(1);
		await manager.buildSnapshot(m);
		await flushBackground();
		expect(reload).toHaveBeenCalledTimes(2);
		expect(await manager.execute(m, { cmd: "reload" })).toMatchObject({ ok: false, error: failure.message });
		await flushBackground();
		expect(reload).toHaveBeenCalledTimes(3);
		expect(await manager.execute(m, { cmd: "prompt", text: "first retry" })).toMatchObject({ ok: false, error: failure.message });
		await flushBackground();
		expect(reload).toHaveBeenCalledTimes(4);
		expect(await manager.execute(m, { cmd: "prompt", text: "second retry" })).toMatchObject({ ok: false, error: failure.message });
		await flushBackground();
		expect(reload).toHaveBeenCalledTimes(5);
		expect(prompt).not.toHaveBeenCalled();
		expect(m.resourceReloadPending).toBe(true);
		expect(m.promptSubmitting).toBe(false);
		reload.mockRestore();
		expect(await manager.execute(m, { cmd: "prompt", text: "retry after recovery" })).toMatchObject({ ok: true, data: { accepted: true } });
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(m.resourceReloadPending).toBe(false);
	});

	it("keeps the submission reservation while refreshing and rejects a concurrent new prompt", async () => {
		const { cwd } = await fixture();
		const { m, session } = await fresh(cwd);
		const reloadResources = session.resourceLoader.reload.bind(session.resourceLoader);
		let entered = false;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const reload = vi.spyOn(session.resourceLoader, "reload").mockImplementation(async (options) => {
			entered = true;
			await gate;
			await reloadResources(options);
		});
		const prompt = vi.spyOn(session, "prompt").mockImplementation(async (_text, options) => {
			expect(m.promptSubmitting).toBe(true);
			expect(m.resourceReloadPending).toBe(false);
			options?.preflightResult?.("started");
		});
		m.resourceReloadPending = true;
		const first = manager.execute(m, { cmd: "prompt", text: "first" });
		try {
			await vi.waitFor(() => expect(entered).toBe(true));
			expect(m.promptSubmitting).toBe(true);
			expect(await manager.execute(m, { cmd: "prompt", text: "second" })).toMatchObject({ ok: false, error: "session is busy accepting another command" });
		} finally { release(); }
		expect(await first).toMatchObject({ ok: true });
		expect(reload).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(m.promptSubmitting).toBe(false);
	});

	it("revokes a busy session's resource dialog immediately and refreshes tools when its round settles", async () => {
		const { cwd } = await fixture();
		const { m, session } = await fresh(cwd);
		const model = session.modelRuntime.getModels().find((item) => item.provider === "openai")!;
		expect(model).toBeTruthy();
		session.agent.state.model = model;
		vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
		const stream = createAssistantMessageEventStream();
		session.agent.streamFunction = () => stream as never;
		const message = {
			role: "assistant" as const, content: [{ type: "text" as const, text: "done" }],
			api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop" as const,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const reload = vi.spyOn(session.resourceLoader, "reload");
		try {
			expect(await manager.execute(m, { cmd: "prompt", text: "hold this round" })).toMatchObject({ ok: true });
			await vi.waitFor(() => expect(m.runActive).toBe(true));
			const tool = session.agent.state.tools.find((tool) => tool.name === "refresh_question")!;
			const answer = tool.execute("pending-dialog", {}, new AbortController().signal);
			await vi.waitFor(() => expect(m.ui!.getPendingRequests()).toHaveLength(1));
			const requestId = m.ui!.getPendingRequests()[0].id;
			await service.toggleResource("refresh-fixture", true, "project", cwd);
			expect(m.resourceReloadPending).toBe(true);
			expect(reload).not.toHaveBeenCalled();
			expect(m.ui!.getPendingRequests()).toEqual([]);
			expect((await answer).details).toMatchObject({ status: "cancelled" });
			expect(m.buffer.map((frame) => JSON.parse(frame.json))).toEqual(expect.arrayContaining([
				expect.objectContaining({ type: "extension_ui_resolved", id: requestId }),
			]));
			stream.push({ type: "done", reason: "stop", message });
			await session.waitForIdle();
			await vi.waitFor(() => {
				expect(reload).toHaveBeenCalledTimes(1);
				expect(m.resourceReloadPending).toBe(false);
				expect(m.resourceReloading).toBe(false);
			});
			expectRemoved(session);
		} finally {
			stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
			await session.abort();
		}
	});

	it("removes the external tool and prompt guidance after uninstall while preserving SDK tools", async () => {
		const { cwd, resource } = await fixture();
		const { m, session } = await fresh(cwd);
		expect(await service.removePackage(resource, true, cwd)).toBe(true);
		expect(m.resourceReloadPending).toBe(false);
		expectRemoved(session);
		await fs.access(path.join(resource, "src/index.ts"));
	});
});
