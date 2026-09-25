import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

let root: string;
let cwd: string;
let manager: typeof import("../src/lib/agent-manager");
let pi: typeof import("../src/lib/pi");
const managed: ReturnType<typeof import("../src/lib/agent-manager")["getManaged"]>[] = [];

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-agent-sdk-"));
	cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", compaction: { enabled: false } }));
	await fs.writeFile(path.join(cwd, ".pi", "extensions", "probe.js"), `export default function(pi) {
		pi.registerTool({ name: "probe_tool", label: "Probe", description: "Offline probe", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
		pi.registerCommand("probe", { handler: async (args) => { pi.setSessionName(args); } });
		pi.registerCommand("ask", { handler: async (_args, ctx) => { const accepted = await ctx.ui.confirm("Confirm probe", "Continue?"); pi.setSessionName(accepted ? "confirmed" : "cancelled"); } });
	}`);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in agent SDK regression"); }));
	vi.resetModules();
	manager = await import("../src/lib/agent-manager");
	pi = await import("../src/lib/pi");
}, 90_000);

afterAll(async () => {
	for (const m of managed) manager.disposeSession(m);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await fs.rm(root, { recursive: true, force: true });
});

async function create() {
	const { sessionPath } = await manager.createNewSession(cwd);
	const m = manager.getManaged(sessionPath);
	managed.push(m);
	const session = await manager.ensureSession(m);
	return { m, session };
}

