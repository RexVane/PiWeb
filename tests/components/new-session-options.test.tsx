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

it("applies explicit creation options once without replacing the saved default", async () => {
	localStorage.setItem("piweb.toolPreset", "full");
	const hook = renderHook(() => usePiWeb());
	await act(async () => {
		expect(await hook.result.current.newSession("/work", {
			toolPreset: "readonly", provider: "test-provider", modelId: "test-model", thinking: "low",
		})).toBe(sessionPath);
	});
	expect(created).toEqual([{ cwd: "/work", toolPreset: "readonly", provider: "test-provider", modelId: "test-model", thinking: "low" }]);
	expect(commands).toEqual([]);
	expect(localStorage.getItem("piweb.toolPreset")).toBe("full");
	await waitFor(() => expect(hook.result.current.currentPath).toBe(sessionPath));
});

it.each([
	[null, "workspace"], ["standard", "workspace"], ["readonly", "readonly"],
])("keeps the existing default behavior for stored preset %s", async (stored, expected) => {
	if (stored) localStorage.setItem("piweb.toolPreset", stored);
	const hook = renderHook(() => usePiWeb());
	await act(async () => { await hook.result.current.newSession("/work"); });
	expect(created).toEqual([{ cwd: "/work", toolPreset: expected }]);
	expect(commands).toEqual([]);
});

it("configures an older server with the explicit override before model and thinking", async () => {
	setupApplied = undefined;
	localStorage.setItem("piweb.toolPreset", "readonly");
	const hook = renderHook(() => usePiWeb());
	await act(async () => {
		await hook.result.current.newSession("/work", {
			toolPreset: "full", provider: "test-provider", modelId: "test-model", thinking: "low",
		});
	});
	expect(commands).toEqual([
		{ cmd: "setToolPreset", preset: "full" },
		{ cmd: "setModel", provider: "test-provider", modelId: "test-model", fresh: true },
		{ cmd: "setThinkingLevel", level: "low" },
	]);
	expect(localStorage.getItem("piweb.toolPreset")).toBe("readonly");
});
