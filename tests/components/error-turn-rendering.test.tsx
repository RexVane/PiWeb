// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { ChatWindow } from "@/components/ChatWindow";
import { usePiWeb } from "@/hooks/usePiWeb";
import type { WebMessage, WebSnapshot } from "@/lib/types";

class EventSourceMock {
	static instances: EventSourceMock[] = [];
	readonly url: string;
	onopen: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	constructor(url: string) {
		this.url = url;
		EventSourceMock.instances.push(this);
		queueMicrotask(() => this.onopen?.(new Event("open")));
	}
	addEventListener() {}
	removeEventListener() {}
	emit(payload: unknown, lastEventId = "") {
		this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload), lastEventId }));
	}
	close() {}
}

const okJson = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } });

const baseSnapshot = (extra: Partial<WebSnapshot> = {}): WebSnapshot => ({
	seq: 1,
	sessionPath: "/sessions/xai-oauth.jsonl",
	cwd: "/work",
	name: "xai",
	contextFiles: [],
	contextResources: [],
	skills: [],
	promptTemplates: [],
	extensionCommands: [],
	projectTrust: { required: false, trusted: true, source: "always" },
	resourceDiagnostics: [],
	messages: [],
	userTurns: [],
	growthError: null,
	model: { provider: "xai", id: "grok-4.7", name: "Grok 4.7" },
	thinkingLevel: "low",
	thinkingLevels: ["low", "medium", "high", "xhigh"],
	tools: { active: ["read"], all: [{ name: "read" }] },
	stats: null,
	contextUsage: null,
	queue: { steering: [], followUp: [] },
	trajectory: [],
	isStreaming: false,
	...extra,
});

