// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePiWeb } from "@/hooks/usePiWeb";

const registry = (extra: Record<string, unknown> = {}) => ({ workspaces: ["/ws"], aliases: {}, archivedSessions: [], pinnedSessions: [], removedWorkspaces: [], ...extra });
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState({}, "", "/"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it("keeps a registry recovery warning from the session list visible across retries", async () => {
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/sessions")
		? response({ sessions: [], running: {}, nextOffset: null, workspaceRegistry: registry({ warning: "记录已从备份恢复，请检查置顶和别名。" }) })
		: response({ models: [], providers: [] })));
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(hook.result.current.workspaceRegistryWarning).toBe("记录已从备份恢复，请检查置顶和别名。"));
	act(() => hook.result.current.retrySessionList());
	await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/api/sessions")).length).toBeGreaterThan(1));
	expect(hook.result.current.workspaceRegistryWarning).toBe("记录已从备份恢复，请检查置顶和别名。");
});

it("surfaces the fallback registry read error instead of silently showing an empty sidebar", async () => {
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/sessions")
		? new Response(JSON.stringify({ success: false, error: "session listing unavailable" }), { status: 500 })
		: response(String(input) === "/api/workspaces" ? registry({ error: "原记录无法读取，原文件已保留。" }) : { models: [], providers: [] })));
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(hook.result.current.workspaceRegistryWarning).toBe("原记录无法读取，原文件已保留。"));
	expect(hook.result.current.sessionListError).toBe("session listing unavailable");
});

it("refreshes the persistent warning after a workspace mutation recovers the registry", async () => {
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/workspaces"
		? response(registry({ warning: "损坏记录已备份并恢复。" }))
		: response(String(input).startsWith("/api/sessions") ? { sessions: [], running: {}, nextOffset: null, workspaceRegistry: registry() } : { models: [], providers: [] })));
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(hook.result.current.addedWorkspaces).toEqual(["/ws"]));
	await act(async () => { await hook.result.current.renameWorkspace("/ws", "alias"); });
	expect(hook.result.current.workspaceRegistryWarning).toBe("损坏记录已备份并恢复。");
});
