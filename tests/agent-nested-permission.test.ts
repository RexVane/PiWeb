import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { recycleFixture } from "./lib/sandbox/fixtures";

const localCommands: string[] = [];
vi.mock("@earendil-works/pi-coding-agent", async (importActual) => ({
	...await importActual<typeof import("@earendil-works/pi-coding-agent")>(),
	createLocalBashOperations: () => ({ exec: async (command: string) => { localCommands.push(command); return { exitCode: 0 }; } }),
}));
vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

let root: string, cwd: string;
let manager: typeof import("../src/lib/agent-manager");
let pi: typeof import("../src/lib/pi");
const managed: ReturnType<typeof import("../src/lib/agent-manager")["getManaged"]>[] = [];

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-nested-permission-"));
	cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
	await fs.mkdir(agentDir);
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", compaction: { enabled: false } }));
	await fs.writeFile(path.join(cwd, ".pi", "extensions", "nested.js"), `export default function(pi) {
		pi.registerTool({ name: "nested_probe", annotations: { readOnlyHint: true }, label: "Nested test", description: "Offline nested test", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
		prepareLoadout: () => ({ descriptions: { write: "Force the SDK's declared-tool clone" } }),
		execute: async (_id, args, _signal, _update, ctx) => { const first = await ctx.executeTool("write", args); const second = await ctx.executeTool("write", args); return { content: [{ type: "text", text: JSON.stringify({ first, second }) }] }; } });
	}`);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in nested permission regression"); }));
	manager = await import("../src/lib/agent-manager");
	pi = await import("../src/lib/pi");
}, 90_000);

afterAll(async () => {
	for (const m of managed) { m.ui = null; await manager.disposeSessionPath(m.sessionPath); }
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await recycleFixture(root);
});

async function create() {
	const { sessionPath } = await manager.createNewSession(cwd);
	const m = manager.getManaged(sessionPath);
	managed.push(m);
	const session = await manager.ensureSession(m);
	await manager.execute(m, { cmd: "setToolPreset", preset: "workspace" });
	m.ui = { askQuestions: async () => ({ status: "answered", answers: [{ selected: ["允许一次（推荐）"] }] }) } as never;
	return { m, session };
}

it.each(["extension", "codemode"] as const)("consumes one full grant exactly once through actual SDK %s nested calls", async (kind) => {
	const { m, session } = await create();
	session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
	const rt = session.modelRuntime;
	const model = rt.getModels().find((candidate) => candidate.provider === "openai")!;
	session.agent.state.model = model;
	const auth = vi.spyOn(rt, "hasConfiguredAuth").mockReturnValue(true);
	const streams = Array.from({ length: 4 }, () => createAssistantMessageEventStream());
	let calls = 0;
	session.agent.streamFunction = () => streams[calls++] as never;
	const base: AssistantMessage = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 100,
		stopReason: "toolUse", content: [],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const target = path.join(root, `${kind}-outside.txt`);
	const args = { path: target, content: "approved exactly once" };
	const tool = (id: string, name: string, input: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id, name, arguments: input });
	try {
		expect(await manager.execute(m, { cmd: "prompt", text: "offline nested grant regression" })).toMatchObject({ ok: true });
		await vi.waitFor(() => expect(calls).toBe(1));
		streams[0].push({ type: "done", reason: "toolUse", message: { ...base, content: [tool("denied", "write", args)] } });
		await vi.waitFor(() => expect(calls).toBe(2));
		await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
		streams[1].push({ type: "done", reason: "toolUse", message: { ...base, content: [tool("approve", "request_permission", { reason: "offline fixture only", scope: "full", deniedToolCallId: "denied" })] } });
		await vi.waitFor(() => expect(calls).toBe(3));
		expect(m.escalation?.remaining).toBe(1);
		const nestedArgs = kind === "extension" ? args : { code: `for (let index = 0; index < 2; index++) { try { await tools.write(${JSON.stringify(args)}); text("success " + index); } catch (error) { text("blocked " + index); } }` };
		streams[2].push({ type: "done", reason: "toolUse", message: { ...base, content: [tool("nested", kind === "extension" ? "nested_probe" : "codemode", nestedArgs)] } });
		await vi.waitFor(() => expect(calls).toBe(4), { timeout: 20_000 });
		expect(await fs.readFile(target, "utf8")).toBe(args.content);
		expect(m.escalation).toBeUndefined();
		const used = m.sm.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "piweb_permission" && (entry.data as { kind?: string }).kind === "used");
		expect(used).toHaveLength(1);
		const messages = session.messages as Array<{ role: string; toolCallId?: string; content?: Array<{ text?: string }> }>;
		const output = messages.find((message) => message.role === "toolResult" && message.toolCallId === "nested")?.content?.map((part) => part.text ?? "").join("");
		if (kind === "extension") expect(JSON.parse(output!)).toMatchObject({ first: { isError: false }, second: { isError: true } });
		else { expect(output).toContain("success 0"); expect(output).toContain("blocked 1"); }
		streams[3].push({ type: "done", reason: "stop", message: { ...base, stopReason: "stop", content: [{ type: "text", text: "done" }] } });
		await session.waitForIdle();
	} finally {
		session.agent.abort();
		for (const stream of streams) stream.push({ type: "error", reason: "aborted", error: { ...base, stopReason: "aborted", content: [] } });
		await session.waitForIdle();
		auth.mockRestore();
	}
});

it("matches a full bash grant against the prefix captured by the actual tool definition", async () => {
	const settings = pi.getSettingsManager(cwd);
	const prior = settings.getShellCommandPrefix();
	settings.setShellCommandPrefix("echo original-prefix");
	try {
		const { m, session } = await create();
		const bash = session.getToolDefinition("bash")!;
		settings.setShellCommandPrefix("echo changed-after-construction");
		m.lastDeniedAction = { toolName: "bash", toolCallId: "denied-bash", input: { command: "echo approved" } };
		await session.getToolDefinition("request_permission")!.execute("grant-bash", { reason: "test captured prefix", scope: "full" }, undefined, undefined, undefined as never);
		const before = localCommands.length;
		await bash.execute("approved-bash", { command: "echo approved" }, undefined, undefined, undefined as never);
		expect(localCommands.slice(before)).toEqual(["echo original-prefix\necho approved"]);
		expect(m.escalation).toBeUndefined();
	} finally { settings.setShellCommandPrefix(prior); }
});

it("fails closed within a bounded number of checks when permissions keep changing", async () => {
	const { m, session } = await create();
	const config = await import("../src/lib/sandbox/config");
	const target = path.join(cwd, "unstable-permission.txt");
	const previous = m.customActiveTools;
	const reads = vi.spyOn(config, "readSandboxConfig").mockImplementation(async () => {
		m.customActiveTools = ["read", "write"];
		return { additionalWritableRoots: [] };
	});
	try {
		await expect(session.getToolDefinition("write")!.execute("unstable-write", { path: target, content: "must not appear" }, undefined, undefined, undefined as never)).rejects.toThrow("permission configuration changed repeatedly");
		expect(reads.mock.calls.length).toBeLessThanOrEqual(4);
		await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
	} finally { reads.mockRestore(); m.customActiveTools = previous; }
});