describe("error turn visibility for OAuth / provider failures", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		EventSourceMock.instances = [];
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		localStorage.clear();
		sessionStorage.clear();
	});

	it("surfaces bare invalid_grant OAuth assistant error turns visibly instead of collapsing them", () => {
		const oauthError = 'OAuth refresh failed for xai: xAI OAuth token refresh failed (HTTP 400): invalid_grant: refresh token expired';
		const messages: WebMessage[] = [
			{ role: "user", id: "u1", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
			{
				role: "assistant",
				id: "a1",
				content: [],
				stopReason: "error",
				errorMessage: oauthError,
				timestamp: 1500,
				endedAt: 2000,
			},
		];

		const { container } = render(<ChatWindow messages={messages} tools={{}} isStreaming={false} />);

		const errorText = screen.getByText((text) => text.includes(oauthError));
		expect(errorText).toBeTruthy();
		expect(errorText.closest('[data-collapsed="true"]')).toBeNull();
		expect(errorText.closest('[aria-hidden="true"]')).toBeNull();
		expect(errorText.closest('[inert]')).toBeNull();
		// No empty process collapse toggle is shown when there are no prior steps.
		expect(container.querySelector(".pw-turn-toggle")).toBeNull();
		expect(errorText.textContent).toContain("鉴权失败");
	});

	it("keeps terminal error visible outside collapsed process body when prior context or tool steps exist", () => {
		const oauthError = 'OAuth refresh failed for xai: xAI OAuth token refresh failed (HTTP 400): invalid_grant';
		const messages: WebMessage[] = [
			{ role: "user", id: "u1", content: [{ type: "text", text: "check repo" }], timestamp: 1000 },
			{
				role: "assistant",
				id: "a1",
				content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "README.md" } }],
				stopReason: "toolUse",
				timestamp: 1200,
				durationMs: 300,
			},
			{
				role: "assistant",
				id: "a2",
				content: [],
				stopReason: "error",
				errorMessage: oauthError,
				timestamp: 2000,
				endedAt: 2500,
			},
		];

		const { container } = render(
			<ChatWindow
				messages={messages}
				tools={{ t1: { name: "read", args: { path: "README.md" }, state: "done", result: "ok" } }}
				contextFiles={[{ path: "/work/AGENTS.md", content: "rules", source: "project" }]}
				isStreaming={false}
			/>,
		);

		const toggle = container.querySelector(".pw-turn-toggle")!;
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		const collapsedBody = container.querySelector(".pw-turn-body")!;
		expect(collapsedBody.getAttribute("data-collapsed")).toBe("true");
		// Prior steps remain collapsed inside pw-turn-body, while the error message is outside and visible.
		expect(collapsedBody.textContent).not.toContain(oauthError);
		const errorText = screen.getByText((text) => text.includes(oauthError));
		expect(errorText.closest(".pw-turn-body")).toBeNull();
		expect(errorText.closest('[aria-hidden="true"]')).toBeNull();

		// Expanding the toggle still reveals the prior read/context steps without duplicating the terminal error.
		fireEvent.click(toggle);
		expect(collapsedBody.getAttribute("data-collapsed")).toBeNull();
		expect(collapsedBody.textContent).toContain("AGENTS.md");
		expect(collapsedBody.textContent).toContain("读了 1 个文件");
		fireEvent.click(screen.getByRole("button", { name: /读了 1 个文件/ }));
		expect(collapsedBody.textContent).toContain("README.md");
		expect(screen.getAllByText((text) => text.includes(oauthError))).toHaveLength(1);
	});

	it("streams an OAuth invalid_grant error turn through usePiWeb into a visible ChatWindow error", async () => {
		const oauthError = 'OAuth refresh failed for xai: xAI OAuth token refresh failed (HTTP 400): invalid_grant';
		vi.stubGlobal("EventSource", EventSourceMock);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost").pathname;
			if (url === "/api/sessions") return okJson({ sessions: [], running: {}, nextOffset: null });
			if (url.startsWith("/api/agent/")) return okJson({ accepted: true });
			return okJson({ models: [], providers: [] });
		}));

		const hook = renderHook(() => usePiWeb());
		act(() => hook.result.current.openSession("/sessions/xai-oauth.jsonl", "/work"));
		await waitFor(() => expect(EventSourceMock.instances).toHaveLength(1));
		const stream = EventSourceMock.instances[0];

		await act(async () => {
			stream.emit({ type: "snapshot", snapshot: baseSnapshot() }, "ep1.1");
		});
		await act(async () => {
			await hook.result.current.sendCommand({ cmd: "prompt", text: "hi" });
		});
		await act(async () => {
			stream.emit({ type: "status", isStreaming: true, state: "running", ts: 2000 }, "ep1.2");
			stream.emit({
				type: "message",
				phase: "start",
				message: { role: "user", id: "u1", content: [{ type: "text", text: "hi" }], timestamp: 2000 },
				ts: 2000,
			}, "ep1.3");
			stream.emit({
				type: "message",
				phase: "start",
				message: { role: "assistant", streamId: "s1", content: [], stopReason: "pending", timestamp: 2100 },
				ts: 2100,
			}, "ep1.4");
			stream.emit({
				type: "message",
				phase: "end",
				message: { role: "assistant", id: "a1", streamId: "s1", content: [], stopReason: "error", errorMessage: oauthError, timestamp: 2100, endedAt: 2400 },
				ts: 2400,
			}, "ep1.5");
			stream.emit({ type: "status", isStreaming: false, state: "idle", ts: 2400 }, "ep1.6");
			await new Promise((resolve) => setTimeout(resolve, 25));
		});

		render(
			<ChatWindow
				messages={hook.result.current.state.messages}
				tools={hook.result.current.state.tools}
				isStreaming={hook.result.current.state.snapshot?.isStreaming ?? false}
			/>,
		);

		const renderedError = screen.getByText((text) => text.includes(oauthError));
		expect(renderedError.closest('[data-collapsed="true"]')).toBeNull();
		expect(renderedError.closest('[aria-hidden="true"]')).toBeNull();
	});
});
