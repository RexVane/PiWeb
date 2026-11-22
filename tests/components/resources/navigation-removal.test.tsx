// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResourceNavigationProvider, useResourceNavigation } from "@/components/resources/ResourceNavigation";
import { RESOURCE_CHANGE_EVENT } from "@/hooks/useResourceRegistry";
import { RESOURCE_FRAME_CHANNEL, type ResourceDialogIntent, type ResourceUiOutcome, type WebResourceView } from "@/lib/resources/protocol";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const view: WebResourceView = { id: "project:current:dialog", resourceId: "current", scope: "project", title: "Current extension dialog", placement: "dialog", methods: [], capabilities: ["sessions.open"], url: "/api/resources/views/current/assets/dialog.html" };
const unrelated: WebResourceView = { ...view, id: "project:removed:dialog", resourceId: "removed", title: "Other extension dialog" };
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
function pending<T>() {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
}
function Launch({ signal, finish }: { signal: AbortSignal; finish: (outcome: ResourceUiOutcome) => void }) {
	const navigation = useResourceNavigation()!;
	const intent: ResourceDialogIntent = { type: "views.open", view, cwd: "/workspace", sessionPath: "/session-a", data: null };
	return <button onClick={() => { void navigation.openView(intent, signal).then(finish); }}>Open resource</button>;
}
function Fixture({ signal, finish, openSession = () => {} }: { signal: AbortSignal; finish: (outcome: ResourceUiOutcome) => void; openSession?: (path: string) => void }) {
	return <ResourceNavigationProvider value={{ openSession, createDraft: () => {} }}><Launch signal={signal} finish={finish} /></ResourceNavigationProvider>;
}
function ready(frame: HTMLIFrameElement) {
	const source = frame.contentWindow!; const post = vi.spyOn(source, "postMessage").mockImplementation(() => {});
	fireEvent(window, new MessageEvent("message", { source, data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" } }));
	const token = (post.mock.calls.find(([message]) => (message as { type?: string }).type === "context")![0] as { token: string }).token;
	return { source, post, token };
}

describe("nested resource view removal", () => {
	it("keeps another extension's open dialog when an unrelated package disappears, then cancels and aborts when its own view disappears", async () => {
		let views = [view, unrelated]; let actionSignal: AbortSignal | undefined;
		const action = pending<unknown>(); const discovery = vi.fn();
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST") { actionSignal = init.signal as AbortSignal; return action.promise; }
			discovery(views); return Promise.resolve(response({ views }));
		}));
		const finish = vi.fn(); const openSession = vi.fn();
		render(<Fixture signal={new AbortController().signal} finish={finish} openSession={openSession} />);
		fireEvent.click(screen.getByRole("button", { name: "Open resource" }));
		const frame = await screen.findByTitle(view.title) as HTMLIFrameElement; const old = ready(frame);
		await waitFor(() => expect(discovery).toHaveBeenCalledTimes(1));
		fireEvent(window, new MessageEvent("message", { source: old.source, data: { channel: RESOURCE_FRAME_CHANNEL, type: "host", token: old.token, id: "pending-navigation", name: "sessions.open", args: { sessionPath: "/late" } } }));
		await waitFor(() => expect(actionSignal).toBeDefined());
		views = [view]; fireEvent(window, new Event(RESOURCE_CHANGE_EVENT));
		await waitFor(() => expect(discovery).toHaveBeenCalledTimes(2));
		expect(screen.getByTitle(view.title)).toBe(frame); expect(actionSignal!.aborted).toBe(false); expect(finish).not.toHaveBeenCalled();
		views = []; fireEvent(window, new Event(RESOURCE_CHANGE_EVENT));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(finish).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" }); expect(actionSignal!.aborted).toBe(true);
		await act(async () => action.resolve(response({ type: "sessions.open", sessionPath: "/late" })));
		fireEvent(window, new MessageEvent("message", { source: old.source, data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token: old.token, value: "late" } }));
		expect(openSession).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledTimes(1);
		expect(old.post.mock.calls.some(([message]) => (message as { id?: string }).id === "pending-navigation")).toBe(false);
	});

	it("preserves the same dialog document through a failed registry refresh and allows cancellation after discovery recovers", async () => {
		let failed = false; const discovery = vi.fn();
		vi.stubGlobal("fetch", vi.fn(() => {
			discovery(failed);
			return Promise.resolve(failed ? { ok: false, json: async () => ({ success: false, error: "Registry unavailable" }) } : response({ views: [view] }));
		}));
		const finish = vi.fn(); const owner = new AbortController();
		render(<Fixture signal={owner.signal} finish={finish} />);
		fireEvent.click(screen.getByRole("button", { name: "Open resource" }));
		const frame = await screen.findByTitle(view.title) as HTMLIFrameElement; ready(frame);
		await waitFor(() => expect(discovery).toHaveBeenCalledTimes(1));
		failed = true; await act(async () => { window.dispatchEvent(new Event(RESOURCE_CHANGE_EVENT)); });
		expect(discovery).toHaveBeenCalledTimes(2); expect(screen.getByTitle(view.title)).toBe(frame); expect(finish).not.toHaveBeenCalled();
		failed = false; await act(async () => { window.dispatchEvent(new Event(RESOURCE_CHANGE_EVENT)); });
		expect(screen.getByTitle(view.title)).toBe(frame); expect(finish).not.toHaveBeenCalled();
		act(() => owner.abort());
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(finish).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" });
	});
});
