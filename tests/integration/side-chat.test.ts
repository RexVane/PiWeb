import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";

const mocks = vi.hoisted(() => ({ root: "", runtime: null as ModelRuntime | null, managed: new Map<string, any>() }));
vi.mock("@/lib/pi", async (importOriginal) => ({
	...await importOriginal<typeof import("@/lib/pi")>(),
	getAgentDir: () => mocks.root,
	getModelRuntime: async () => mocks.runtime!,
	decodeSessionId: (id: string) => Buffer.from(id, "base64url").toString("utf8"),
	isSessionId: (id: string) => /^[A-Za-z0-9_-]{9,}$/.test(id),
}));
vi.mock("@/lib/agent-manager", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/agent-manager")>(), getManaged: (file: string) => {
	const managed = mocks.managed.get(file);
	if (!managed) throw new Error("unexpected main session");
	return managed;
} }));

import { GET, POST, DELETE } from "@/app/api/agent/[id]/side-chat/route";
import { buildSideChatContext, mainConversationText, parseSideChatRequest } from "@/lib/side-chat/context";
import { pollSideChat, startSideChat, stopSideChat } from "@/lib/side-chat/service";

const faux = fauxProvider({ provider: "side-chat-test" });
const fauxQuick = fauxProvider({ provider: "side-chat-quick" });
let file: string;
let sm: SessionManager;
let managed: any;
let spy: ReturnType<typeof vi.spyOn>;
const request = (text = "复用 Session 存储是什么意思?", history: { role: "user" | "assistant"; text: string }[] = [], model?: { provider: string; id: string }) => ({ requestId: randomUUID(), threadId: randomUUID(), text, history, ...(model ? { model } : {}) });
const params = () => ({ params: Promise.resolve({ id: Buffer.from(file).toString("base64url") }) });
async function finish(requestId: string) {
	let progress = await pollSideChat(file, requestId, -1, new AbortController().signal);
	let text = progress.text;
	while (!progress.done) {
		progress = await pollSideChat(file, requestId, progress.revision, new AbortController().signal);
		text = progress.textOffset === undefined ? progress.text : text.slice(0, progress.textOffset) + progress.text;
	}
	return { ...progress, text };
}

beforeAll(async () => {
	mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-side-chat-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", mocks.root);
	vi.stubEnv("PI_OFFLINE", "1");
	mocks.runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() });
	mocks.runtime.registerNativeProvider(faux.provider);
	mocks.runtime.registerNativeProvider(fauxQuick.provider);
	spy = vi.spyOn(mocks.runtime, "streamSimple");
});
beforeEach(async () => {
	const model = faux.getModel();
	sm = SessionManager.create(path.join(mocks.root, "workspace"), path.join(mocks.root, "sessions"));
	sm.appendModelChange(model.provider, model.id);
	sm.appendMessage({ role: "user", content: "介绍 PiWeb 的实现", timestamp: 1 });
	sm.appendMessage({ ...fauxAssistantMessage([fauxText("复用 Session 存储：Web 与 CLI 读取同一份 JSONL。")]), provider: model.provider, model: model.id, api: model.api });
	file = sm.getSessionFile()!;
	await fs.mkdir(path.join(mocks.root, "workspace"), { recursive: true });
	managed = { sm, cwd: path.join(mocks.root, "workspace"), session: null, inflight: null };
	mocks.managed.set(file, managed);
	faux.setResponses([fauxAssistantMessage([fauxText("Session 存储就是主会话的 JSONL 文件。")])]);
	spy.mockClear();
});
afterAll(async () => {
	spy.mockRestore();
	vi.unstubAllEnvs();
	await fs.rm(mocks.root, { recursive: true, force: true });
});

