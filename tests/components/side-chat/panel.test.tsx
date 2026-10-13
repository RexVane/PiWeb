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
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("persistent, simple side-chat panel", () => {
	it("keeps the main reading position and messages while sending several independent questions", async () => {
		const { store, reply, fetchImpl } = setup();
		const messages: WebMessage[] = [
			{ role: "user", id: "main-user", content: [{ type: "text", text: "主线问题" }] },
			{ role: "assistant", id: "main-answer", content: [{ type: "text", text: "原回答后面还没有读完" }], stopReason: "stop" },
		];
		render(<><ChatWindow messages={messages} tools={{}} /><SideChatPanel sessionId="main-session-a" store={store} onClose={() => {}} /></>);
		await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const mainLog = screen.getAllByRole("log").find((node) => node.getAttribute("aria-label") !== "旁聊消息")!;
		Object.defineProperty(mainLog, "scrollHeight", { configurable: true, value: 4000 });
		Object.defineProperty(mainLog, "clientHeight", { configurable: true, value: 500 });
		mainLog.scrollTop = 3500;
		fireEvent.scroll(mainLog);
		mainLog.scrollTop = 1234;
		fireEvent.scroll(mainLog);
		fireEvent.change(questionInput(), { target: { value: "Session 怎么复用？" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(current(store).request).toBeDefined());
		await reply("同一份文件。");
		fireEvent.change(questionInput(), { target: { value: "Model 呢？" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2));
		await reply("同一份配置。");
		expect(mainLog.scrollTop).toBe(1234);
		expect(mainLog.textContent).toContain("原回答后面还没有读完");
		expect(mainLog.textContent).not.toContain("Session 怎么复用");
		const posts = fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST");
		expect(posts).toHaveLength(2);
		expect(JSON.parse(String(posts[1][1]!.body)).history).toEqual([{ role: "user", text: "Session 怎么复用？" }, { role: "assistant", text: "同一份文件。" }]);
		expect(fetchImpl.mock.calls.every(([url]) => String(url).includes("/side-chat"))).toBe(true);
		const panel = within(screen.getByTestId("side-chat-panel"));
		expect(panel.queryByText(/token|缓存命中|工具调用|首 token|耗时/)).toBeNull();
	});

	it("finishes an answer while the panel is closed and keeps it on reopen and browser restoration", async () => {
		const { store, reply, fetchImpl } = setup();
		const view = render(<SideChatPanel sessionId="main-session-a" store={store} onClose={() => {}} />);
		fireEvent.change(questionInput(), { target: { value: "解释复用" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
		view.unmount();
		await reply("独立回答仍然完成。");
		render(<SideChatPanel sessionId="main-session-a" store={store} onClose={() => {}} />);
		expect(screen.getByText("独立回答仍然完成。")).toBeTruthy();
		const restored = new SideChatStore({ fetch: fetchImpl, storage: () => localStorage, id: () => "restored-id" });
		expect(current(restored).messages.map((message) => message.text)).toEqual(["解释复用", "独立回答仍然完成。"]);
	});

	it("keeps drafts and late answers with their source conversation, and preserves earlier side-chat threads", async () => {
		const { store, reply } = setup();
		const view = render(<SideChatPanel sessionId="main-session-a" store={store} onClose={() => {}} />);
		fireEvent.change(questionInput(), { target: { value: "A 的问题" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await waitFor(() => expect(current(store).request).toBeDefined());
		view.rerender(<SideChatPanel sessionId="main-session-b" store={store} onClose={() => {}} />);
		fireEvent.change(questionInput(), { target: { value: "B 的草稿" } });
		await reply("这是 A 的回答。");
		expect((questionInput() as HTMLTextAreaElement).value).toBe("B 的草稿");
		expect(screen.queryByText("这是 A 的回答。")).toBeNull();
		view.rerender(<SideChatPanel sessionId="main-session-a" store={store} onClose={() => {}} />);
		const original = current(store).id;
		expect(screen.getByText("这是 A 的回答。")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "新旁聊" }));
		expect(current(store).messages).toEqual([]);
		expect(store.get("main-session-a").threads).toHaveLength(2);
		fireEvent.change(screen.getByRole("combobox", { name: "旁聊记录" }), { target: { value: original } });
		expect(screen.getByText("这是 A 的回答。")).toBeTruthy();
	});

	it("stops a pending request, ignores a late answer, and allows Chinese composition and multiline input", async () => {
		const { store, reply, fetchImpl } = setup();
		render(<SideChatPanel sessionId="main-session-a" store={store} onClose={() => {}} />);
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
		render(<SideChatPanel sessionId="main-session-a" store={store} onClose={() => {}} />);
		fireEvent.change(questionInput(), { target: { value: "原问题" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await screen.findByRole("alert");
		fireEvent.change(questionInput(), { target: { value: "下一条草稿" } });
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		await waitFor(() => expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2));
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
			if (poll === 2) { expect(current(store).messages.at(-1)?.text).toBe("第一句"); return response({ ...initial(requestId), revision: 2, text: "，第二句", textOffset: 3 }); }
			expect(current(store).messages.at(-1)?.text).toBe("第一句，第二句");
			return response({ ...initial(requestId), revision: 3, text: "最终完整回答", textOffset: 0, done: true });
		});
		render(<SideChatPanel sessionId="main-session-a" store={store} onClose={() => {}} />);
		fireEvent.change(questionInput(), { target: { value: "解释一下" } });
		fireEvent.keyDown(questionInput(), { key: "Enter" });
		await screen.findByText("最终完整回答");
		expect(current(store).messages.at(-1)?.text).toBe("最终完整回答");
	});

	it("shows a storage failure while keeping the questions usable", async () => {
		const { fetchImpl } = setup();
		const store = new SideChatStore({ fetch: fetchImpl, storage: () => ({ getItem: () => null, setItem: () => { throw new Error("quota"); } }) as unknown as Storage, id: () => crypto.randomUUID() });
		render(<SideChatPanel sessionId="main-session-a" store={store} onClose={() => {}} />);
		act(() => store.setDraft("main-session-a", "保留的问题"));
		act(() => store.createThread("main-session-a"));
		expect(screen.getByRole("alert").textContent).toContain("浏览器未能保存");
		expect(store.get("main-session-a").threads[0].draft).toBe("保留的问题");
	});
});
