// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePiWeb } from "@/hooks/usePiWeb";
import type { WebSnapshot } from "@/lib/types";

function deferred<T = Response>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class EventSourceMock {
	static instances: EventSourceMock[] = [];
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSED = 2;

	readonly url: string;
	readyState = EventSourceMock.OPEN;
	onopen: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	private listeners = new Map<string, Set<EventListener>>();

	constructor(url: string) {
		this.url = url;
		EventSourceMock.instances.push(this);
		queueMicrotask(() => {
			if (this.readyState !== EventSourceMock.CLOSED) this.onopen?.(new Event("open"));
		});
	}

	addEventListener(type: string, listener: EventListener) {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: EventListener) {
		this.listeners.get(type)?.delete(listener);
	}

	emit(payload: unknown) {
		const ev = new MessageEvent("message", { data: JSON.stringify(payload) });
		this.onmessage?.(ev);
	}

	close() {
		this.readyState = EventSourceMock.CLOSED;
	}
}

const okJson = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } });
const errJson = (error: string, status = 400) => new Response(JSON.stringify({ success: false, error }), { status, headers: { "Content-Type": "application/json" } });

const baseSnapshot = (extra: Partial<WebSnapshot> = {}): WebSnapshot => ({
	seq: 1,
	sessionPath: "/sessions/hero.jsonl",
	cwd: "/work",
	name: "hero",
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
	thinkingLevels: ["off", "low", "high"],
	toolPreset: "full",
	toolPreferenceSaved: true,
	tools: { active: ["read", "bash", "edit"], all: [{ name: "read" }, { name: "bash" }, { name: "edit" }] },
	stats: null,
	contextUsage: null,
	queue: { steering: [], followUp: [] },
	trajectory: [],
	isStreaming: false,
	...extra,
});

