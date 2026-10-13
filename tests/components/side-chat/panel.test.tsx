// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SideChatPanel } from "@/components/side-chat/SideChatPanel";
import { SideChatStore } from "@/components/side-chat/store";
import { ChatWindow } from "@/components/ChatWindow";
import type { WebMessage } from "@/lib/types";

vi.mock("next/dynamic", () => ({ default: () => ({ text }: { text: string }) => <p>{text}</p> }));

const initial = (requestId: string) => ({ requestId, revision: 0, text: "", done: false, aborted: false });
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}
function setup() {
	let sequence = 0;
	const fetchImpl = vi.fn<typeof fetch>();
	const answers = new Map<string, ReturnType<typeof deferred<Response>>>();
	fetchImpl.mockImplementation(async (_url, init) => {
		if (init?.method === "DELETE") return new Response(JSON.stringify({ success: true }));
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			answers.set(body.requestId, deferred<Response>());
			return response(initial(body.requestId));
		}
		const id = new URL(String(_url), "http://localhost").searchParams.get("requestId")!;
		return answers.get(id)!.promise;
	});
	const store = new SideChatStore({ fetch: fetchImpl, storage: () => localStorage, id: () => `test-id-${++sequence}` });
	const reply = async (text: string, index = -1) => {
		const [id, pending] = [...answers.entries()].at(index)!;
		await act(async () => pending.resolve(response({ ...initial(id), revision: 1, text, done: true })));
	};
	return { store, fetchImpl, reply, answers };
}
const questionInput = () => screen.getByRole("textbox", { name: "旁聊提问" });
const current = (store: SideChatStore, id = "main-session-a") => {
	const state = store.get(id);
	return state.threads.find((thread) => thread.id === state.currentThreadId)!;
};
const models = [
	{ provider: "demo", id: "main-model", name: "主模型", reasoning: false, contextWindow: 128000 },
	{ provider: "demo", id: "quick-model", name: "快答模型", reasoning: true, thinkingLevels: ["off", "high"], contextWindow: 64000 },
];
const modelProps = { mainModel: { provider: "demo", id: "main-model", name: "主模型" }, models, providerNames: { demo: "Demo" }, authByProvider: { demo: true } };
/** 默认带上主模型(等价于主会话已经用过的场景);测试没给模型时按「主会话还没选模型」处理 */
const panel = (store: SideChatStore, props: Record<string, unknown> = {}) => (
	<SideChatPanel sessionId="main-session-a" store={store} onClose={() => {}} {...modelProps} {...props} />
);
const postBodies = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) =>
	fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("persistent, simple side-chat panel", () => {
	it("keeps the main reading position and messages while sending several independent questions", async () => {
		const { store, reply, fetchImpl } = setup();
		const messages: WebMessage[] = [
			{ role: "user", id: "main-user", content: [{ type: "text", text: "主线问题" }] },
			{ role: "assistant", id: "main-answer", content: [{ type: "text", text: "原回答后面还没有读完" }], stopReason: "stop" },
		];
		render(<><ChatWindow messages={messages} tools={{}} />{panel(store)}</>);
		await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const mainLog = screen.getAllByRole("log").find((node) => node.getAttribute("aria-label") !== "旁聊消息")!;
		Object.defineProperty(mainLog, "scrollHeight", { configurable: true, value: 4000 });
		Object.defineProperty(mainLog, "clientHeight", { configurable: true, value: 500 });
		mainLog.scrollTop = 3500;
		fireEvent.scroll(mainLog);
		mainLog.scrollTop = 1234;
		fireEvent.scroll(mainLog);
		fireEvent.change(questionInput(), { target: { value: "Session 怎么复用?" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(current(store).request).toBeDefined());
		await reply("同一份文件。");
		fireEvent.change(questionInput(), { target: { value: "Model 呢?" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(postBodies(fetchImpl)).toHaveLength(2));
		await reply("同一份配置。");
		expect(mainLog.scrollTop).toBe(1234);
		expect(mainLog.textContent).toContain("原回答后面还没有读完");
		expect(mainLog.textContent).not.toContain("Session 怎么复用");
		expect(postBodies(fetchImpl)[1].history).toEqual([{ role: "user", text: "Session 怎么复用?" }, { role: "assistant", text: "同一份文件。" }]);
		expect(fetchImpl.mock.calls.every(([url]) => String(url).includes("/side-chat"))).toBe(true);
		const inPanel = within(screen.getByTestId("side-chat-panel"));
		expect(inPanel.queryByText(/token|缓存命中|工具调用|首 token|耗时/)).toBeNull();
	});

	it("follows the main model by default and sends an explicit model once the side chat picks another", async () => {
		const { store, reply, fetchImpl } = setup();
		render(panel(store));
		expect(screen.getByRole("button", { name: /跟随主会话/ })).toBeTruthy();
		fireEvent.change(questionInput(), { target: { value: "第一个问题" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(postBodies(fetchImpl)).toHaveLength(1));
		expect(postBodies(fetchImpl)[0].model).toBeUndefined();
		await reply("第一个回答");
		fireEvent.click(screen.getByRole("button", { name: /跟随主会话/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: "快答模型" }));
		expect(current(store).model).toEqual({ provider: "demo", id: "quick-model" });
		fireEvent.change(questionInput(), { target: { value: "第二个问题" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(postBodies(fetchImpl)).toHaveLength(2));
		expect(postBodies(fetchImpl)[1].model).toEqual({ provider: "demo", id: "quick-model" });
		expect(postBodies(fetchImpl)[1].history).toEqual([{ role: "user", text: "第一个问题" }, { role: "assistant", text: "第一个回答" }]);
	});

	it("keeps a picked model with its thread, survives restoration, and can return to following the main model", async () => {
		const { store, fetchImpl } = setup();
		render(panel(store));
		fireEvent.click(screen.getByRole("button", { name: /跟随主会话/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: "快答模型" }));
		const picked = current(store).id;
		expect(current(new SideChatStore({ fetch: fetchImpl, storage: () => localStorage, id: () => "restored-id" })).model).toEqual({ provider: "demo", id: "quick-model" });
		fireEvent.change(questionInput(), { target: { value: "问题" } });
		fireEvent.click(screen.getByRole("button", { name: "新旁聊" }));
		expect(current(store).model).toEqual({ provider: "demo", id: "quick-model" });
		fireEvent.click(screen.getByRole("button", { name: "旁聊记录" }));
		// 菜单按新到旧排：最后一项就是最早那个（原旁聊）
		fireEvent.click(screen.getAllByRole("menuitemradio").at(-1)!);
		expect(current(store).id).toBe(picked);
		fireEvent.click(screen.getByRole("button", { name: /快答模型/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: /跟随主会话/ }));
		expect(current(store).model).toBeUndefined();
	});

	it("keeps the draft until a model exists, and never sends without one", async () => {
		const { store, fetchImpl } = setup();
		const view = render(panel(store, { mainModel: undefined }));
		fireEvent.change(questionInput(), { target: { value: "等模型" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(current(store).draft).toBe("等模型");
		// 主会话还没有模型时也可以自己选一个,选中后就能发
		fireEvent.click(screen.getByRole("button", { name: /选择模型|主模型/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: "快答模型" }));
		view.rerender(panel(store));
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(postBodies(fetchImpl)).toHaveLength(1));
		expect(postBodies(fetchImpl)[0].model).toEqual({ provider: "demo", id: "quick-model" });
	});

	it("finishes an answer while the panel is closed and keeps it on reopen and browser restoration", async () => {
		const { store, reply, fetchImpl } = setup();
		const view = render(panel(store));
		fireEvent.change(questionInput(), { target: { value: "解释复用" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
		view.unmount();
		await reply("独立回答仍然完成。");
		render(panel(store));
		expect(screen.getByText("独立回答仍然完成。")).toBeTruthy();
		const restored = new SideChatStore({ fetch: fetchImpl, storage: () => localStorage, id: () => "restored-id" });
		expect(current(restored).messages.map((message) => message.text)).toEqual(["解释复用", "独立回答仍然完成。"]);
	});

	it("keeps drafts and late answers with their source conversation, and preserves earlier side-chat threads", async () => {
		const { store, reply } = setup();
		const view = render(panel(store));
		fireEvent.change(questionInput(), { target: { value: "A 的问题" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(current(store).request).toBeDefined());
		view.rerender(panel(store, { sessionId: "main-session-b" }));
		fireEvent.change(questionInput(), { target: { value: "B 的草稿" } });
		await reply("这是 A 的回答。");
		expect((questionInput() as HTMLTextAreaElement).value).toBe("B 的草稿");
		expect(screen.queryByText("这是 A 的回答。")).toBeNull();
		view.rerender(panel(store));
		const original = current(store).id;
		expect(screen.getByText("这是 A 的回答。")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "新旁聊" }));
		expect(current(store).messages).toEqual([]);
		expect(store.get("main-session-a").threads).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "旁聊记录" }));
		fireEvent.click(screen.getAllByRole("menuitemradio").at(-1)!);
		expect(current(store).id).toBe(original);
		expect(screen.getByText("这是 A 的回答。")).toBeTruthy();
	});

	it("stops a pending request, ignores a late answer, and allows Chinese composition and multiline input", async () => {
		const { store, reply, fetchImpl } = setup();
		render(panel(store));
		fireEvent.change(questionInput(), { target: { value: "中文问题" } });
		fireEvent.keyDown(questionInput(), { key: "Enter", isComposing: true });
		fireEvent.keyDown(questionInput(), { key: "Enter", shiftKey: true });
		expect(fetchImpl).not.toHaveBeenCalled();
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(current(store).request).toBeDefined());
		fireEvent.click(screen.getByRole("button", { name: "停止" }));
		await reply("迟到的回答");
		expect(current(store).messages.at(-1)?.status).toBe("aborted");
		expect(screen.queryByText("迟到的回答")).toBeNull();
		expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
	});

	it("retries an error without duplicating the question or mixing it into another draft", async () => {
		const { store, fetchImpl } = setup();
		fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: "provider unavailable" }), { status: 400 }));
		render(panel(store));
		fireEvent.change(questionInput(), { target: { value: "原问题" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await screen.findByRole("alert");
		fireEvent.change(questionInput(), { target: { value: "下一条草稿" } });
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		await waitFor(() => expect(postBodies(fetchImpl)).toHaveLength(2));
		expect(current(store).messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect((questionInput() as HTMLTextAreaElement).value).toBe("下一条草稿");
	});

	it("reconstructs incremental answers and accepts a corrected final answer without repeated text", async () => {
		const { store, fetchImpl } = setup();
		let requestId = "";
		let poll = 0;
		fetchImpl.mockImplementation(async (_url, init) => {
			if (init?.method === "POST") { requestId = JSON.parse(String(init.body)).requestId; return response(initial(requestId)); }
			poll += 1;
			if (poll === 1) return response({ ...initial(requestId), revision: 1, text: "第一句", textOffset: 0 });
			if (poll === 2) { expect(current(store).messages.at(-1)?.text).toBe("第一句"); return response({ ...initial(requestId), revision: 2, text: ",第二句", textOffset: 3 }); }
			expect(current(store).messages.at(-1)?.text).toBe("第一句,第二句");
			return response({ ...initial(requestId), revision: 3, text: "最终完整回答", textOffset: 0, done: true });
		});
		render(panel(store));
		fireEvent.change(questionInput(), { target: { value: "解释一下" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await screen.findByText("最终完整回答");
		expect(current(store).messages.at(-1)?.text).toBe("最终完整回答");
	});

	it("shows a storage failure while keeping the questions usable", async () => {
		const { fetchImpl } = setup();
		const store = new SideChatStore({ fetch: fetchImpl, storage: () => ({ getItem: () => null, setItem: () => { throw new Error("quota"); } }) as unknown as Storage, id: () => crypto.randomUUID() });
		render(panel(store));
		act(() => store.setDraft("main-session-a", "保留的问题"));
		act(() => store.createThread("main-session-a"));
		expect(screen.getByRole("alert").textContent).toContain("浏览器未能保存");
		expect(store.get("main-session-a").threads[0].draft).toBe("保留的问题");
	});
});