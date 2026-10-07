// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePiWeb } from "../src/hooks/usePiWeb";

/** 只记录连接与推送的假 EventSource */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	closed = false;
	constructor(public url: string) { FakeEventSource.instances.push(this); }
	close() { this.closed = true; }
	push(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

const snapshot = (text: string) => ({
	seq: 1, sessionPath: "/w/s.jsonl", cwd: "/w", name: "", messages: [{ role: "user", id: "u1", content: [{ type: "text", text }] }],
	isStreaming: false, toolPreset: "standard", queue: { steering: [], followUp: [] }, trajectory: [], tools: { active: [], all: [] },
});

afterEach(() => { vi.unstubAllGlobals(); FakeEventSource.instances = []; });

describe("history rewrites reach every open view", () => {
	it("reconnects for a fresh snapshot on a history event without flashing disconnected", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({ success: false }) })));
		const { result } = renderHook(() => usePiWeb());
		act(() => result.current.openSession("/w/s.jsonl"));
		await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
		const first = FakeEventSource.instances[0];
		act(() => { first.onopen?.(); first.push({ type: "snapshot", snapshot: snapshot("before") }); });
		await waitFor(() => expect(result.current.state.messages).toHaveLength(1));

		const seen: boolean[] = [];
		act(() => first.push({ type: "history", ts: 2 }));
		seen.push(result.current.state.connected);
		// 旧连接上迟到的帧（旧视图的增量）不能叠到界面上
		act(() => first.push({ type: "message", phase: "start", message: { role: "user", id: "stale", content: [{ type: "text", text: "stale" }] }, ts: 3 }));
		expect(result.current.state.messages).toHaveLength(1);
		await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
		seen.push(result.current.state.connected);
		expect(first.closed).toBe(true);
		expect(seen).toEqual([true, true]);
		act(() => FakeEventSource.instances[1].push({ type: "snapshot", snapshot: snapshot("after") }));
		await waitFor(() => expect(result.current.state.messages[0].content).toEqual([{ type: "text", text: "after" }]));
	});
});
