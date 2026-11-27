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

	emit(payload: unknown, lastEventId = "") {
		const ev = new MessageEvent("message", { data: JSON.stringify(payload), lastEventId });
		this.onmessage?.(ev);
	}

	close() {
		this.readyState = EventSourceMock.CLOSED;
	}
}

const okJson = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json" } });
const errJson = (error: string, status = 400) => new Response(JSON.stringify({ success: false, error }), { status, headers: { "Content-Type": "application/json" } });

const grokSnapshot = (extra: Partial<WebSnapshot> = {}): WebSnapshot => ({
	seq: 10,
	sessionPath: "/sessions/grok.jsonl",
	cwd: "/work",
	name: "grok",
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
	thinkingLevel: "xhigh",
	thinkingLevels: ["low", "medium", "high", "xhigh"],
	tools: { active: ["read"], all: [{ name: "read" }] },
	stats: null,
	contextUsage: null,
	queue: { steering: [], followUp: [] },
	trajectory: [],
	isStreaming: false,
	...extra,
});

describe("usePiWeb thinking-level optimistic sync and race protection", () => {
	const commandLog: Array<Record<string, unknown>> = [];
	const deferredCommands: Array<ReturnType<typeof deferred<Response>>> = [];

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		window.history.replaceState({}, "", "/");
		EventSourceMock.instances = [];
		commandLog.length = 0;
		deferredCommands.length = 0;

		vi.stubGlobal("EventSource", EventSourceMock);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost").pathname;
			if (init?.method === "POST" && url.startsWith("/api/agent/")) {
				commandLog.push(JSON.parse(String(init.body)));
				const next = deferredCommands.shift();
				if (next) return next.promise;
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

	it("keeps explicit low selection over stale snapshots, queued model events, and orders prompt after setThinkingLevel", async () => {
		const hook = renderHook(() => usePiWeb());
		act(() => hook.result.current.openSession("/sessions/grok.jsonl", "/work"));
		await waitFor(() => expect(EventSourceMock.instances).toHaveLength(1));
		const stream = EventSourceMock.instances[0];

		await act(async () => {
			stream.emit({ type: "snapshot", snapshot: grokSnapshot({ seq: 10, thinkingLevel: "xhigh" }) }, "ep1.10");
		});
		expect(hook.result.current.state.snapshot?.thinkingLevel).toBe("xhigh");

		// A stale model event sits in the batcher before the user switches to low.
		act(() => {
			stream.emit({ type: "model", provider: "xai", model: "grok-4.7", thinkingLevel: "xhigh", ts: Date.now() }, "ep1.11");
		});

		const pendingLevel = deferred<Response>();
		deferredCommands.push(pendingLevel);

		let levelPromise!: Promise<unknown>;
		let promptPromise!: Promise<unknown>;
		act(() => {
			levelPromise = hook.result.current.sendCommand({ cmd: "setThinkingLevel", level: "low" });
			promptPromise = hook.result.current.sendCommand({ cmd: "prompt", text: "send after low" });
		});

		// Optimistic level applies immediately and optimistic user prompt is visible right away.
		expect(hook.result.current.state.snapshot?.thinkingLevel).toBe("low");
		expect(hook.result.current.state.messages).toHaveLength(1);
		// Prompt HTTP request must wait until setThinkingLevel finishes.
		expect(commandLog).toEqual([{ cmd: "setThinkingLevel", level: "low" }]);

		// In-flight stale model event & stale snapshot must not revert low -> xhigh.
		await act(async () => {
			stream.emit({ type: "model", provider: "xai", model: "grok-4.7", thinkingLevel: "xhigh", ts: Date.now() }, "ep1.12");
			stream.emit({ type: "snapshot", snapshot: grokSnapshot({ seq: 10, thinkingLevel: "xhigh" }) }, "ep1.10");
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(hook.result.current.state.snapshot?.thinkingLevel).toBe("low");

		await act(async () => {
			pendingLevel.resolve(okJson({ requested: "low", thinkingLevel: "low", clamped: false }));
			await levelPromise;
			await promptPromise;
		});

		expect(commandLog).toEqual([
			{ cmd: "setThinkingLevel", level: "low" },
			{ cmd: "prompt", text: "send after low" },
		]);
		expect(hook.result.current.state.snapshot?.thinkingLevel).toBe("low");

		// Even after setThinkingLevel settles, a stale snapshot with seq <= seqAtDispatch cannot flip low -> xhigh.
		await act(async () => {
			stream.emit({ type: "snapshot", snapshot: grokSnapshot({ seq: 10, thinkingLevel: "xhigh" }) }, "ep1.10");
		});
		expect(hook.result.current.state.snapshot?.thinkingLevel).toBe("low");

		// A newer authoritative model event (e.g., from another tab or extension) updates normally.
		await act(async () => {
			stream.emit({ type: "model", provider: "xai", model: "grok-4.7", thinkingLevel: "low", ts: Date.now() }, "ep1.13");
			await new Promise((resolve) => setTimeout(resolve, 25));
			stream.emit({ type: "model", provider: "xai", model: "grok-4.7", thinkingLevel: "high", ts: Date.now() }, "ep1.14");
			await new Promise((resolve) => setTimeout(resolve, 25));
		});
		expect(hook.result.current.state.snapshot?.thinkingLevel).toBe("high");
	});

	it("rolls back optimistic thinkingLevel if setThinkingLevel fails", async () => {
		const hook = renderHook(() => usePiWeb());
		act(() => hook.result.current.openSession("/sessions/grok.jsonl", "/work"));
		await waitFor(() => expect(EventSourceMock.instances).toHaveLength(1));
		const stream = EventSourceMock.instances[0];

		await act(async () => {
			stream.emit({ type: "snapshot", snapshot: grokSnapshot({ seq: 5, thinkingLevel: "xhigh" }) }, "ep1.5");
		});

		const failedLevel = deferred<Response>();
		deferredCommands.push(failedLevel);

		let promise!: Promise<unknown>;
		act(() => {
			promise = hook.result.current.sendCommand({ cmd: "setThinkingLevel", level: "low" });
		});
		expect(hook.result.current.state.snapshot?.thinkingLevel).toBe("low");

		await act(async () => {
			failedLevel.resolve(errJson("session disposed", 500));
			await promise;
		});
		expect(hook.result.current.state.snapshot?.thinkingLevel).toBe("xhigh");
		expect(hook.result.current.state.error).toBe("session disposed");
	});
});
