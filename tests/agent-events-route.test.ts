/**
 * 会话事件接口：SSE 照旧常开；`?poll=1`（快速隧道）发完一批就结束响应，空闲时挂着等，
 * 结束后给两次请求之间的空档留「有人在看」的宽限。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Send = (seq: number, json: string) => void;

const manager = vi.hoisted(() => {
	const state = { seq: 0, buffer: [] as { seq: number; json: string }[], subscribers: new Set<Send>() };
	return {
		state,
		publish(json: string) {
			state.seq += 1;
			state.buffer.push({ seq: state.seq, json });
			for (const send of state.subscribers) send(state.seq, json);
		},
		getManaged: () => state,
		parseLastEventId: (_m: unknown, raw: string | null) => {
			const match = /^ep\.(\d+)$/.exec(raw ?? "");
			return match ? Number(match[1]) : undefined;
		},
		sseEventId: (_m: unknown, seq: number) => `ep.${seq}`,
		buildSnapshot: async () => ({ seq: state.seq, messages: [] }),
		subscribe: (_m: unknown, send: Send, last: number) => {
			if (last > state.seq) return false;
			state.subscribers.add(send);
			for (const frame of state.buffer.filter((b) => b.seq > last)) send(frame.seq, frame.json);
			return true;
		},
		unsubscribe: (_m: unknown, send: Send) => { state.subscribers.delete(send); },
		holdViewer: vi.fn(),
	};
});

vi.mock("../src/lib/agent-manager", () => manager);
vi.mock("../src/lib/path-security", () => ({
	BoundaryError: class BoundaryError extends Error {},
	resolveSessionPath: async (id: string) => `/sessions/${id}.jsonl`,
}));

import { GET } from "../src/app/api/agent/[id]/events/route";

function open(query = "", lastEventId?: string) {
	const headers: Record<string, string> = lastEventId ? { "last-event-id": lastEventId } : {};
	return GET(new Request(`http://127.0.0.1/api/agent/abc/events${query}`, { headers }), { params: Promise.resolve({ id: "abc" }) });
}

/** 把响应体读成文本，同时报告流有没有结束 */
function collect(response: Response) {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const result = { text: "", done: false };
	void (async () => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) { result.done = true; return; }
			result.text += decoder.decode(value);
		}
	})();
	return { result, cancel: () => reader.cancel() };
}

beforeEach(() => {
	vi.useFakeTimers();
	manager.state.seq = 0;
	manager.state.buffer = [];
	manager.state.subscribers.clear();
	manager.holdViewer.mockClear();
});

afterEach(() => vi.useRealTimers());

describe("SSE（局域网 / 本机）", () => {
	it("事件流常开，先快照后增量", async () => {
		const response = await open();
		expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
		const { result, cancel } = collect(response);
		await vi.advanceTimersByTimeAsync(10);
		manager.publish("{\"type\":\"agent_start\"}");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(result.text).toContain("retry: 2000");
		expect(result.text).toContain("id: ep.0\ndata: {\"type\":\"snapshot\"");
		expect(result.text).toContain("id: ep.1\ndata: {\"type\":\"agent_start\"}");
		expect(result.done).toBe(false);
		await cancel();
		expect(manager.state.subscribers.size).toBe(0);
		expect(manager.holdViewer).not.toHaveBeenCalled();
	});
});

describe("长轮询（?poll=1，快速隧道）", () => {
	it("首次请求发完快照就结束，不发 retry / 心跳；结束后留看客宽限", async () => {
		const response = await open("?poll=1");
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		// 不带 no-transform，隧道边缘才会压缩轮询响应
		expect(response.headers.get("cache-control")).toBe("no-cache");
		const { result } = collect(response);
		await vi.advanceTimersByTimeAsync(100);
		expect(result.done).toBe(true);
		expect(result.text.startsWith("id: ep.0\ndata: {\"type\":\"snapshot\"")).toBe(true);
		expect(result.text).not.toContain("retry:");
		expect(manager.state.subscribers.size).toBe(0);
		expect(manager.holdViewer).toHaveBeenCalledWith(manager.state, 30_000);
	});

	it("续传时没有新事件就挂着；来了事件再凑 50ms 一批后结束", async () => {
		const response = await open("?poll=1", "ep.0");
		const { result } = collect(response);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(result.done).toBe(false);
		expect(result.text).toBe("");

		manager.publish("{\"n\":1}");
		await vi.advanceTimersByTimeAsync(20);
		manager.publish("{\"n\":2}");
		await vi.advanceTimersByTimeAsync(40);
		manager.publish("{\"n\":3}");
		await vi.advanceTimersByTimeAsync(10);
		expect(result.done).toBe(true);
		expect(result.text).toBe("id: ep.1\ndata: {\"n\":1}\n\nid: ep.2\ndata: {\"n\":2}\n\n");
		// 第三条落在下一批：下一次请求带着 ep.2 从缓冲续放
		const next = collect(await open("?poll=1", "ep.2"));
		await vi.advanceTimersByTimeAsync(100);
		expect(next.result.text).toBe("id: ep.3\ndata: {\"n\":3}\n\n");
		expect(next.result.done).toBe(true);
	});

	it("一直没有事件，25 秒后空着结束，浏览器马上再来", async () => {
		const { result } = collect(await open("?poll=1", "ep.0"));
		await vi.advanceTimersByTimeAsync(24_999);
		expect(result.done).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		expect(result.done).toBe(true);
		expect(result.text).toBe("");
		expect(manager.state.subscribers.size).toBe(0);
	});
});
