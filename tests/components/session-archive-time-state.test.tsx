// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePiWeb } from "@/hooks/usePiWeb";

const sessionPath = "/sessions/archive.jsonl";
const oldStart = Date.parse("2026-11-10T06:30:00Z");
const newStart = Date.parse("2026-11-15T06:30:00Z");
const registry = (archivedAt: Record<string, number> = {}) => ({
	workspaces: ["/work"], aliases: {}, archivedSessions: Object.keys(archivedAt), archivedAt, pinnedSessions: [], removedWorkspaces: [],
});
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState({}, "", "/");
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	sessionStorage.clear();
});

it("loads archive starts from sessions and keeps restore/rearchive mutations in sync", async () => {
	let saved = registry({ [sessionPath]: oldStart });
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://localhost").pathname;
		if (url === "/api/workspaces" && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			if (body.action === "forgetSession") saved = registry();
			else if (body.action === "archiveSession") saved = registry({ [sessionPath]: newStart });
			return response(saved);
		}
		return response(url === "/api/sessions" ? { sessions: [], running: {}, nextOffset: null, workspaceRegistry: saved }
			: url === "/api/workspaces" ? saved : { models: [], providers: [] });
	}));
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(hook.result.current.archivedAt).toEqual({ [sessionPath]: oldStart }));
	await act(async () => { await hook.result.current.unarchiveSession(sessionPath); });
	expect(hook.result.current.archivedAt).toEqual({});
	expect(hook.result.current.archivedSessionPaths).toEqual([]);
	await act(async () => { await hook.result.current.archiveSession(sessionPath); });
	expect(hook.result.current.archivedAt).toEqual({ [sessionPath]: newStart });
	expect(hook.result.current.archivedSessionPaths).toEqual([sessionPath]);
});

it("preserves the confirmed archive start when saving a restore fails", async () => {
	const saved = registry({ [sessionPath]: oldStart });
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://localhost").pathname;
		if (url === "/api/workspaces" && init?.method === "POST") return new Response(JSON.stringify({ success: false, error: "restore failed" }), { status: 503 });
		return response(url === "/api/sessions" ? { sessions: [], running: {}, nextOffset: null, workspaceRegistry: saved } : { models: [], providers: [] });
	}));
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(hook.result.current.archivedAt).toEqual({ [sessionPath]: oldStart }));
	await act(async () => { await expect(hook.result.current.unarchiveSession(sessionPath)).rejects.toThrow("restore failed"); });
	expect(hook.result.current.archivedAt).toEqual({ [sessionPath]: oldStart });
	expect(hook.result.current.archivedSessionPaths).toEqual([sessionPath]);
});

it("loads the same archive starts from the workspace fallback when the session listing fails", async () => {
	const saved = registry({ [sessionPath]: oldStart });
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://localhost").pathname;
		if (url === "/api/sessions") return new Response(JSON.stringify({ success: false, error: "session listing unavailable" }), { status: 503 });
		return response(url === "/api/workspaces" ? saved : { models: [], providers: [] });
	}));
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(hook.result.current.archivedAt).toEqual({ [sessionPath]: oldStart }));
	expect(hook.result.current.archivedSessionPaths).toEqual([sessionPath]);
	expect(hook.result.current.sessionListError).toBe("session listing unavailable");
});

it("orders archivedSessions in hook state by most recently archived first", async () => {
	const older = "/sessions/older.jsonl";
	const newer = "/sessions/newer.jsonl";
	const saved = registry({ [older]: oldStart, [newer]: newStart });
	const sessions = [
		{ path: older, name: "older archived", cwd: "/work", firstMessage: "", messageCount: 1, created: "2026-11-01T00:00:00Z", modified: "2026-11-15T00:00:00Z" },
		{ path: newer, name: "newer archived", cwd: "/work", firstMessage: "", messageCount: 1, created: "2026-11-01T00:00:00Z", modified: "2026-11-10T00:00:00Z" },
	];
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://localhost").pathname;
		return response(url === "/api/sessions" ? { sessions, running: {}, nextOffset: null, workspaceRegistry: saved } : { models: [], providers: [] });
	}));
	const hook = renderHook(() => usePiWeb());
	await waitFor(() => expect(hook.result.current.archivedSessions.map((s) => s.path)).toEqual([newer, older]));
});
