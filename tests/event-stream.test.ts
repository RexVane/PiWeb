/**
 * 快速隧道下的长轮询：解析 SSE 文本、带 Last-Event-ID 续取、失败退避后恢复、关掉就停。
 */
import { describe, expect, it, vi } from "vitest";
import { parseSseText, pollEventStream, usesEventPolling } from "../src/lib/chat/event-stream";

describe("usesEventPolling", () => {
	it("只有 Cloudflare 快速隧道走轮询", () => {
		expect(usesEventPolling("pts-toys-gpl-spaces.trycloudflare.com")).toBe(true);
		expect(usesEventPolling("PTS-Toys.TryCloudflare.com")).toBe(true);
		expect(usesEventPolling("127.0.0.1")).toBe(false);
		expect(usesEventPolling("192.168.1.8")).toBe(false);
		expect(usesEventPolling("piweb.example.com")).toBe(false);
		expect(usesEventPolling("trycloudflare.com.evil.example")).toBe(false);
	});
});

describe("parseSseText", () => {
	it("按空行切帧，取 id / event / data，跳过注释与 retry", () => {
		const text = "retry: 2000\n\n: ping\n\nid: e1.1\ndata: {\"a\":1}\n\nevent: part\ndata: x\ndata: y\n\nid: e1.2\ndata:{\"b\":2}\n\n";
		expect(parseSseText(text)).toEqual([
			{ id: "e1.1", data: "{\"a\":1}" },
			{ event: "part", data: "x\ny" },
			{ id: "e1.2", data: "{\"b\":2}" },
		]);
	});

	it("CRLF 与没有结尾空行的最后一帧也认", () => {
		expect(parseSseText("id: 7\r\ndata: one\r\n\r\ndata: two")).toEqual([{ id: "7", data: "one" }, { data: "two" }]);
		expect(parseSseText("")).toEqual([]);
	});
});

type Reply = string | Error | { status: number };

/** 按顺序回放预设响应；用完后挂起，直到被 abort */
function scriptedFetch(replies: Reply[]) {
	const calls: { url: string; lastEventId: string | undefined }[] = [];
	const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
		const headers = (init.headers ?? {}) as Record<string, string>;
		calls.push({ url, lastEventId: headers["Last-Event-ID"] });
		const reply = replies.shift();
		if (reply === undefined) {
			return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
		}
		if (reply instanceof Error) throw reply;
		if (typeof reply === "object") return new Response("nope", { status: reply.status });
		return new Response(reply, { status: 200 });
	});
	return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pollEventStream", () => {
	it("一批接一批地取，下一次带上最后收到的事件 id", async () => {
		const { fetchImpl, calls } = scriptedFetch([
			"id: e1.3\ndata: {\"type\":\"snapshot\"}\n\n",
			"",
			"id: e1.4\ndata: {\"n\":4}\n\nid: e1.5\ndata: {\"n\":5}\n\n",
		]);
		const handlers = { onOpen: vi.fn(), onMessage: vi.fn(), onError: vi.fn() };
		const stream = pollEventStream("/api/agent/abc/events", handlers, { fetch: fetchImpl });
		for (let i = 0; i < 10 && calls.length < 4; i++) await flush();
		stream.close();

		expect(calls.map((call) => call.url)).toEqual(Array(4).fill("/api/agent/abc/events?poll=1"));
		expect(calls.map((call) => call.lastEventId)).toEqual([undefined, "e1.3", "e1.3", "e1.5"]);
		expect(handlers.onMessage.mock.calls.map(([data]) => data)).toEqual(["{\"type\":\"snapshot\"}", "{\"n\":4}", "{\"n\":5}"]);
		expect(handlers.onOpen).toHaveBeenCalledTimes(1);
		expect(handlers.onError).not.toHaveBeenCalled();
	});

	it("失败（断网、非 200）报错并退避重试，恢复后再报一次 onOpen，续传 id 不丢", async () => {
		const { fetchImpl, calls } = scriptedFetch([
			"id: e1.1\ndata: {}\n\n",
			new TypeError("Failed to fetch"),
			{ status: 502 },
			"id: e1.2\ndata: {}\n\n",
		]);
		const backoffMs = vi.fn((_failures: number) => 0);
		const handlers = { onOpen: vi.fn(), onMessage: vi.fn(), onError: vi.fn() };
		const stream = pollEventStream("/api/agent/abc/events", handlers, { fetch: fetchImpl, backoffMs });
		for (let i = 0; i < 20 && calls.length < 5; i++) await flush();
		stream.close();

		expect(handlers.onError).toHaveBeenCalledTimes(2);
		expect(backoffMs.mock.calls.map(([failures]) => failures)).toEqual([1, 2]);
		expect(handlers.onOpen).toHaveBeenCalledTimes(2);
		expect(calls.map((call) => call.lastEventId)).toEqual([undefined, "e1.1", "e1.1", "e1.1", "e1.2"]);
	});

	it("关掉后中止进行中的请求，不再回调", async () => {
		const { fetchImpl, calls } = scriptedFetch([]);
		const handlers = { onOpen: vi.fn(), onMessage: vi.fn(), onError: vi.fn() };
		const stream = pollEventStream("/api/agent/abc/events", handlers, { fetch: fetchImpl });
		await flush();
		stream.close();
		for (let i = 0; i < 5; i++) await flush();
		expect(calls).toHaveLength(1);
		expect(handlers.onError).not.toHaveBeenCalled();
		expect(handlers.onOpen).not.toHaveBeenCalled();
	});
});
