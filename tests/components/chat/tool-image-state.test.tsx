// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePiWeb } from "@/hooks/usePiWeb";
import type { WebMessage } from "@/lib/types";

class EventSourceFixture {
	static instances: EventSourceFixture[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) { EventSourceFixture.instances.push(this); }
	close() {}
	emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const image = { type: "image" as const, data: "", mimeType: "image/png", url: "/api/sessions/s/images?entry=result&part=1" };
const call: WebMessage = { role: "assistant", id: "call", stopReason: "toolUse", content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "picture.png" } }] };
const result: WebMessage = { role: "toolResult", id: "result", content: [{ type: "toolResult", toolCallId: "read", text: "Read image file", isError: false }, image] };
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
let older: WebMessage[] = [];
beforeEach(() => {
	localStorage.clear();
	older = [];
	EventSourceFixture.instances = [];
	vi.stubGlobal("EventSource", EventSourceFixture);
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/history?")) return response({ messages: older, total: 3 });
		if (url.startsWith("/api/models")) return response({ providers: [], models: [] });
		return response(url === "/api/sessions" ? { sessions: [], running: {}, workspaceRegistry: { workspaces: [], removedWorkspaces: [], aliases: {}, archivedSessions: [] } } : {});
	}));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

async function open(messages: WebMessage[], streaming = false, omitted = 0) {
	const hook = renderHook(() => usePiWeb());
	act(() => hook.result.current.openSession("/session-images.jsonl"));
	await waitFor(() => expect(EventSourceFixture.instances).toHaveLength(1));
	const stream = EventSourceFixture.instances[0];
	await act(async () => stream.emit({ type: "snapshot", snapshot: { messages, trajectory: [], sessionPath: "/session-images.jsonl", isStreaming: streaming, history: { total: messages.length + omitted, omitted } } }));
	return { hook, stream };
}

describe("tool image snapshot and history restoration", () => {
	it("restores image URLs and completion state from a reconnect snapshot", async () => {
		const { hook, stream } = await open([call, result]);
		expect(hook.result.current.state.tools.read).toMatchObject({ state: "done", args: { path: "picture.png" }, images: [image], result: "Read image file" });
		await act(async () => stream.emit({ type: "snapshot", snapshot: { messages: [call, result], trajectory: [], isStreaming: false } }));
		expect(hook.result.current.state.tools.read.images).toEqual([image]);
	});

	it("does not mark an unresolved image read as complete in a streaming snapshot", async () => {
		const pending: WebMessage = { ...call, id: "pending", content: [{ type: "toolCall", id: "pending-read", name: "read", arguments: { path: "pending.png" } }] };
		const { hook } = await open([call, result, pending], true);
		expect(hook.result.current.state.tools.read.state).toBe("done");
		expect(hook.result.current.state.tools.read.images).toEqual([image]);
		expect(hook.result.current.state.tools["pending-read"]).toMatchObject({ state: "running" });
		expect(hook.result.current.state.tools["pending-read"].images).toBeUndefined();
	});

	it("joins a read and its image result across history pages while preserving current live tool state", async () => {
		const current: WebMessage = { ...call, id: "current", content: [{ type: "toolCall", id: "current-read", name: "read", arguments: { path: "current.png" } }] };
		const { hook } = await open([result, current], true, 1);
		const live = hook.result.current.state.tools["current-read"];
		expect(hook.result.current.state.tools.read).toBeUndefined();
		older = [call];
		await act(async () => { await hook.result.current.loadEarlierMessages(); });
		expect(hook.result.current.state.messages.map((message) => message.id)).toEqual(["call", "result", "current"]);
		expect(hook.result.current.state.tools.read).toMatchObject({ state: "done", images: [image] });
		expect(hook.result.current.state.tools["current-read"]).toBe(live);
	});
});
