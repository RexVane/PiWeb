// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddResourceMenu } from "@/components/resources/AddResourceMenu";
import { ResourceInstallModal } from "@/components/resources/ResourceInstallModal";
import { ResourceFrame } from "@/components/resources/ResourceFrame";
import { RESOURCE_FRAME_CHANNEL, type WebResourceView } from "@/lib/resources/protocol";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const view: WebResourceView = { id: "user:demo:main", resourceId: "demo", scope: "user", title: "Demo view", placement: "panel", methods: [], url: "/api/resources/views/abcd/assets/index.html" };

describe("resource adding flow", () => {
	it("opens exactly the two choices and invokes the selected action", () => {
		const install = vi.fn(); const design = vi.fn();
		render(<AddResourceMenu label="添加扩展" onInstall={install} onDesign={design} />);
		fireEvent.click(screen.getByRole("button", { name: /添加扩展/ }));
		expect(screen.getAllByRole("menuitem")).toHaveLength(2);
		fireEvent.click(screen.getByRole("menuitem", { name: /自己设计/ }));
		expect(design).toHaveBeenCalledTimes(1); expect(install).not.toHaveBeenCalled(); expect(screen.queryByRole("menu")).toBeNull();
	});
	it("actually starts a design session in the prepared workspace, once even in StrictMode", async () => {
		const calls: Array<Record<string, unknown>> = [];
		vi.stubGlobal("fetch", vi.fn(async (url, init) => {
			if (String(url) === "/api/resources/development") {
				calls.push(JSON.parse(init.body));
				return { ok: true, json: async () => ({ success: true, data: { prepared: { cwd: "/resources/new", name: "new", types: ["extensions"], compatibility: "unknown", installSource: "/resources/new" }, prompt: "Read the public API and design this resource." } }) };
			}
			return { ok: true, json: async () => ({ success: true, data: { preferences: { developmentRoot: "/resources" } } }) };
		}));
		const start = vi.fn(async () => true); const close = vi.fn();
		render(<StrictMode><ResourceInstallModal open cwd="/workspace" mode="design" onClose={close} onSubmit={vi.fn()} onStartSession={start} /></StrictMode>);
		await waitFor(() => expect(start).toHaveBeenCalledWith("/resources/new", "Read the public API and design this resource."));
		expect(calls).toHaveLength(1); expect(close).toHaveBeenCalledTimes(1);
	});
	it("installs an explicitly selected market source with the selected Pi scope", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url) => ({ ok: true, json: async () => ({ success: true, data: String(url).includes("market=1")
			? { items: [{ id: "demo", name: "Demo package", description: "Independent resource", author: "user", version: "1.0.0", types: ["extensions"], compatibility: "web", source: "npm:demo@1.0.0" }] }
			: { preferences: { renderers: {}, catalogUrls: [] } } }) })));
		const install = vi.fn(async () => true);
		render(<ResourceInstallModal open cwd="/workspace" onClose={vi.fn()} onSubmit={install} />);
		fireEvent.click(await screen.findByRole("button", { name: /Demo package/ }));
		fireEvent.click(screen.getByRole("radio", { name: "仅当前工作区" }));
		fireEvent.click(screen.getByRole("button", { name: "安装" }));
		await waitFor(() => expect(install).toHaveBeenCalledWith("npm:demo@1.0.0", true));
	});
});

describe("independent browser frame", () => {
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
});
