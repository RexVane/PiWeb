import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";

const mocks = vi.hoisted(() => ({ root: "", runtime: null as ModelRuntime | null, managed: new Map<string, any>() }));
vi.mock("@/lib/pi", () => ({
	getAgentDir: () => mocks.root,
	getModelRuntime: async () => mocks.runtime!,
	decodeSessionId: (id: string) => Buffer.from(id, "base64url").toString("utf8"),
	isSessionId: (id: string) => /^[A-Za-z0-9_-]{9,}$/.test(id),
}));
vi.mock("@/lib/agent-manager", () => ({ getManaged: (file: string) => {
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
	managed = { sm, session: null, inflight: null };
	mocks.managed.set(file, managed);
	faux.setResponses([fauxAssistantMessage([fauxText("Session 存储就是主会话的 JSONL 文件。")])]);
	spy.mockClear();
});
afterAll(async () => {
	spy.mockRestore();
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
		expect(spy.mock.calls.at(-1)![1].tools).toEqual([]);
		expect(spy.mock.calls.at(-1)![2].sessionId).toBe(`piweb-sidechat-${second.threadId}`);
		// 旁聊单独选的模型覆盖主会话当前模型
		expect(spy.mock.calls.at(-1)![0]).toMatchObject({ provider: quick.provider, id: quick.id });
		expect(await fs.readFile(file)).toEqual(before);
		expect(sm.getLeafId()).toBe(leaf);
		expect(JSON.stringify(sm.buildSessionContext())).toBe(context);
		expect(managed.session).toBeNull();
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