describe("side-chat isolation through the real Pi SDK", () => {
	it("answers several questions without changing the main file, active leaf, context or cold session", async () => {
		const before = await fs.readFile(file);
		const context = JSON.stringify(sm.buildSessionContext());
		const leaf = sm.getLeafId();
		const first = request();
		const post = await POST(new Request("http://localhost/api/agent/main/side-chat", { method: "POST", body: JSON.stringify(first) }), params());
		expect(post.status, await post.clone().text()).toBe(200);
		const firstAnswer = await finish(first.requestId);
		expect(firstAnswer.error).toBeUndefined();
		expect(firstAnswer).toMatchObject({ done: true, text: "Session 存储就是主会话的 JSONL 文件。", aborted: false });
		faux.setResponses([fauxAssistantMessage([fauxText("模型也由同一套配置目录提供。")])]);
		const quick = fauxQuick.getModel();
		fauxQuick.setResponses([fauxAssistantMessage([fauxText("这个回答用的是旁聊自己选的模型。")])]);
		const second = request("Model 又是怎么复用的?", [{ role: "user", text: first.text }, { role: "assistant", text: firstAnswer.text }], { provider: quick.provider, id: quick.id });
		startSideChat(file, second);
		expect((await finish(second.requestId)).text).toBe("这个回答用的是旁聊自己选的模型。");
		const payload = JSON.stringify(spy.mock.calls.at(-1)![1]);
		expect(payload).toContain(firstAnswer.text);
		expect(payload).toContain("Web 与 CLI 读取同一份 JSONL");
		expect(getCurrentTools(spy.mock.calls.at(-1)![1].messages).map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "bash", "edit", "write"]));
		expect(spy.mock.calls.at(-1)![2].sessionId).toEqual(expect.any(String));
		expect(spy.mock.calls.at(-1)![2].sessionId).not.toBe(sm.getSessionId());
		// 旁聊单独选的模型覆盖主会话当前模型
		expect(spy.mock.calls.at(-1)![0]).toMatchObject({ provider: quick.provider, id: quick.id });
		expect(await fs.readFile(file)).toEqual(before);
		expect(sm.getLeafId()).toBe(leaf);
		expect(JSON.stringify(sm.buildSessionContext())).toBe(context);
		expect(managed.session).toBeNull();
	});


	it("reads a real relative file, then answers from the tool result without modifying the main session", async () => {
		const readme = path.join(managed.cwd, "README.md");
		await fs.writeFile(readme, "# Project\nRead-only file sentinel: 旁聊可以读取项目。\n");
		const before = await fs.readFile(file);
		const source = JSON.stringify(sm.buildSessionContext());
		const leaf = sm.getLeafId();
		faux.setResponses([
			fauxAssistantMessage([fauxText("我先查看 README。"), fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				expect(result).toMatchObject({ toolName: "read", isError: false });
				expect(JSON.stringify(result)).toContain("Read-only file sentinel");
				return fauxAssistantMessage(fauxText("文件确认：旁聊可以读取项目。"));
			},
		]);
		const question = request("读取这个项目的 README 并解释。");
		startSideChat(file, question);
		const answer = await finish(question.requestId);
		expect(answer.error, answer.error).toBeUndefined();
		expect(answer).toMatchObject({ done: true, aborted: false, text: "我先查看 README。\n\n文件确认：旁聊可以读取项目。", activeTool: null });
		expect(answer.error).toBeUndefined();
		expect(answer.characters!.systemTools).toBeGreaterThan(0);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(await fs.readFile(file)).toEqual(before);
		expect(await fs.readFile(readme, "utf8")).toContain("Read-only file sentinel");
		expect(sm.getLeafId()).toBe(leaf);
		expect(JSON.stringify(sm.buildSessionContext())).toBe(source);
		expect(managed.session).toBeNull();
	});

	it("provides ls, find and grep from the main project's working directory", async () => {
		await fs.writeFile(path.join(managed.cwd, "notes.txt"), "side-chat-search-sentinel\n");
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("ls", { path: "." }),
				fauxToolCall("find", { pattern: "*.txt", path: "." }),
				fauxToolCall("grep", { pattern: "side-chat-search-sentinel", path: "." }),
			], { stopReason: "toolUse" }),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				expect(results).toHaveLength(3);
				for (const result of results) { expect(result.isError, JSON.stringify(result)).toBe(false); expect(JSON.stringify(result)).toContain("notes.txt"); }
				return fauxAssistantMessage(fauxText("找到 notes.txt 中的标记。"));
			},
		]);
		const question = request("列出并搜索这个项目。");
		startSideChat(file, question);
		const answer = await finish(question.requestId);
		expect(answer.error).toBeUndefined();
		expect(answer.text).toBe("找到 notes.txt 中的标记。");
	});

	it("edits and writes files and executes commands through the full SDK without changing the main session", async () => {
		const target = path.join(managed.cwd, "editable.txt");
		await fs.writeFile(target, "old content\n");
		const before = await fs.readFile(file);
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("edit", { path: "editable.txt", oldText: "old content", newText: "changed content" }),
				fauxToolCall("write", { path: "created.txt", content: "written by side chat\n" }),
				fauxToolCall("bash", { command: "node -e \"console.log('side-chat-command-sentinel')\"" }),
			], { stopReason: "toolUse" }),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				expect(results).toHaveLength(3);
				for (const result of results) expect(result.isError, JSON.stringify(result)).toBe(false);
				expect(JSON.stringify(results)).toContain("side-chat-command-sentinel");
				const tools = getCurrentTools(context.messages).map((tool) => tool.name);
				expect(tools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "codemode", "tool_search"]));
				return fauxAssistantMessage(fauxText("文件已修改，命令已执行。"));
			},
		]);
		const question = request("修改文件并运行检查命令。");
		startSideChat(file, question);
		const answer = await finish(question.requestId);
		expect(answer.error, answer.error).toBeUndefined();
		expect(await fs.readFile(target, "utf8")).toBe("changed content\n");
		expect(await fs.readFile(path.join(managed.cwd, "created.txt"), "utf8")).toBe("written by side chat\n");
		expect(await fs.readFile(file)).toEqual(before);
		expect(answer.entries?.some((entry) => entry.type === "message" && entry.message.role === "toolResult")).toBe(true);
	});

	it("stopping after a tool result prevents the next request from generating or executing more tools", async () => {
		const before = await fs.readFile(file);
		const question = request("检查后停止。");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			() => {
				stopSideChat(file, question.requestId);
				return fauxAssistantMessage(fauxToolCall("read", { path: "should-not-read.txt" }), { stopReason: "toolUse" });
			},
		]);
		startSideChat(file, question);
		expect(await finish(question.requestId)).toMatchObject({ done: true, aborted: true, activeTool: null });
		expect(spy).toHaveBeenCalledTimes(2);
		expect(await fs.readFile(file)).toEqual(before);
	});

	it("restores full browser history in a new SDK session while keeping tool results out of main history", async () => {
		await fs.writeFile(path.join(managed.cwd, "history.txt"), "a tool result to remember\n");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "history.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("我已查看这个文件。"),
		]);
		const first = request("读取 history.txt。"); startSideChat(file, first); const answer = await finish(first.requestId);
		expect(answer.error).toBeUndefined();
		faux.setResponses([(context) => { expect(JSON.stringify(context)).toContain("a tool result to remember"); return fauxAssistantMessage("恢复后仍然记得读取结果。"); }]);
		const next = { ...request("之前工具读取了什么？"), entries: answer.entries, leafId: answer.leafId };
		startSideChat(file, next); expect((await finish(next.requestId)).text).toBe("恢复后仍然记得读取结果。");
		expect(JSON.stringify(sm.buildSessionContext())).not.toContain("a tool result to remember");
	});

	it("uses only the active branch, applies context edits and includes the currently streaming answer", async () => {
		const leaf = sm.getLeafId()!;
		sm.appendMessage({ role: "user", content: "abandoned private branch", timestamp: 5 });
		sm.branch(leaf);
		const target = sm.appendMessage({ role: "user", content: "original unedited text", timestamp: 6 });
		sm.appendContextEdit(target, { content: "edited background" });
		managed.inflight = { role: "assistant", content: [{ type: "text", text: "currently visible partial answer" }, { type: "thinking", thinking: "hidden thinking" }], timestamp: 7 };
		const before = await fs.readFile(file);
		const question = request();
		startSideChat(file, question);
		await finish(question.requestId);
		const payload = JSON.stringify(spy.mock.calls[0][1]);
		expect(payload).toContain("edited background");
		expect(payload).toContain("currently visible partial answer");
		expect(payload).not.toContain("original unedited text");
		expect(payload).not.toContain("abandoned private branch");
		expect(payload).not.toContain("hidden thinking");
		expect(await fs.readFile(file)).toEqual(before);
	});

	it("treats slash commands as side questions and stops only the side answer", async () => {
		const slow = fauxProvider({ provider: "side-chat-slow", tokensPerSecond: 80 });
		mocks.runtime!.registerNativeProvider(slow.provider);
		const model = slow.getModel();
		managed.session = { model, thinkingLevel: "off", prompt: vi.fn(), abort: vi.fn() };
		slow.setResponses([fauxAssistantMessage([fauxText("慢慢解释。".repeat(200))])]);
		const before = await fs.readFile(file);
		const question = request("/compact 是什么？");
		startSideChat(file, question);
		await pollSideChat(file, question.requestId, 0, new AbortController().signal);
		const response = await DELETE(new Request(`http://localhost/api/agent/main/side-chat?requestId=${question.requestId}`, { method: "DELETE" }), params());
		expect(response.status).toBe(200);
		expect(await finish(question.requestId)).toMatchObject({ done: true, aborted: true });
		expect(managed.session.prompt).not.toHaveBeenCalled();
		expect(managed.session.abort).not.toHaveBeenCalled();
		expect(await fs.readFile(file)).toEqual(before);
	});

	it("an early stop prevents a POST arriving later from starting a model request", async () => {
		const question = request();
		stopSideChat(file, question.requestId);
		expect(startSideChat(file, question)).toMatchObject({ done: true, aborted: true });
		expect(spy).not.toHaveBeenCalled();
	});

	it("deduplicates accepted requests and scopes poll results to their main session", async () => {
		const question = request();
		startSideChat(file, question);
		startSideChat(file, question);
		await finish(question.requestId);
		expect(spy).toHaveBeenCalledTimes(1);
		await expect(pollSideChat(file + ".other", question.requestId, -1, new AbortController().signal)).rejects.toThrow("expired");
		const result = await GET(new Request(`http://localhost/api/agent/main/side-chat?requestId=${question.requestId}&after=0`), params());
		expect(result.headers.get("cache-control")).toBe("no-store");
		expect((await result.json()).data.done).toBe(true);
	});

	it("rejects malformed payloads and paths before issuing a model call", async () => {
		const bad = { ...request(), history: [{ role: "system", text: "active instruction" }] };
		expect((await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(bad) }), params())).status).toBe(400);
		const outside = Buffer.from(path.join(mocks.root, "outside.jsonl")).toString("base64url");
		expect((await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(request()) }), { params: Promise.resolve({ id: outside }) })).status).toBe(400);
		expect(spy).not.toHaveBeenCalled();
	});
});

