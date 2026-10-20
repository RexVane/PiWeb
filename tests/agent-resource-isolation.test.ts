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
		pi.on("session_shutdown", (event) => { (globalThis.__piwebProbeShutdowns ??= []).push(event.reason); });
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

	it("includes extension commands in a cold existing-session snapshot before starting its runtime", async () => {
		const { sessionPath } = await manager.createNewSession(cwd);
		const m = manager.getManaged(sessionPath);
		managed.push(m);
		const snapshot = await manager.buildSnapshot(m);
		expect(m.session).toBeNull();
		expect(snapshot.extensionCommands).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "probe" }),
			expect.objectContaining({ name: "ask" }),
		]));
	});

	it("reapplies readonly and custom allowlists on direct, command and resource reload", async () => {
		const { m, session } = await create();
		expect(session.getAllTools().map((tool) => tool.name)).toContain("probe_tool");
		expect(session.getActiveToolNames()).not.toContain("probe_tool");
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls", "ask_user_question"]);
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

	it("loads the SDK built-in extensions but leaves their opt-in tools to the SDK", async () => {
		const { m, session } = await create();
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(["codemode", "tool_search"]));
		expect(await manager.execute(m, { cmd: "setToolPreset", preset: "full" })).toMatchObject({ ok: true });
		// codemode / tool_search 是 defaultActive: false：没配 MCP、defaultTools 也没写，档位放行也不该打开
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "probe_tool"]));
		expect(session.getActiveToolNames()).not.toContain("codemode");
		expect(session.getActiveToolNames()).not.toContain("tool_search");
		// 扩展要求打开（MCP 发现只能经 codemode 调用的工具时就这么做）：readonly 挡住，换到放行它的档位再恢复
		expect(await manager.execute(m, { cmd: "setToolPreset", preset: "readonly" })).toMatchObject({ ok: true });
		session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
		expect(session.getActiveToolNames()).not.toContain("codemode");
		expect(await manager.execute(m, { cmd: "setToolPreset", preset: "standard" })).toMatchObject({ ok: true });
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "codemode"]));
		expect(session.getActiveToolNames()).not.toContain("probe_tool");
		expect(await manager.execute(m, { cmd: "reload" })).toMatchObject({ ok: true });
		expect(session.getActiveToolNames()).toContain("codemode");
		// 扩展把它关掉，之后换档也不再自己冒出来
		session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "codemode"));
		expect(await manager.execute(m, { cmd: "setToolPreset", preset: "full" })).toMatchObject({ ok: true });
		expect(session.getActiveToolNames()).not.toContain("codemode");
	});

	it("lists the built-in extensions in the plugin list", async () => {
		const plugins = await import("../src/lib/plugins-service");
		const builtins = (await plugins.listLoadedExtensions(cwd)).filter((extension) => extension.path.startsWith("builtin:"));
		expect(builtins).toEqual(expect.arrayContaining([
			{ name: "mcp", path: "builtin:mcp", disabled: false },
			{ name: "codemode", path: "builtin:codemode", disabled: false },
			{ name: "tool-search", path: "builtin:tool-search", disabled: false },
		]));
	});

	it("sends session_shutdown before disposing, so extensions such as MCP can close their servers", async () => {
		const shutdowns = () => ((globalThis as { __piwebProbeShutdowns?: string[] }).__piwebProbeShutdowns ?? []).filter((reason) => reason === "quit").length;
		const before = shutdowns();
		const { m } = await create();
		manager.disposeSession(m);
		await vi.waitFor(() => expect(shutdowns()).toBe(before + 1));
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

	it("registers pi's question window in every preset and hands the browser's answer back to the model", async () => {
		const { m, session } = await create();
		// 新会话默认 readonly：选择窗口只是问用户、不碰文件，也要开着
		expect(session.getActiveToolNames()).toContain("ask_user_question");
		const tool = session.getToolDefinition("ask_user_question")!;
		const questions = [{ question: "Which DB?", header: "DB", options: [{ label: "Postgres (Recommended)", description: "solid" }, { label: "SQLite" }] }];
		// 没有页面订阅也挂着等：用户回来打开页面再答
		const run = tool.execute("call-ask", { questions }, undefined, undefined, undefined as never);
		await vi.waitFor(() => expect(m.ui?.getPendingRequests()).toHaveLength(1));
		const request = (await manager.buildSnapshot(m)).extensionUiRequests![0];
		expect(request).toMatchObject({ method: "questions", questions });
		const value = JSON.stringify({ answers: [{ selected: ["SQLite"] }] });
		expect(await manager.execute(m, { cmd: "extensionUiResponse", requestId: request.id, value })).toMatchObject({ ok: true });
		const result = await run;
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("1. Which DB? → SQLite") });
		expect((await manager.buildSnapshot(m)).extensionUiRequests).toEqual([]);
		for (const preset of ["standard", "full"] as const) {
			expect(await manager.execute(m, { cmd: "setToolPreset", preset })).toMatchObject({ ok: true });
			expect(session.getActiveToolNames()).toContain("ask_user_question");
		}
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

	it.runIf(process.platform === "win32")("finds a remembered trust decision whatever case pi wrote the key in", async () => {
		// pi 终端按 shell 里 cwd 的写法记键（大小写不一定真实），SDK 查找又区分大小写：记住的「不信任」会被无视
		const trustFile = path.join(process.env.PI_CODING_AGENT_DIR!, "trust.json");
		const real = await fs.realpath(cwd);
		const lower = real.toLowerCase();
		expect(lower).not.toBe(real);
		await fs.writeFile(trustFile, JSON.stringify({ [lower]: false }));
		try {
			expect(pi.resolveProjectTrust(cwd)).toEqual({ required: true, trusted: false, source: "remembered" });
			expect(pi.resolveProjectTrust(cwd.toUpperCase())).toMatchObject({ trusted: false, source: "remembered" });
			// 改决定时把大小写不同的旧键清掉，否则「忘记」后旧键又冒出来
			pi.setProjectTrust(cwd, true);
			const keys = Object.keys(JSON.parse(await fs.readFile(trustFile, "utf8")));
			expect(keys.filter((key) => key.toLowerCase() === lower)).toEqual([real]);
			pi.setProjectTrust(cwd, null);
			expect(pi.resolveProjectTrust(cwd).source).toBe("default-always");
		} finally {
			await fs.rm(trustFile, { force: true });
			pi.syncProjectTrust();
		}
	});

	it("refreshes the shared model runtime in place and hands hot sessions the new model object", async () => {
		// 回归：保存 models.json 后换了一个新 runtime，会话还挂在旧实例上（选新 provider 报 No API key、扩展 provider 消失）
		const modelsFile = path.join(process.env.PI_CODING_AGENT_DIR!, "models.json");
		const write = (contextWindow: number) => fs.writeFile(modelsFile, JSON.stringify({
			providers: { "piweb-refresh": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "local", models: [{ id: "m1", contextWindow }] } },
		}));
		const rt = await pi.getModelRuntime();
		try {
			await write(1000);
			await pi.refreshModelRuntime();
			expect(await pi.getModelRuntime()).toBe(rt);
			expect(rt.getModel("piweb-refresh", "m1")?.contextWindow).toBe(1000);
			const { session } = await create();
			expect(session.modelRuntime).toBe(rt);
			session.agent.state.model = rt.getModel("piweb-refresh", "m1")!;
			await write(2000);
			await pi.refreshModelRuntime();
			await manager.reloadSessionsForCwd(cwd);
			expect(session.model?.contextWindow).toBe(2000);
		} finally {
			await fs.rm(modelsFile, { force: true });
			await pi.refreshModelRuntime();
		}
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
			for (const command of [{ cmd: "reload" }] as const) {
				expect(await manager.execute(m, command as any)).toMatchObject({ ok: false });
			}
			// 工具变更在运行中改为接受：SDK 会重建系统提示词，下一轮生效（用户要求立即生效）
			for (const command of [{ cmd: "setActiveTools", names: ["bash"] }, { cmd: "setToolPreset", preset: "full" }] as const) {
				expect(await manager.execute(m, command as any)).toMatchObject({ ok: true });
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
			// pi 1.3.0 起 reload 明确保留活动工具集（agent-session.d.ts："Tools removed from it stay
			// active"）：被卸载扩展的工具仍在 SDK 注册表里，所以这里只要求活动集不超出注册表
			// （PiWeb 的 applyToolPolicy 会按注册表重算）。要让 probe_tool 彻底消失需要重开会话。
			const registered = session.getAllTools().map((tool) => tool.name);
			expect(session.getActiveToolNames().every((name) => registered.includes(name))).toBe(true);
			expect((await manager.buildSnapshot(m)).isStreaming).toBe(false);
		} finally {
			if (!final) second.push({ type: "error", reason: "aborted", error: { ...raw, stopReason: "aborted" } });
			auth.mockRestore();
		}
	});
});

