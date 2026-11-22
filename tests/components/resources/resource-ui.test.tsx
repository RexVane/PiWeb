// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResourceDesignWorkspace } from "@/components/resources/ResourceDesignWorkspace";
import { ResourceNavigationProvider } from "@/components/resources/ResourceNavigation";
import { ResourceFrame } from "@/components/resources/ResourceFrame";
import { RESOURCE_FRAME_CHANNEL, type WebResourceView } from "@/lib/resources/protocol";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const view: WebResourceView = { id: "user:demo:main", resourceId: "demo", scope: "user", title: "Demo view", placement: "panel", methods: [], url: "/api/resources/views/abcd/assets/index.html" };

describe("resource design workspace", () => {
	it("resumes and previews an existing design without creating or installing anything", async () => {
		const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ success: true, data:
			url.endsWith("&status=1") ? { design: true, hasWeb: true } : { views: [{ ...view, preview: true }] },
		}) }));
		vi.stubGlobal("fetch", fetcher);
		const resume = vi.fn();
		render(<ResourceNavigationProvider value={{ openSession: vi.fn(), createDraft: vi.fn(), continueDesign: resume }}><ResourceDesignWorkspace cwd="/resources/new" reloadSeq={0} /></ResourceNavigationProvider>);
		fireEvent.click(await screen.findByRole("button", { name: "继续设计" }));
		expect(resume).toHaveBeenCalledWith("/resources/new");
		fireEvent.click(screen.getByRole("button", { name: "预览界面" }));
		expect(await screen.findByTitle("Demo view")).toBeTruthy();
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/resources/development?cwd=%2Fresources%2Fnew&status=1", "/api/resources/development?cwd=%2Fresources%2Fnew"]);
	});
});