it("rejects an unknown side-chat model before issuing a call", async () => {
	const unknown = request("问题", [], { provider: "no-such-provider", id: "no-such-model" });
	startSideChat(file, unknown);
	const progress = await finish(unknown.requestId);
	expect(progress.done).toBe(true);
	expect(progress.error).toContain("unavailable");
});

describe("side-chat background bounds", () => {
	it("preserves ordinary history and leaves the source untouched", () => {
		const question = request("举个例子", [{ role: "user", text: "之前的问题" }, { role: "assistant", text: "之前的解释" }]);
		const before = JSON.stringify(question);
		const built = buildSideChatContext("主会话说明", question, faux.getModel());
		expect(built.contextTruncated).toBe(false);
		expect(built.context.messages.at(-1)).toMatchObject({ role: "user", content: "举个例子" });
		expect(JSON.stringify(built.context)).toContain("之前的解释");
		expect(JSON.stringify(question)).toBe(before);
	});
	it("bounds long Chinese and emoji background without corrupting Unicode, and reports omissions", () => {
		const model = { ...faux.getModel(), contextWindow: 6000, maxTokens: 1000 };
		const main = "开头信息\n" + "会话存储🙂".repeat(4000) + "\n最新信息";
		const built = buildSideChatContext(main, request("解释一下"), model);
		const body = JSON.stringify(built.context);
		expect(built.contextTruncated).toBe(true);
		expect(body).toContain("开头信息");
		expect(body).toContain("最新信息");
		expect(body).not.toContain("�");
		expect(Buffer.byteLength(body)).toBeLessThan(model.contextWindow - built.maxTokens);
	});
	it("does not forward instructions, thinking or tool definitions from the main session", () => {
		const text = mainConversationText([{ role: "system", content: "main system rules", toolsAdded: [{ name: "write" }] }, { role: "assistant", content: [{ type: "text", text: "visible answer" }, { type: "thinking", thinking: "private reasoning" }, { type: "toolCall", name: "write", arguments: { text: "not a tool request" } }] }]);
		expect(text).toBe("[assistant]\nvisible answer");
		expect(() => parseSideChatRequest({ ...request(), text: " " })).toThrow();
	});
});