describe("usePiWeb single-RTT newSession and optimistic prompt", () => {
	const createdPayloads: Record<string, unknown>[] = [];
	const commandPayloads: Record<string, unknown>[] = [];
	let pendingCommandResponse: ReturnType<typeof deferred<Response>> | null = null;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		window.history.replaceState({}, "", "/");
		EventSourceMock.instances = [];
		createdPayloads.length = 0;
		commandPayloads.length = 0;
		pendingCommandResponse = null;

		vi.stubGlobal("EventSource", EventSourceMock);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost").pathname;
			if (init?.method === "POST" && url === "/api/agent/new") {
				const body = JSON.parse(String(init.body));
				createdPayloads.push(body);
				return okJson({ sessionPath: "/sessions/hero.jsonl", setupApplied: true });
			}
			if (init?.method === "POST" && url.startsWith("/api/agent/")) {
				commandPayloads.push(JSON.parse(String(init.body)));
				if (pendingCommandResponse) {
					const d = pendingCommandResponse;
					pendingCommandResponse = null;
					return d.promise;
				}
				return okJson({ accepted: true });
			}
			if (url === "/api/sessions") return okJson({ sessions: [], running: {}, nextOffset: null });
			return okJson({ models: [], providers: [] });
		}));
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		localStorage.clear();
		sessionStorage.clear();
	});

	it("preserves explicit full preset on newSession without mutating localStorage and renders optimistic prompt before fetch settles", async () => {
		localStorage.setItem("piweb.toolPreset", "workspace");
		const hook = renderHook(() => usePiWeb());

		await act(async () => {
			await hook.result.current.newSession("/work", {
				toolPreset: "full",
				provider: "p",
				modelId: "m",
				thinking: "high",
			});
		});

		expect(createdPayloads).toEqual([{ cwd: "/work", toolPreset: "full", provider: "p", modelId: "m", thinking: "high" }]);
		expect(commandPayloads).toEqual([]);
		expect(localStorage.getItem("piweb.toolPreset")).toBe("workspace");
		expect(hook.result.current.state.toolPreset).toBe("full");

		await waitFor(() => expect(EventSourceMock.instances.length).toBe(1));
		const stream = EventSourceMock.instances[0];

		const pending = deferred<Response>();
		pendingCommandResponse = pending;

		let promptPromise!: Promise<{ success: boolean; error?: string; data?: Record<string, unknown> }>;
		act(() => {
			promptPromise = hook.result.current.sendCommand({ cmd: "prompt", text: "立即出现" });
		});

		// Optimistic user message appears synchronously before POST /api/agent/:id resolves.
		expect(hook.result.current.state.messages).toHaveLength(1);
		expect(hook.result.current.state.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "立即出现" }],
		});
		expect(hook.result.current.state.messages[0].streamId).toMatch(/^__optimistic__:/);

		// Empty pre-turn snapshot from SSE must keep the optimistic message visible.
		await act(async () => {
			stream.emit({ type: "snapshot", snapshot: baseSnapshot({ messages: [] }) });
		});
		expect(hook.result.current.state.messages).toHaveLength(1);
		expect(hook.result.current.state.messages[0].streamId).toMatch(/^__optimistic__:/);

		// Resolve prompt acceptance, then emit authoritative server user message: no duplicate rows.
		pending.resolve(okJson({ accepted: true }));
		await act(async () => {
			expect(await promptPromise).toEqual({ success: true, data: { accepted: true } });
		});
		await act(async () => {
			stream.emit({
				type: "message",
				phase: "end",
				message: { role: "user", id: "entry-u1", streamId: "srv-u1", content: [{ type: "text", text: "立即出现" }] },
				ts: 1,
			});
		});
		await waitFor(() => {
			expect(hook.result.current.state.messages).toEqual([
				expect.objectContaining({ role: "user", id: "entry-u1", streamId: "srv-u1" }),
			]);
		});

		// Subsequent snapshot replaces cleanly without duplicating.
		await act(async () => {
			stream.emit({
				type: "snapshot",
				snapshot: baseSnapshot({
					messages: [{ role: "user", id: "entry-u1", content: [{ type: "text", text: "立即出现" }] }],
				}),
			});
		});
		await waitFor(() => {
			expect(hook.result.current.state.messages).toHaveLength(1);
			expect(hook.result.current.state.messages[0].id).toBe("entry-u1");
		});
	});

	it("rolls back optimistic user messages on failed prompt or extension /command responses", async () => {
		const hook = renderHook(() => usePiWeb());
		await act(async () => {
			await hook.result.current.newSession("/work");
		});
		await waitFor(() => expect(EventSourceMock.instances.length).toBe(1));
		await act(async () => {
			EventSourceMock.instances[0].emit({ type: "snapshot", snapshot: baseSnapshot() });
		});

		// Active-session composer prompt (implicit target) rolls back optimistic message and returns error for inline display.
		const failing = deferred<Response>();
		pendingCommandResponse = failing;
		let failPromise!: Promise<{ success: boolean; error?: string }>;
		act(() => {
			failPromise = hook.result.current.sendCommand({ cmd: "prompt", text: "会失败的消息" });
		});
		expect(hook.result.current.state.messages).toHaveLength(1);

		failing.resolve(errJson("session is busy"));
		await act(async () => {
			expect(await failPromise).toMatchObject({ success: false, error: "session is busy" });
		});
		expect(hook.result.current.state.messages).toEqual([]);
		expect(hook.result.current.state.error).toBeNull();

		// Hero / explicit target prompt failure reports to state.error as well as rolling back.
		const explicitFail = deferred<Response>();
		pendingCommandResponse = explicitFail;
		let heroFailPromise!: Promise<{ success: boolean; error?: string }>;
		act(() => {
			heroFailPromise = hook.result.current.sendCommand(
				{ cmd: "prompt", text: "Hero失败消息" },
				hook.result.current.currentId ?? undefined,
			);
		});
		expect(hook.result.current.state.messages).toHaveLength(1);
		explicitFail.resolve(errJson("hero error"));
		await act(async () => {
			expect(await heroFailPromise).toMatchObject({ success: false, error: "hero error" });
		});
		expect(hook.result.current.state.messages).toEqual([]);
		expect(hook.result.current.state.error).toBe("hero error");

		const slashCmd = deferred<Response>();
		pendingCommandResponse = slashCmd;
		let cmdPromise!: Promise<{ success: boolean; data?: Record<string, unknown> }>;
		act(() => {
			cmdPromise = hook.result.current.sendCommand({ cmd: "prompt", text: "/compact" });
		});
		expect(hook.result.current.state.messages).toHaveLength(1);

		slashCmd.resolve(okJson({ command: true }));
		await act(async () => {
			expect(await cmdPromise).toEqual({ success: true, data: { command: true } });
		});
		expect(hook.result.current.state.messages).toEqual([]);
	});
});