describe("real SDK session resource isolation", () => {
	it("keeps Plan read-only until approval and restores its mode from the native session", async () => {
		const { m, session } = await create();
		expect(await manager.execute(m, { cmd: "setToolPreset", preset: "standard" })).toMatchObject({ ok: true });
		expect(await manager.execute(m, { cmd: "setWorkflowMode", mode: "plan" })).toMatchObject({ ok: true });
		expect(session.getActiveToolNames()).toContain("piweb_delegate");
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(await manager.execute(m, { cmd: "approvePlan" })).toMatchObject({ ok: false });
		expect((await manager.buildSnapshot(m)).workflow).toMatchObject({ mode: "plan", planStatus: "idle" });
	});

	it("makes the Plan approval gate explicit across an offline model turn", async () => {
		const { m, session } = await create();
		await manager.execute(m, { cmd: "setToolPreset", preset: "standard" });
		await manager.execute(m, { cmd: "setWorkflowMode", mode: "plan" });
		const rt = await pi.getModelRuntime();
		const model = rt.getModels().find((candidate) => candidate.provider === "openai")!;
		session.agent.state.model = model;
		const auth = vi.spyOn(rt, "hasConfiguredAuth").mockReturnValue(true);
		const first = createAssistantMessageEventStream();
		const second = createAssistantMessageEventStream();
		let calls = 0;
		session.agent.streamFunction = () => (++calls === 1 ? first : second) as never;
		const answer = (text: string) => ({
			role: "assistant" as const, content: [{ type: "text" as const, text }], api: model.api,
			provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop" as const,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		try {
			expect(await manager.execute(m, { cmd: "prompt", text: "Plan a safe change" })).toMatchObject({ ok: true });
			expect(session.systemPrompt).toContain("Planning mode");
			first.push({ type: "done", reason: "stop", message: answer("A concrete plan") });
			await session.waitForIdle();
			await vi.waitFor(() => expect(m.workflow.planStatus).toBe("ready"));
			expect(session.getActiveToolNames()).not.toContain("bash");
			expect(await manager.execute(m, { cmd: "approvePlan" })).toMatchObject({ ok: true });
			expect(m.workflow.planStatus).toBe("executing");
			expect(session.getActiveToolNames()).toContain("bash");
			second.push({ type: "done", reason: "stop", message: answer("Implemented") });
			await session.waitForIdle();
			await vi.waitFor(() => expect(m.workflow.planStatus).toBe("idle"));
			expect(session.getActiveToolNames()).not.toContain("bash");
			manager.disposeSession(m);
			const reopened = manager.getManaged(m.sessionPath);
			managed.push(reopened);
			expect((await manager.buildSnapshot(reopened)).workflow).toMatchObject({ mode: "plan", planStatus: "idle" });
		} finally {
			auth.mockRestore();
		}
	});

	it("rejects approval when the conversation has moved past the proposed plan", async () => {
		const { m, session } = await create();
		await manager.execute(m, { cmd: "setWorkflowMode", mode: "plan" });
		const rt = await pi.getModelRuntime();
		const model = rt.getModels().find((candidate) => candidate.provider === "openai")!;
		session.agent.state.model = model;
		const auth = vi.spyOn(rt, "hasConfiguredAuth").mockReturnValue(true);
		const stream = createAssistantMessageEventStream();
		session.agent.streamFunction = () => stream as never;
		try {
			expect(await manager.execute(m, { cmd: "prompt", text: "Propose a plan" })).toMatchObject({ ok: true });
			stream.push({ type: "done", reason: "stop", message: {
				role: "assistant", content: [{ type: "text", text: "A safe plan" }], api: model.api,
				provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			} });
			await session.waitForIdle();
			await vi.waitFor(() => expect(m.workflow.planStatus).toBe("ready"));
			expect(m.workflow.planId).toBeTruthy();
			m.sm.appendMessage({ role: "user", content: "The requirements changed", timestamp: Date.now() });
			expect(await manager.execute(m, { cmd: "approvePlan" })).toMatchObject({ ok: false, error: expect.stringContaining("no longer the latest") });
			expect(m.workflow.planStatus).toBe("ready");
		} finally {
			auth.mockRestore();
		}
	});

	it("keeps a Goal objective across a native session reopen", async () => {
		const { m, session } = await create();
		await manager.execute(m, { cmd: "setWorkflowMode", mode: "goal" });
		const rt = await pi.getModelRuntime();
		const model = rt.getModels().find((candidate) => candidate.provider === "openai")!;
		session.agent.state.model = model;
		const auth = vi.spyOn(rt, "hasConfiguredAuth").mockReturnValue(true);
		const stream = createAssistantMessageEventStream();
		session.agent.streamFunction = () => stream as never;
		try {
			expect(await manager.execute(m, { cmd: "prompt", text: "Make the test suite pass" })).toMatchObject({ ok: true });
			expect(m.workflow.goal).toBe("Make the test suite pass");
			expect(session.systemPrompt).toContain("Make the test suite pass");
			stream.push({ type: "done", reason: "stop", message: {
				role: "assistant", content: [{ type: "text", text: "Verified" }], api: model.api,
				provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			} });
			await session.waitForIdle();
			manager.disposeSession(m);
			const reopened = manager.getManaged(m.sessionPath);
			managed.push(reopened);
			expect((await manager.buildSnapshot(reopened)).workflow).toMatchObject({ mode: "goal", goal: "Make the test suite pass" });
		} finally {
			auth.mockRestore();
		}
	});

	it("keeps a ready plan approvable after the execution turn fails", async () => {
		const { m, session } = await create();
		await manager.execute(m, { cmd: "setToolPreset", preset: "standard" });
		await manager.execute(m, { cmd: "setWorkflowMode", mode: "plan" });
		const rt = await pi.getModelRuntime();
		const model = rt.getModels().find((candidate) => candidate.provider === "openai")!;
		session.agent.state.model = model;
		const auth = vi.spyOn(rt, "hasConfiguredAuth").mockReturnValue(true);
		const streams = [createAssistantMessageEventStream(), createAssistantMessageEventStream(), createAssistantMessageEventStream()];
		let calls = 0;
		session.agent.streamFunction = () => streams[calls++] as never;
		const assistant = (text: string, stopReason: "stop" | "error") => ({
			role: "assistant" as const, content: [{ type: "text" as const, text }], api: model.api,
			provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
			...(stopReason === "error" ? { errorMessage: "invalid request: unsupported parameter" } : {}),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		try {
			expect(await manager.execute(m, { cmd: "prompt", text: "Plan a safe change" })).toMatchObject({ ok: true });
			streams[0].push({ type: "done", reason: "stop", message: assistant("A concrete plan", "stop") });
			await session.waitForIdle();
			await vi.waitFor(() => expect(m.workflow.planStatus).toBe("ready"));
			expect(await manager.execute(m, { cmd: "approvePlan" })).toMatchObject({ ok: true });
			streams[1].push({ type: "error", reason: "error", error: assistant("", "error") });
			await session.waitForIdle();
			await vi.waitFor(() => expect(m.workflow.planStatus).toBe("ready"));
			expect(session.getActiveToolNames()).not.toContain("bash");
			expect(await manager.execute(m, { cmd: "approvePlan" })).toMatchObject({ ok: true });
			expect(session.getActiveToolNames()).toContain("bash");
			streams[2].push({ type: "done", reason: "stop", message: assistant("Implemented", "stop") });
			await session.waitForIdle();
			await vi.waitFor(() => expect(m.workflow.planStatus).toBe("idle"));
			expect(calls).toBe(3);
		} finally {
			auth.mockRestore();
		}
	});

	it("updates the Goal when its defining message is edited and keeps it for later edits or reselecting Goal", async () => {
		const { m, session } = await create();
		await manager.execute(m, { cmd: "setWorkflowMode", mode: "goal" });
		const rt = await pi.getModelRuntime();
		const model = rt.getModels().find((candidate) => candidate.provider === "openai")!;
		session.agent.state.model = model;
		const auth = vi.spyOn(rt, "hasConfiguredAuth").mockReturnValue(true);
		const streams = Array.from({ length: 4 }, () => createAssistantMessageEventStream());
		let calls = 0;
		session.agent.streamFunction = () => streams[calls++] as never;
		const reply = (index: number, text: string) => streams[index].push({ type: "done", reason: "stop", message: {
			role: "assistant", content: [{ type: "text", text }], api: model.api,
			provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		} });
		const userEntry = (text: string) => m.sm.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(text))!.id;
		try {
			expect(await manager.execute(m, { cmd: "prompt", text: "Old objective" })).toMatchObject({ ok: true });
			reply(0, "Working");
			await session.waitForIdle();
			expect(await manager.execute(m, { cmd: "editAndResend", entryId: userEntry("Old objective"), text: "New objective" })).toMatchObject({ ok: true });
			expect(m.workflow.goal).toBe("New objective");
			expect(session.systemPrompt).toContain("Objective: New objective");
			reply(1, "Working again");
			await session.waitForIdle();
			expect(await manager.execute(m, { cmd: "prompt", text: "Also add docs" })).toMatchObject({ ok: true });
			reply(2, "Docs added");
			await session.waitForIdle();
			expect(await manager.execute(m, { cmd: "editAndResend", entryId: userEntry("Also add docs"), text: "Also add tests" })).toMatchObject({ ok: true });
			expect(m.workflow.goal).toBe("New objective");
			reply(3, "Tests added");
			await session.waitForIdle();
			expect(await manager.execute(m, { cmd: "setWorkflowMode", mode: "goal" })).toMatchObject({ ok: true });
			expect(m.workflow.goal).toBe("New objective");
		} finally {
			auth.mockRestore();
		}
	});

	it("isolates same-cwd A/B runtimes and keeps discovery and B alive after disposing A", async () => {
		const a = await create();
		const b = await create();
		const discovery = pi.getResourceLoader(cwd);
		expect(a.session.resourceLoader).not.toBe(b.session.resourceLoader);
		expect(a.session.resourceLoader).not.toBe(discovery);
		expect(a.session.resourceLoader.getExtensions().runtime).not.toBe(b.session.resourceLoader.getExtensions().runtime);
		expect(await manager.execute(a.m, { cmd: "prompt", text: "/probe A" })).toMatchObject({ ok: true, data: { accepted: true } });
		expect(a.session.sessionName).toBe("A");
		expect(b.session.sessionName).not.toBe("A");
		manager.disposeSession(a.m);
		expect(() => discovery.getExtensions().runtime.assertActive()).not.toThrow();
		expect(await manager.execute(b.m, { cmd: "prompt", text: "/probe B" })).toMatchObject({ ok: true });
		expect(b.session.sessionName).toBe("B");
		await pi.reloadLoader(cwd);
		expect(await manager.execute(b.m, { cmd: "prompt", text: "/probe B-after-discovery" })).toMatchObject({ ok: true });
		expect(b.session.sessionName).toBe("B-after-discovery");
	});

	it("reapplies readonly and custom allowlists on direct, command and resource reload", async () => {
		const { m, session } = await create();
		expect(session.getAllTools().map((tool) => tool.name)).toContain("probe_tool");
		expect(session.getActiveToolNames()).not.toContain("probe_tool");
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls"]);
		expect(await manager.execute(m, { cmd: "setActiveTools", names: ["read", "probe_tool"] })).toMatchObject({ ok: true });
		expect(await manager.execute(m, { cmd: "reload" })).toMatchObject({ ok: true });
		expect(session.getActiveToolNames()).toEqual(["read", "probe_tool"]);
		await pi.reloadLoader(cwd);
		await manager.reloadSessionsForCwd(cwd);
		expect(session.getActiveToolNames()).toEqual(["read", "probe_tool"]);
		expect((await manager.buildSnapshot(m)).customActiveTools).toEqual(["read", "probe_tool"]);
		expect(await manager.execute(m, { cmd: "setToolPreset", preset: "readonly" })).toMatchObject({ ok: true });
		await manager.reloadSessionsForCwd(cwd);
		expect(session.getActiveToolNames()).not.toContain("probe_tool");
	});

	it("restores only pending UI requests in snapshots and accepts a response independently", async () => {
		const { m } = await create();
		const send = vi.fn();
		manager.subscribe(m, send, m.seq);
		const beforeRequest = m.seq;
		const command = manager.execute(m, { cmd: "prompt", text: "/ask" });
		await vi.waitFor(() => expect(m.ui?.getPendingRequests()).toHaveLength(1));
		const snapshot = await manager.buildSnapshot(m);
		expect(snapshot.extensionUiRequests).toHaveLength(1);
		const id = snapshot.extensionUiRequests![0].id;
		expect(await manager.execute(m, { cmd: "extensionUiResponse", requestId: id, confirmed: true })).toMatchObject({ ok: true });
		expect(await command).toMatchObject({ ok: true, data: { accepted: true } });
		expect((await manager.buildSnapshot(m)).extensionUiRequests).toEqual([]);
		const replay = vi.fn();
		expect(manager.subscribe(m, replay, beforeRequest)).toBe(false);
		expect(replay).not.toHaveBeenCalled();
		expect(m.subscribers.has(replay)).toBe(false);
		expect(await manager.execute(m, { cmd: "extensionUiResponse", requestId: id, confirmed: false })).toMatchObject({ ok: false });
		manager.unsubscribe(m, send);
	});

	it("refreshes trust for every hot session without invalidating the discovery runtime", async () => {
		const a = await create();
		const b = await create();
		pi.setProjectTrust(cwd, false);
		await pi.reloadLoader(cwd);
		await manager.reloadSessionsForCwd(cwd);
		expect(a.session.getAllTools().some((tool) => tool.name === "probe_tool")).toBe(false);
		expect(b.session.getAllTools().some((tool) => tool.name === "probe_tool")).toBe(false);
		pi.setProjectTrust(cwd, true);
		await pi.reloadLoader(cwd);
		await manager.reloadSessionsForCwd(cwd);
		expect(a.session.getAllTools().some((tool) => tool.name === "probe_tool")).toBe(true);
		expect(b.session.getAllTools().some((tool) => tool.name === "probe_tool")).toBe(true);
		expect(a.session.getActiveToolNames()).not.toContain("probe_tool");
		expect(b.session.getActiveToolNames()).not.toContain("probe_tool");
	});

	it("keeps custom choices on snapshot-triggered reload for both same-cwd sessions", async () => {
		const a = await create();
		const b = await create();
		await manager.execute(a.m, { cmd: "setActiveTools", names: ["read"] });
		await manager.execute(b.m, { cmd: "setActiveTools", names: ["grep"] });
		await fs.mkdir(path.join(cwd, ".pi", "prompts"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "prompts", "fresh.md"), "Fresh prompt");
		await manager.buildSnapshot(a.m);
		await manager.buildSnapshot(b.m);
		expect(a.session.promptTemplates.some((prompt) => prompt.name === "fresh")).toBe(true);
		expect(b.session.promptTemplates.some((prompt) => prompt.name === "fresh")).toBe(true);
		expect(a.session.getActiveToolNames()).toEqual(["read"]);
		expect(b.session.getActiveToolNames()).toEqual(["grep"]);
	});

	it("surfaces SDK preflight rejection without an unhandled promise or stuck submit lock", async () => {
		const { m, session } = await create();
		const model = vi.spyOn(session, "model", "get").mockReturnValue(undefined);
		try {
			const result = await manager.execute(m, { cmd: "prompt", text: "must not call a model" });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/model/i);
			expect(m.promptSubmitting).toBe(false);
		} finally {
			model.mockRestore();
		}
	});

	it("keeps one final during an awaited SDK message_end hook and retains durable entry IDs", async () => {
		const { m, session } = await create();
		const rt = await pi.getModelRuntime();
		const model = rt.getModels().find((candidate) => candidate.provider === "openai")!;
		expect(model).toBeTruthy();
		session.agent.state.model = model;
		const auth = vi.spyOn(rt, "hasConfiguredAuth").mockReturnValue(true);
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => { finish = resolve; });
		let entered = false;
		const extension = session.resourceLoader.getExtensions().extensions[0];
		extension.handlers.set("message_end", [async (event: any) => {
			if (event.message.role !== "assistant") return;
			entered = true;
			await gate;
			return { message: { ...event.message, content: [{ type: "text", text: "after extension" }] } };
		}]);
		const stream = createAssistantMessageEventStream();
		session.agent.streamFunction = () => stream as never;
		const raw = {
			role: "assistant" as const, content: [{ type: "text" as const, text: "before extension" }],
			api: model.api, provider: model.provider, model: model.id, timestamp: 100,
			stopReason: "stop" as const,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		try {
			expect(await manager.execute(m, { cmd: "prompt", text: "offline stream" })).toMatchObject({ ok: true, data: { accepted: true } });
			stream.push({ type: "start", partial: raw });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "before extension", partial: raw });
			stream.push({ type: "done", reason: "stop", message: raw });
			await vi.waitFor(() => expect(entered).toBe(true));
			const snapshot = await manager.buildSnapshot(m);
			const assistants = snapshot.messages.filter((message) => message.role === "assistant");
			expect(assistants).toHaveLength(1);
			expect(assistants[0].streamId).toBeTruthy();
			expect(snapshot.isStreaming).toBe(true);
			finish();
			await session.waitForIdle();
			const end = m.buffer.map((frame) => JSON.parse(frame.json)).find((event) => event.type === "message" && event.phase === "end" && event.message.role === "assistant");
			expect(end.message.streamId).toBe(assistants[0].streamId);
			expect(end.message.content).toEqual([{ type: "text", text: "after extension" }]);
			const entry = m.sm.getEntries().find((entry: any) => entry.type === "message" && entry.message.role === "assistant")!;
			expect(end.message.id).toBe(entry.id);
			manager.disposeSession(m);
			const reopened = manager.getManaged(m.sessionPath);
			managed.push(reopened);
			const cold = await manager.buildSnapshot(reopened);
			expect(cold.messages.find((message) => message.role === "assistant")?.id).toBe(entry.id);
		} finally {
			finish();
			auth.mockRestore();
		}
	});

	it("stays busy through agent_end/retry and reloads pending resources only after agent_settled", async () => {
		const { m, session } = await create();
		const rt = await pi.getModelRuntime();
		const model = rt.getModels().find((candidate) => candidate.provider === "openai")!;
		session.agent.state.model = model;
		session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 80 }, compaction: { enabled: false } });
		const auth = vi.spyOn(rt, "hasConfiguredAuth").mockReturnValue(true);
		const first = createAssistantMessageEventStream();
		const second = createAssistantMessageEventStream();
		let calls = 0;
		session.agent.streamFunction = () => (++calls === 1 ? first : second) as never;
		const raw = {
			role: "assistant" as const, content: [], api: model.api, provider: model.provider, model: model.id,
			timestamp: 200, stopReason: "error" as const, errorMessage: "429 rate limit exceeded",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		let final: any;
		try {
			expect(await manager.execute(m, { cmd: "prompt", text: "offline retry" })).toMatchObject({ ok: true });
			first.push({ type: "error", reason: "error", error: raw });
			// 自动重试现在是结构化的 retry 事件（界面聚合成「重试 n/max」一条），不再走 error 通道
			await vi.waitFor(() => expect(m.buffer.some((frame) => { const e = JSON.parse(frame.json); return e.type === "retry" && e.maxAttempts > 0; })).toBe(true));
			expect((await manager.buildSnapshot(m)).isStreaming).toBe(true);
			expect(m.buffer.map((frame) => JSON.parse(frame.json)).filter((event) => event.type === "status").every((event) => event.isStreaming)).toBe(true);
			for (const command of [{ cmd: "reload" }, { cmd: "setActiveTools", names: ["bash"] }, { cmd: "setToolPreset", preset: "full" }] as const) {
				expect(await manager.execute(m, command as any)).toMatchObject({ ok: false });
			}
			const runtime = session.resourceLoader.getExtensions().runtime;
			await pi.reloadLoader(cwd);
			await manager.reloadSessionsForCwd(cwd);
			expect(session.resourceLoader.getExtensions().runtime).toBe(runtime);
			expect(await manager.execute(m, { cmd: "prompt", text: "queued steer", behavior: "steer" })).toMatchObject({ ok: true });
			expect(await manager.execute(m, { cmd: "prompt", text: "queued follow", behavior: "followUp" })).toMatchObject({ ok: true });
			expect(session.getSteeringMessages()).toContain("queued steer");
			expect(session.getFollowUpMessages()).toContain("queued follow");
			session.clearQueue();
			await vi.waitFor(() => expect(calls).toBe(2));
			final = { ...raw, stopReason: "stop" as const, errorMessage: undefined, content: [{ type: "text" as const, text: "recovered" }] };
			second.push({ type: "done", reason: "stop", message: final });
			await vi.waitFor(() => expect(m.runActive).toBe(false));
			await vi.waitFor(() => expect(session.resourceLoader.getExtensions().runtime).not.toBe(runtime));
			expect(session.getActiveToolNames()).not.toContain("probe_tool");
			expect((await manager.buildSnapshot(m)).isStreaming).toBe(false);
		} finally {
			if (!final) second.push({ type: "error", reason: "aborted", error: { ...raw, stopReason: "aborted" } });
			auth.mockRestore();
		}
	});
});