describe("independent browser frame", () => {
	it.each(["settings", "automatic"] as const)("keeps a cold %s document alive beyond ten seconds and allows bridge readiness after load", (kind) => {
		vi.useFakeTimers();
		const resourceView: WebResourceView = kind === "automatic" ? { ...view, placement: "aboveEditor", autoMount: true } : { ...view, placement: "settings" };
		const { container } = render(<ResourceFrame view={resourceView} cwd="/workspace" sessionPath="/chat-a" />);
		const frame = container.querySelector("iframe")!;
		const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
		act(() => { vi.advanceTimersByTime(12_000); });
		expect(container.querySelector("iframe")).toBe(frame);
		expect(screen.queryByRole("status")).toBeNull();
		fireEvent.load(frame);
		act(() => { vi.advanceTimersByTime(9_999); });
		expect(container.querySelector("iframe")).toBe(frame);
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: frame.contentWindow! }));
		expect(post).toHaveBeenCalled();
		const token = (post.mock.calls[0][0] as { token: string }).token;
		const height = kind === "automatic" ? 42 : 120;
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "resize", token, height }, source: frame.contentWindow! }));
		act(() => { vi.advanceTimersByTime(60_000); });
		expect(container.querySelector("iframe")).toBe(frame);
		expect(frame.style.height).toBe(`${height}px`);
		expect(frame.hasAttribute("aria-hidden")).toBe(false);
		expect(screen.queryByRole("status")).toBeNull();
	});
	it("bounds a stalled document load and ignores a foreign readiness announcement", () => {
		vi.useFakeTimers();
		const { container } = render(<ResourceFrame view={{ ...view, placement: "settings" }} cwd="/workspace" />);
		const frame = container.querySelector("iframe")!;
		act(() => { vi.advanceTimersByTime(29_999); });
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: window }));
		expect(container.querySelector("iframe")).toBe(frame);
		act(() => { vi.advanceTimersByTime(1); });
		expect(container.querySelector("iframe")).toBeNull();
		expect(screen.getByRole("status").textContent).toContain("扩展界面暂时不可用");
		expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
	});
	it("gives a late-loaded automatic frame ten seconds for its bridge and leaves no space after failure", () => {
		vi.useFakeTimers();
		const { container } = render(<ResourceFrame view={{ ...view, placement: "aboveEditor", autoMount: true }} cwd="/workspace" sessionPath="/chat-a" />);
		const frame = container.querySelector("iframe")!;
		act(() => { vi.advanceTimersByTime(29_999); });
		fireEvent.load(frame);
		act(() => { vi.advanceTimersByTime(9_999); });
		expect(container.querySelector("iframe")).toBe(frame);
		expect(frame.style.height).toBe("0px");
		act(() => { vi.advanceTimersByTime(1); });
		expect(container.childElementCount).toBe(0);
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
	});
	it("cancels both deadlines when the bridge is ready before the load event", () => {
		vi.useFakeTimers();
		const { container } = render(<ResourceFrame view={{ ...view, placement: "settings" }} cwd="/workspace" />);
		const frame = container.querySelector("iframe")!;
		const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: frame.contentWindow! }));
		expect(post).toHaveBeenCalled();
		act(() => { vi.advanceTimersByTime(45_000); });
		fireEvent.load(frame);
		act(() => { vi.advanceTimersByTime(10_001); });
		expect(container.querySelector("iframe")).toBe(frame);
		expect(screen.queryByRole("status")).toBeNull();
	});
	it("retries with a new document and token, aborts old actions, and drops late old responses", async () => {
		const signals: AbortSignal[] = [];
		const finish: Array<(response: Response) => void> = [];
		const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
			signals.push(init!.signal as AbortSignal);
			return new Promise<Response>((resolve) => { finish.push(resolve); });
		});
		vi.stubGlobal("fetch", fetcher);
		const openSession = vi.fn(); const answer = vi.fn(); const busy = vi.fn();
		const { container } = render(<ResourceNavigationProvider value={{ openSession, createDraft: vi.fn() }}><ResourceFrame view={{ ...view, capabilities: ["sessions.open"] }} cwd="/workspace" onAnswer={answer} onBusyChange={busy} /></ResourceNavigationProvider>);
		const oldFrame = container.querySelector("iframe")!;
		const oldWindow = oldFrame.contentWindow!;
		const oldPost = vi.spyOn(oldWindow, "postMessage").mockImplementation(() => {});
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: oldWindow }));
		const oldToken = (oldPost.mock.calls[0][0] as { token: string }).token;
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "busy", token: oldToken, value: true }, source: oldWindow }));
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "host", token: oldToken, id: "read-state", name: "sessions.open", args: { sessionPath: "/old-chat" } }, source: oldWindow }));
		expect(fetcher).toHaveBeenCalledTimes(1);
		fireEvent.error(oldFrame);
		expect(container.querySelector("iframe")).toBeNull();
		expect(signals[0].aborted).toBe(true);
		expect(busy).toHaveBeenLastCalledWith(false);
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		const newFrame = container.querySelector("iframe")!;
		expect(newFrame).not.toBe(oldFrame);
		expect(newFrame.getAttribute("src")).toBe(view.url);
		expect(newFrame.getAttribute("sandbox")).toBe("allow-scripts");
		const newWindow = newFrame.contentWindow!;
		const newPost = vi.spyOn(newWindow, "postMessage").mockImplementation(() => {});
		fireEvent.load(newFrame);
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: newWindow }));
		const newToken = (newPost.mock.calls[0][0] as { token: string }).token;
		expect(newToken).not.toBe(oldToken);
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token: newToken, value: "old-window" }, source: oldWindow }));
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token: oldToken, value: "old-token" }, source: newWindow }));
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "invoke", token: oldToken, id: "stale", name: "state" }, source: newWindow }));
		expect(answer).not.toHaveBeenCalled();
		expect(fetcher).toHaveBeenCalledTimes(1);
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "invoke", token: newToken, id: "read-state", name: "state" }, source: newWindow }));
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(signals[1]).not.toBe(signals[0]);
		expect(signals[1].aborted).toBe(false);
		await act(async () => {
			finish[0]({ ok: true, json: async () => ({ success: true, data: { type: "sessions.open", sessionPath: "/stale-chat" } }) } as Response);
			finish[1]({ ok: true, json: async () => ({ success: true, data: "fresh" }) } as Response);
		});
		await waitFor(() => expect(newPost.mock.calls.some(([message]) => (message as { type?: string; value?: unknown }).type === "result" && (message as { value?: unknown }).value === "fresh")).toBe(true));
		expect(openSession).not.toHaveBeenCalled();
		expect(oldPost.mock.calls.some(([message]) => (message as { type?: string }).type === "result")).toBe(false);
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token: newToken, value: "fresh-answer" }, source: newWindow }));
		expect(answer).toHaveBeenCalledWith("fresh-answer");
	});
	it("starts automatic status frames collapsed, supports compact height, and collapses empty status", async () => {
		const { container } = render(<ResourceFrame view={{ ...view, placement: "aboveEditor", autoMount: true }} cwd="/workspace" sessionPath="/chat-a" />);
		const frame = container.querySelector("iframe")!;
		expect(frame.style.height).toBe("0px");
		expect(frame.getAttribute("aria-hidden")).toBe("true");
		const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: frame.contentWindow! }));
		await waitFor(() => expect(post).toHaveBeenCalled());
		const token = (post.mock.calls[0][0] as { token: string }).token;
		const resize = (height: number) => fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "resize", token, height }, source: frame.contentWindow! }));
		resize(42); expect(frame.style.height).toBe("42px"); expect(frame.hasAttribute("aria-hidden")).toBe(false);
		resize(1); expect(frame.style.height).toBe("0px"); expect(frame.getAttribute("tabindex")).toBe("-1");
		resize(5000); expect(frame.style.height).toBe("1000px");
	});
	it("keeps the existing question and settings frame height limits", async () => {
		const { container } = render(<ResourceFrame view={{ ...view, placement: "settings" }} cwd="/workspace" />);
		const frame = container.querySelector("iframe")!;
		expect(frame.style.height).toBe("260px");
		const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: frame.contentWindow! }));
		await waitFor(() => expect(post).toHaveBeenCalled());
		const token = (post.mock.calls[0][0] as { token: string }).token;
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "resize", token, height: 1 }, source: frame.contentWindow! }));
		expect(frame.style.height).toBe("80px");
	});
	it("detaches automatic status and aborts its in-flight action when the selected chat changes", async () => {
		let signal: AbortSignal | undefined;
		vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
			signal = init.signal as AbortSignal;
			return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
		}));
		const automaticView = { ...view, placement: "aboveEditor" as const, autoMount: true };
		const { container, rerender } = render(<ResourceFrame view={automaticView} cwd="/workspace" sessionPath="/chat-a" />);
		const previous = container.querySelector("iframe")!;
		const post = vi.spyOn(previous.contentWindow!, "postMessage").mockImplementation(() => {});
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: previous.contentWindow! }));
		await waitFor(() => expect(post).toHaveBeenCalled());
		const token = (post.mock.calls[0][0] as { token: string }).token;
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "invoke", token, id: "read-state", name: "state", args: {} }, source: previous.contentWindow! }));
		await waitFor(() => expect(signal).toBeDefined());
		rerender(<ResourceFrame view={automaticView} cwd="/workspace" sessionPath="/chat-b" />);
		expect(signal!.aborted).toBe(true);
		expect(container.querySelector("iframe")).not.toBe(previous);
		expect(container.querySelector("iframe")!.style.height).toBe("0px");
	});
	it("is opaque-origin and accepts messages only from its own frame with the issued token", async () => {
		const answer = vi.fn();
		const { container } = render(<ResourceFrame view={view} cwd="/workspace" onAnswer={answer} />);
		const frame = container.querySelector("iframe")!;
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: frame.contentWindow! }));
		await waitFor(() => expect(post).toHaveBeenCalled());
		const token = (post.mock.calls[0][0] as { token: string }).token;
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token: "wrong", value: "bad" }, source: frame.contentWindow! }));
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token, value: "foreign" }, source: window }));
		expect(answer).not.toHaveBeenCalled();
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token, value: "A" }, source: frame.contentWindow! }));
		expect(answer).toHaveBeenCalledWith("A");
	});
	it("never calls backend actions or returns an approval from passive preview", async () => {
		const fetcher = vi.fn(); const answer = vi.fn(); vi.stubGlobal("fetch", fetcher);
		const { container } = render(<ResourceFrame view={{ ...view, preview: true }} cwd="/workspace" onAnswer={answer} />);
		const frame = container.querySelector("iframe")!;
		const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" }, source: frame.contentWindow! }));
		await waitFor(() => expect(post).toHaveBeenCalled());
		const token = (post.mock.calls[0][0] as { token: string }).token;
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "invoke", token, id: "preview-call", name: "run", args: {} }, source: frame.contentWindow! }));
		fireEvent(window, new MessageEvent("message", { data: { channel: RESOURCE_FRAME_CHANNEL, type: "answer", token, value: true }, source: frame.contentWindow! }));
		expect(fetcher).not.toHaveBeenCalled(); expect(answer).not.toHaveBeenCalled();
		expect(post.mock.calls.some(([message]) => (message as { error?: string }).error?.includes("Passive preview"))).toBe(true);
	});
	it("replaces the document when resource identity changes instead of reusing an old window", () => {
		const { container, rerender } = render(<ResourceFrame view={view} cwd="/workspace" />);
		const previous = container.querySelector("iframe");
		rerender(<ResourceFrame view={{ ...view, id: "user:other:main", resourceId: "other", url: "/api/resources/views/efgh/assets/index.html" }} cwd="/workspace" />);
		expect(container.querySelector("iframe")).not.toBe(previous);
	});
	it("does not load an external URL or automatically approve when a view fails", () => {
		const answer = vi.fn(); const fallback = vi.fn();
		const { container } = render(<ResourceFrame view={{ ...view, url: "https://evil.example/view" }} cwd="/workspace" onAnswer={answer} onUnavailable={fallback} />);
		expect(container.querySelector("iframe")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "使用基础界面" }));
		expect(fallback).toHaveBeenCalledTimes(1); expect(answer).not.toHaveBeenCalled();
	});
	it("fetches user-scoped resources even when no active workspace cwd is selected", async () => {
		const { useResourceRegistry } = await import("@/hooks/useResourceRegistry");
		const fetcher = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				success: true,
				data: {
					packages: [],
					views: [view],
					preferences: { catalogUrls: [], renderers: {} },
					hosts: [],
				},
			}),
		}));
		vi.stubGlobal("fetch", fetcher);
		function Probe() {
			const registry = useResourceRegistry("");
			return <span>{registry.views.map((item) => item.id).join(",")}</span>;
		}
		render(<Probe />);
		await waitFor(() => expect(screen.getByText(view.id)).toBeTruthy());
		expect(fetcher).toHaveBeenCalledWith("/api/resources", expect.anything());
	});
	it("applies whitelisted PiWeb theme variables with digits and non-dsw prefixes in client.js", async () => {
		const { readFileSync } = await import("node:fs");
		const path = await import("node:path");
		const script = readFileSync(path.resolve("public/resources/client.js"), "utf8");
		vi.spyOn(window, "postMessage").mockImplementation(() => {});
		new Function(script)();
		fireEvent(window, new MessageEvent("message", {
			source: window,
			data: {
				channel: RESOURCE_FRAME_CHANNEL,
				token: "tok-theme",
				type: "context",
				context: { viewId: view.id, resourceId: view.resourceId, scope: "user", cwd: "" },
				language: "zh",
				theme: {
					"--dsw-border-l2": "#d1d5db",
					"--dsh-ui-font-sm": "13px",
					"--pw-radius-panel": "24px",
					"--isx-ease": "ease",
					"--ds-duration-fast": "120ms",
					"--font-mono": "monospace",
					"--evil-private": "ignored",
				},
			},
		}));
		expect(document.documentElement.style.getPropertyValue("--dsw-border-l2")).toBe("#d1d5db");
		expect(document.documentElement.style.getPropertyValue("--dsh-ui-font-sm")).toBe("13px");
		expect(document.documentElement.style.getPropertyValue("--pw-radius-panel")).toBe("24px");
		expect(document.documentElement.style.getPropertyValue("--isx-ease")).toBe("ease");
		expect(document.documentElement.style.getPropertyValue("--ds-duration-fast")).toBe("120ms");
		expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe("monospace");
		expect(document.documentElement.style.getPropertyValue("--evil-private")).toBe("");
	});
});
