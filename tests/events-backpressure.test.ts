/**
 * L7：SSE 背压。慢客户端不在读时，服务端 ReadableStream 队列按字节计量；
 * 积压达到 `PIWEB_SSE_MAX_BUFFERED_BYTES`（默认 4MiB）就主动断开该连接，
 * 不能无限 enqueue。快客户端/正常事件量不受影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Managed } from "../src/lib/agent-manager";

type Send = (seq: number, json: string) => void;

const manager = vi.hoisted(() => {
	const state = { epoch: "ep", seq: 0, buffer: [] as { seq: number; json: string }[], subscribers: new Set<Send>(), lastActive: 0, viewerGraceUntil: 0, ui: null };
	return {
		state,
		publish(json: string) {
			state.seq += 1;
			state.buffer.push({ seq: state.seq, json });
			for (const send of state.subscribers) send(state.seq, json);
		},
		getManaged: () => state,
		buildSnapshot: vi.fn(async () => ({ seq: state.seq, messages: [] })),
		holdViewer: vi.fn(),
	};
});

vi.mock("../src/lib/agent-manager", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/lib/agent-manager")>();
	manager.holdViewer.mockImplementation(real.holdViewer);
	return { ...real, getManaged: () => manager.state as Managed, buildSnapshot: manager.buildSnapshot, holdViewer: manager.holdViewer };
});
vi.mock("../src/lib/path-security", () => ({
	BoundaryError: class BoundaryError extends Error {},
	resolveSessionPath: async (id: string) => `/sessions/${id}.jsonl`,
}));

import { GET } from "../src/app/api/agent/[id]/events/route";

function open() {
	return GET(new Request("http://127.0.0.1/api/agent/abc/events"), { params: Promise.resolve({ id: "abc" }) });
}

/** 像浏览器一样持续读走帧，报告读到的文本。 */
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
	manager.state.lastActive = 0;
	manager.state.viewerGraceUntil = 0;
	manager.buildSnapshot.mockReset();
	manager.buildSnapshot.mockImplementation(async () => ({ seq: manager.state.seq, messages: [] }));
	delete process.env.PIWEB_SSE_MAX_BUFFERED_BYTES;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	delete process.env.PIWEB_SSE_MAX_BUFFERED_BYTES;
});

describe("SSE 慢客户端背压", () => {
	it("closes a connection whose unread backlog exceeds the configured byte limit", async () => {
		process.env.PIWEB_SSE_MAX_BUFFERED_BYTES = "256";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		// 不读响应体：模拟停止消费的客户端。
		await open();
		await vi.advanceTimersByTimeAsync(10);
		expect(manager.state.subscribers.size).toBe(1);
		manager.publish(JSON.stringify({ type: "agent_message", text: "x".repeat(4096) }));
		await vi.advanceTimersByTimeAsync(10);
		expect(manager.state.subscribers.size).toBe(0);
		expect(warn.mock.calls.some(([message]) => String(message).includes("SSE"))).toBe(true);
	});

	it("falls back to the 4MiB default for invalid or missing configuration", async () => {
		process.env.PIWEB_SSE_MAX_BUFFERED_BYTES = "not-a-number";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await open();
		await vi.advanceTimersByTimeAsync(10);
		manager.publish(JSON.stringify({ type: "agent_message", text: "x".repeat(4096) }));
		await vi.advanceTimersByTimeAsync(10);
		// 4KiB 远小于默认 4MiB：连接保持，订阅还在。
		expect(manager.state.subscribers.size).toBe(1);
		expect(warn.mock.calls.some(([message]) => String(message).includes("SSE"))).toBe(false);
	});

	it("keeps a fast client connected while events stream through", async () => {
		const { result, cancel } = collect(await open());
		await vi.advanceTimersByTimeAsync(10);
		for (let index = 0; index < 20; index += 1) {
			manager.publish(JSON.stringify({ type: "agent_message", text: "y".repeat(1024) }));
			await vi.advanceTimersByTimeAsync(1);
		}
		await vi.advanceTimersByTimeAsync(10);
		expect(manager.state.subscribers.size).toBe(1);
		expect(result.text).toContain("agent_message");
		await cancel();
		expect(manager.state.subscribers.size).toBe(0);
	});
});
