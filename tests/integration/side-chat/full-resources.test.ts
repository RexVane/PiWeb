import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentTools, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
const mocks = vi.hoisted(() => ({ agent: "", runtime: null as ModelRuntime | null, main: new Map<string, any>() }));
vi.mock("@/lib/pi", async (original) => ({ ...await original<typeof import("@/lib/pi")>(), getAgentDir: () => mocks.agent, getModelRuntime: async () => mocks.runtime! }));
vi.mock("@/lib/agent-manager", async (original) => ({ ...await original<typeof import("@/lib/agent-manager")>(), getManaged: (file: string) => { const main = mocks.main.get(file); if (!main) throw new Error("unexpected main session"); return main; } }));
import { startSideChat, pollSideChat } from "@/lib/side-chat/service";
import { controlSideChat, disposeSideRuntime, getSideRuntime } from "@/lib/side-chat/runtime";
import { getSettingsManager } from "@/lib/pi";
const faux = fauxProvider({ provider: "full-side-resources" });
let testRoot: string, file: string, cwd: string, sm: SessionManager;
let server: http.Server;
const sessions: Array<[string, string]> = [];
const calls: string[] = [];
const request = (text: string) => { const input = { requestId: randomUUID(), threadId: randomUUID(), text, history: [] }; sessions.push([file, input.threadId]); return input; };
async function finish(requestId: string) {
	let progress = await pollSideChat(file, requestId, -1, new AbortController().signal); let text = progress.text;
	while (!progress.done) { progress = await pollSideChat(file, requestId, progress.revision, new AbortController().signal); text = text.slice(0, progress.textOffset ?? 0) + progress.text; }
	return { ...progress, text };
}
beforeAll(async () => {
	testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-full-side-resources-")); mocks.agent = path.join(testRoot, "agent");
	await fs.mkdir(path.join(mocks.agent, "extensions"), { recursive: true }); await fs.mkdir(path.join(mocks.agent, "skills", "side-note"), { recursive: true }); await fs.mkdir(path.join(mocks.agent, "prompts"), { recursive: true });
	await fs.writeFile(path.join(mocks.agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", defaultProvider: "full-side-resources", compaction: { enabled: false } }));
	await fs.writeFile(path.join(mocks.agent, "skills", "side-note", "SKILL.md"), "---\nname: side-note\ndescription: Side skill catalog sentinel.\n---\nSkill content sentinel: SIDESKILL-14.\n");
	await fs.writeFile(path.join(mocks.agent, "prompts", "side-template.md"), "---\ndescription: Side template sentinel.\n---\nTemplate content sentinel: $1\n");
	await fs.writeFile(path.join(mocks.agent, "extensions", "probe.js"), "export default function(pi) {\n pi.registerTool({ name: \"probe_tool\", label: \"Probe\", description: \"Side plugin test\", parameters: { type: \"object\", properties: { value: { type: \"string\" } }, required: [\"value\"] }, execute: async (_id, params) => ({ content: [{ type: \"text\", text: \"PLUGIN-RESULT: \" + params.value }] }) });\n pi.on(\"session_start\", async (_event, ctx) => { if (ctx.cwd.includes(\"dialog-\")) { const yes = await ctx.ui.confirm(\"Side approval\", \"Continue this side task?\"); pi.appendEntry(\"side-confirm\", { yes }); } });\n}");
	server = http.createServer(async (req, res) => {
		if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
		let text = ""; for await (const chunk of req) text += chunk; const body = JSON.parse(text); calls.push(body.method);
		if (body.id === undefined) { res.writeHead(202); res.end(); return; }
		let result: unknown = {};
		if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "side-audit", version: "1" } };
		else if (body.method === "tools/list") result = { tools: [{ name: "echo", description: "Offline side MCP echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
		else if (body.method === "tools/call") result = { content: [{ type: "text", text: "MCP-RESULT: " + body.params.arguments.text }] };
		res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port;
	await fs.writeFile(path.join(mocks.agent, "mcp.json"), JSON.stringify({ mcpServers: { audit: { url: "http://127.0.0.1:" + port + "/mcp", exposure: "direct", timeout: 3 } } }));
	vi.stubEnv("PI_CODING_AGENT_DIR", mocks.agent); vi.stubEnv("PI_OFFLINE", "1");
	mocks.runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() }); mocks.runtime.registerNativeProvider(faux.provider);
}, 60_000);
beforeEach(async () => {
	cwd = path.join(testRoot, "workspace-" + randomUUID()); await fs.mkdir(cwd, { recursive: true }); await fs.writeFile(path.join(cwd, "AGENTS.md"), "Project memory sentinel: SIDE-MEMORY-14.\n");
	sm = SessionManager.create(cwd); const model = faux.getModel(); sm.appendModelChange(model.provider, model.id); sm.appendMessage({ role: "user", content: "Main context remains independent.", timestamp: 0 }); sm.appendMessage({ ...fauxAssistantMessage("Main answer."), provider: model.provider, model: model.id, api: model.api }); file = sm.getSessionFile()!;
	mocks.main.set(file, { sm, cwd, session: null, inflight: null });
});
afterAll(async () => { for (const [file, thread] of sessions) disposeSideRuntime(file, thread); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); vi.unstubAllEnvs(); await fs.rm(testRoot, { recursive: true, force: true }); });

describe("full side Agent resources", () => {
	it("loads project memory, skill catalog, extensions and real configured MCP tools", async () => {
		const before = await fs.readFile(file);
		faux.setResponses([
			(context) => { const prompt = JSON.stringify(context); expect(prompt).toContain("SIDE-MEMORY-14"); expect(prompt).toContain("side-note"); expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(expect.arrayContaining(["probe_tool", "mcp__audit__echo", "codemode", "tool_search"])); return fauxAssistantMessage([fauxToolCall("probe_tool", { value: "plugin-sentinel" }), fauxToolCall("mcp__audit__echo", { text: "mcp-sentinel" })], { stopReason: "toolUse" }); },
			(context) => { const results = context.messages.filter((message) => message.role === "toolResult"); expect(results.every((message) => !message.isError)).toBe(true); expect(JSON.stringify(results)).toContain("plugin-sentinel"); expect(JSON.stringify(results)).toContain("MCP-RESULT: mcp-sentinel"); return fauxAssistantMessage("插件和 MCP 都可用。"); },
		]);
		const input = request("使用插件工具和 MCP。"); startSideChat(file, input); const result = await finish(input.requestId); expect(result.error, result.error).toBeUndefined(); expect(result.text).toBe("插件和 MCP 都可用。"); expect(calls).toContain("tools/call"); expect(await fs.readFile(file)).toEqual(before);
	});
	it("expands skill and prompt-template commands through the same SDK", async () => {
		faux.setResponses([(context) => { expect(JSON.stringify(context)).toContain("SIDESKILL-14"); return fauxAssistantMessage("技能内容已加载。"); }]); const skill = request("/skill:side-note explain"); startSideChat(file, skill); expect((await finish(skill.requestId)).error).toBeUndefined();
		faux.setResponses([(context) => { expect(JSON.stringify(context)).toContain("Template content sentinel: example"); return fauxAssistantMessage("模板内容已展开。"); }]); const template = request("/side-template example"); startSideChat(file, template); expect((await finish(template.requestId)).error).toBeUndefined();
	});
	it("routes extension confirmation during session startup only to the owning side conversation", async () => {
		cwd = path.join(testRoot, "dialog-" + randomUUID()); await fs.mkdir(cwd, { recursive: true }); sm = SessionManager.create(cwd); const model = faux.getModel(); sm.appendModelChange(model.provider, model.id); sm.appendMessage({ role: "user", content: "main untouched", timestamp: 0 }); sm.appendMessage({ ...fauxAssistantMessage("main reply"), provider: model.provider, model: model.id, api: model.api }); file = sm.getSessionFile()!; mocks.main.set(file, { sm, cwd, session: null, inflight: null }); const before = await fs.readFile(file);
		faux.setResponses([fauxAssistantMessage("确认已收到。")]); const input = request("继续这个旁聊任务。"); startSideChat(file, input);
		let progress = await pollSideChat(file, input.requestId, -1, new AbortController().signal);
		while (!progress.extensionUiRequests?.length && !progress.events?.some((event) => event.type === "extension_ui" && event.method === "confirm") && !progress.done) progress = await pollSideChat(file, input.requestId, progress.revision, new AbortController().signal);
		expect(progress.done, progress.error).toBe(false); const dialog = progress.extensionUiRequests?.[0] ?? progress.events?.find((event) => event.type === "extension_ui" && event.method === "confirm") as { id: string; title: string }; expect(dialog.title).toBe("Side approval");
		await controlSideChat(file, { threadId: input.threadId, command: { cmd: "extensionUiResponse", requestId: dialog.id, confirmed: true } });
		const result = await finish(input.requestId); expect(result.error, result.error).toBeUndefined(); expect(result.entries?.some((entry) => entry.type === "custom" && entry.customType === "side-confirm" && (entry.data as { yes: boolean }).yes)).toBe(true); expect(await fs.readFile(file)).toEqual(before);
	});
	it("keeps side Agent preference changes in memory without modifying global settings", async () => {
		faux.setResponses([fauxAssistantMessage("完成。")]); const input = request("回答这个问题。"); startSideChat(file, input); expect((await finish(input.requestId)).error).toBeUndefined();
		const before = await fs.readFile(path.join(mocks.agent, "settings.json")); const source = getSettingsManager(cwd); const settings = getSideRuntime(file, input).managed.session!.settingsManager;
		settings.setDefaultProvider("side-only-choice"); expect(settings.getDefaultProvider()).toBe("side-only-choice"); expect(source.getDefaultProvider()).toBe("full-side-resources"); expect(await fs.readFile(path.join(mocks.agent, "settings.json"))).toEqual(before);
	});
});
