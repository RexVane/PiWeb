// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePiWeb } from "@/hooks/usePiWeb";

const sessionPath = "/sessions/new.jsonl";
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
const created: Record<string, unknown>[] = [];
const commands: Record<string, unknown>[] = [];
let setupApplied: boolean | undefined;

class EventSourceFixture {
	onopen = null;
	onmessage = null;
	onerror = null;
	close() {}
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState({}, "", "/");
	created.length = 0;
	commands.length = 0;
	setupApplied = true;
	vi.stubGlobal("EventSource", EventSourceFixture);
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://localhost").pathname;
		if (init?.method === "POST" && url === "/api/agent/new") {
			created.push(JSON.parse(String(init.body)));
			return response({ sessionPath, ...(setupApplied === undefined ? {} : { setupApplied }) });
		}
		if (init?.method === "POST" && url.startsWith("/api/agent/")) {
			commands.push(JSON.parse(String(init.body)));
			return response({});
		}
		return response(url === "/api/sessions" ? { sessions: [], running: {}, nextOffset: null }
			: { models: [], providers: [] });
	}));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	sessionStorage.clear();
});

it("applies explicit creation options in one request when setupApplied is true", async () => {
	const hook = renderHook(() => usePiWeb());
	await act(async () => {
		expect(await hook.result.current.newSession("/work", {
			provider: "test-provider", modelId: "test-model", thinking: "low",
		})).toBe(sessionPath);
	});
	expect(created).toEqual([{ cwd: "/work", provider: "test-provider", modelId: "test-model", thinking: "low" }]);
	expect(commands).toEqual([]);
	await waitFor(() => expect(hook.result.current.currentPath).toBe(sessionPath));
});

it("configures an older server with model and thinking when setupApplied is missing", async () => {
	setupApplied = undefined;
	const hook = renderHook(() => usePiWeb());
	await act(async () => {
		await hook.result.current.newSession("/work", {
			provider: "test-provider", modelId: "test-model", thinking: "low",
		});
	});
	expect(commands).toEqual([
		{ cmd: "setModel", provider: "test-provider", modelId: "test-model", fresh: true },
		{ cmd: "setThinkingLevel", level: "low" },
	]);
});
