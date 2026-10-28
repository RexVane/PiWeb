// @vitest-environment jsdom
/** Exercise the real hook across browser state and authoritative server snapshots. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePiWeb } from "@/hooks/usePiWeb";
import type { ToolPreset, WebSnapshot } from "@/lib/types";

class EventSourceFixture {
	static instances: EventSourceFixture[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) { EventSourceFixture.instances.push(this); }
	close() {}
	emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } });
const commands: { path: string; cmd: string; preset?: ToolPreset }[] = [];
const serverPreferences = new Map<string, { toolPreset: ToolPreset; toolPreferenceSaved: boolean; customActiveTools?: string[] | null }>();

beforeEach(() => {
	localStorage.clear();
	commands.length = 0;
	serverPreferences.clear();
	EventSourceFixture.instances = [];
	vi.stubGlobal("EventSource", EventSourceFixture);
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const agent = /^\/api\/agent\/([^/]+)$/.exec(url);
		if (init?.method === "POST" && agent) {
			const target = atob(decodeURIComponent(agent[1]).replace(/-/g, "+").replace(/_/g, "/"));
			const command = JSON.parse(String(init.body));
			commands.push({ path: target, ...command });
			if (command.cmd === "setToolPreset") serverPreferences.set(target, { toolPreset: command.preset, toolPreferenceSaved: true, customActiveTools: null });
			return response({});
		}
		return response(url === "/api/sessions" ? { sessions: [], running: {}, workspaceRegistry: { workspaces: [], removedWorkspaces: [], aliases: {}, archivedSessions: [] } }
			: url === "/api/models" ? { models: [], providers: [] } : {});
	}));
});

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const snapshot = (extra: Partial<WebSnapshot> = {}) => ({
	cwd: "/workspace", messages: [], trajectory: [], userTurns: [], toolPreset: "standard",
	tools: { active: ["read"], all: [{ name: "read" }, { name: "bash" }] },
	queue: { steering: [], followUp: [] }, isStreaming: false, contextUsage: null,
	...extra,
} as WebSnapshot);

async function open(hook: ReturnType<typeof renderHook<ReturnType<typeof usePiWeb>, unknown>>, sessionPath: string, snap: WebSnapshot) {
	const count = EventSourceFixture.instances.length;
	act(() => hook.result.current.openSession(sessionPath));
	await waitFor(() => expect(EventSourceFixture.instances).toHaveLength(count + 1));
	const stream = EventSourceFixture.instances.at(-1)!;
	await act(async () => stream.emit({ type: "snapshot", snapshot: snap }));
	return stream;
}

it("pins an explicit matching legacy preset before another browser can replace it", async () => {
	localStorage.setItem("piweb.toolPreset", "standard");
	const first = renderHook(() => usePiWeb());
	await open(first, "/old.jsonl", snapshot({ toolPreferenceSaved: false }));
	await waitFor(() => expect(serverPreferences.get("/old.jsonl")).toEqual({ toolPreset: "standard", toolPreferenceSaved: true, customActiveTools: null }));
	expect(commands).toEqual([{ path: "/old.jsonl", cmd: "setToolPreset", preset: "standard" }]);
	first.unmount();
	// A different browser has an older Full access default, but this session is already migrated.
	localStorage.clear();
	localStorage.setItem("piweb.toolPreset", "full");
	const second = renderHook(() => usePiWeb());
	await open(second, "/old.jsonl", snapshot(serverPreferences.get("/old.jsonl")));
	expect(second.result.current.state.toolPreset).toBe("standard");
	expect(commands).toHaveLength(1);
});

it.each([null, "malformed"])("does not migrate an implicit default when localStorage contains %s", async (stored) => {
	if (stored !== null) localStorage.setItem("piweb.toolPreset", stored);
	const hook = renderHook(() => usePiWeb());
	await open(hook, "/old.jsonl", snapshot({ toolPreset: "readonly", toolPreferenceSaved: false }));
	expect(commands).toEqual([]);
	expect(hook.result.current.state.toolPreset).toBe("readonly");
});

it("keeps each saved session's preset and explicit tool list over the browser default", async () => {
	localStorage.setItem("piweb.toolPreset", "full");
	const hook = renderHook(() => usePiWeb());
	await open(hook, "/a.jsonl", snapshot({ toolPreset: "readonly", toolPreferenceSaved: true }));
	expect(hook.result.current.state.toolPreset).toBe("readonly");
	await open(hook, "/b.jsonl", snapshot({ toolPreset: "standard", toolPreferenceSaved: true, customActiveTools: ["read"] }));
	expect(hook.result.current.state.snapshot?.customActiveTools).toEqual(["read"]);
	expect(hook.result.current.state.toolPreset).toBe("standard");
	expect(commands).toEqual([]);
});

it("still migrates an explicit different preset against an old server without a saved flag", async () => {
	localStorage.setItem("piweb.toolPreset", "readonly");
	const hook = renderHook(() => usePiWeb());
	await open(hook, "/legacy.jsonl", snapshot());
	await waitFor(() => expect(commands).toEqual([{ path: "/legacy.jsonl", cmd: "setToolPreset", preset: "readonly" }]));
	expect(hook.result.current.state.snapshot?.toolPreferenceSaved).toBe(true);
});

it("waits for the streaming session to become idle before migrating its legacy preset", async () => {
	localStorage.setItem("piweb.toolPreset", "readonly");
	const hook = renderHook(() => usePiWeb());
	const stream = await open(hook, "/busy.jsonl", snapshot({ isStreaming: true, toolPreferenceSaved: false }));
	expect(commands).toEqual([]);
	await act(async () => stream.emit({ type: "status", isStreaming: false, state: "idle", ts: 1 }));
	await waitFor(() => expect(commands).toEqual([{ path: "/busy.jsonl", cmd: "setToolPreset", preset: "readonly" }]));
});
