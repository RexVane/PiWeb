// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePiWeb } from "@/hooks/usePiWeb";

class EventSourceFixture {
	static instances: EventSourceFixture[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) { EventSourceFixture.instances.push(this); }
	close() {}
	emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const pending: { url: string; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
const catalog = (name: string) => ({ providers: [{ id: name }], models: [{ provider: name, id: "probe", name }] });

beforeEach(() => {
	localStorage.clear();
	pending.length = 0;
	EventSourceFixture.instances = [];
	vi.stubGlobal("EventSource", EventSourceFixture);
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("/api/models")) return new Promise<Response>((resolve) => pending.push({ url, signal: init?.signal as AbortSignal, resolve }));
		return response(url === "/api/sessions" ? { sessions: [], running: {}, workspaceRegistry: { workspaces: [], removedWorkspaces: [], aliases: {}, archivedSessions: [] } } : {});
	}));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it("reports a catalog refresh failure while retaining the last valid choices", async () => {
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(pending).toHaveLength(1));
	await act(async () => pending[0].resolve(response(catalog("valid"))));
	let refresh!: ReturnType<ReturnType<typeof usePiWeb>["refreshModels"]>;
	act(() => { refresh = hook.result.current.refreshModels(); });
	await waitFor(() => expect(pending).toHaveLength(2));
	await act(async () => pending[1].resolve(new Response(JSON.stringify({ success: false, error: "catalog unavailable" }), { status: 503 })));
	expect(await refresh).toEqual({ success: false, error: "catalog unavailable" });
	expect(hook.result.current.models?.models[0].provider).toBe("valid");
	expect(hook.result.current.state.error).toBe("catalog unavailable");
});

it("requests the active session's catalog and ignores slower responses from previous sessions", async () => {
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(pending).toHaveLength(1));
	act(() => hook.result.current.openSession("/a.jsonl"));
	await waitFor(() => expect(pending).toHaveLength(2));
	expect(pending[0].signal.aborted).toBe(true);
	const firstId = hook.result.current.currentId;
	expect(pending[1].url).toBe(`/api/models?session=${encodeURIComponent(firstId!)}`);
	act(() => hook.result.current.openSession("/b.jsonl"));
	await waitFor(() => expect(pending).toHaveLength(3));
	expect(pending[1].signal.aborted).toBe(true);
	expect(hook.result.current.models).toBeNull();
	expect(pending[2].url).toBe(`/api/models?session=${encodeURIComponent(hook.result.current.currentId!)}`);
	await act(async () => pending[2].resolve(response(catalog("b"))));
	expect(hook.result.current.models?.models[0].provider).toBe("b");
	await act(async () => { pending[1].resolve(response(catalog("a"))); pending[0].resolve(response(catalog("global"))); });
	expect(hook.result.current.models?.models[0].provider).toBe("b");
	await act(async () => EventSourceFixture.instances.at(-1)!.emit({ type: "resources", ts: Date.now() }));
	await waitFor(() => expect(pending).toHaveLength(4));
	await act(async () => pending[3].resolve(response(catalog("b-reloaded"))));
	expect(hook.result.current.models?.models[0].provider).toBe("b-reloaded");
});

it("joins the pending selection catalog for snapshots but replaces it for resource changes", async () => {
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(pending).toHaveLength(1));
	await act(async () => pending[0].resolve(response(catalog("global"))));
	act(() => hook.result.current.openSession("/a.jsonl"));
	await waitFor(() => expect(pending).toHaveLength(2));
	const stream = EventSourceFixture.instances.at(-1)!;
	const snapshot = { messages: [], trajectory: [], sessionPath: "/a.jsonl", toolPreset: "workspace", toolPreferenceSaved: true, isStreaming: false };
	await act(async () => stream.emit({ type: "snapshot", snapshot }));
	expect(pending).toHaveLength(2);
	expect(pending[1].signal.aborted).toBe(false);
	await act(async () => stream.emit({ type: "resources", ts: Date.now() }));
	expect(pending).toHaveLength(3);
	expect(pending[1].signal.aborted).toBe(true);
	// An obsolete completion must neither publish its catalog nor release the
	// replacement's in-flight identity when another snapshot joins it.
	await act(async () => pending[1].resolve(response(catalog("obsolete"))));
	await act(async () => stream.emit({ type: "snapshot", snapshot }));
	expect(pending).toHaveLength(3);
	expect(pending[2].signal.aborted).toBe(false);
	await act(async () => pending[2].resolve(response(catalog("updated"))));
	expect(hook.result.current.models?.models[0].provider).toBe("updated");
});

it("forces an explicit refresh after saving instead of reusing an older catalog request", async () => {
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(pending).toHaveLength(1));
	let refreshed!: ReturnType<ReturnType<typeof usePiWeb>["refreshModels"]>;
	act(() => { refreshed = hook.result.current.refreshModels(); });
	expect(pending).toHaveLength(2);
	expect(pending[0].signal.aborted).toBe(true);
	await act(async () => pending[1].resolve(response(catalog("saved"))));
	expect(await refreshed).toEqual({ success: true });
	await act(async () => pending[0].resolve(new Response(JSON.stringify({ success: false, error: "old failure" }), { status: 503 })));
	expect(hook.result.current.models?.models[0].provider).toBe("saved");
	expect(hook.result.current.state.error).toBeNull();
});

it("cancels a previous workspace catalog and the active request on unmount", async () => {
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(pending).toHaveLength(1));
	act(() => hook.result.current.setModelCwd("/workspace-b"));
	expect(pending).toHaveLength(2);
	expect(pending[0].signal.aborted).toBe(true);
	expect(pending[1].url).toBe("/api/models?cwd=%2Fworkspace-b");
	hook.unmount();
	expect(pending[1].signal.aborted).toBe(true);
	await act(async () => { pending[0].resolve(response(catalog("global"))); pending[1].resolve(response(catalog("b"))); });
});
