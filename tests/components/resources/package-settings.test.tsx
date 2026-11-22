// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginsSection } from "@/components/settings/PluginsSection";
import { PackageResourceSettings } from "@/components/resources/PackageResourceSettings";
import { RESOURCE_CHANGE_EVENT, type ResourceRegistry } from "@/hooks/useResourceRegistry";
import { RESOURCE_FRAME_CHANNEL, type WebResourceView } from "@/lib/resources/protocol";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const item = { source: "npm:demo", scope: "project" as const, installedPath: "/workspace/package", resources: { extensions: 1, skills: 0, prompts: 0, themes: 0 } };
const extension = { name: "index", path: "/workspace/package/index.ts", sourceInfo: { source: item.source, scope: item.scope, origin: "package" as const } };
const member = { id: "demo-resource", name: "Demo", source: item.source, scope: item.scope, enabled: true, extensionPaths: ["index.ts"] };
const settings: WebResourceView = { id: "project:demo-resource:settings", resourceId: member.id, scope: item.scope, title: "Project settings", placement: "settings", methods: [], url: "/api/resources/views/demo/assets/index.html" };
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
const registry = (views: WebResourceView[] = [settings], packages: ResourceRegistry["packages"] = [member]) => ({ packages, views, hosts: [], preferences: { renderers: {}, catalogUrls: [] } });
const row = () => screen.getByRole("switch", { name: "demo" }).closest(".transition-colors")!.parentElement!;
function pending<T>() {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
}
async function ready(frame: HTMLIFrameElement) {
	const source = frame.contentWindow!;
	const post = vi.spyOn(source, "postMessage").mockImplementation(() => {});
	const announce = () => fireEvent(window, new MessageEvent("message", { source, data: { channel: RESOURCE_FRAME_CHANNEL, type: "ready" } }));
	// The browser client retries until context arrives, including before React's listener is mounted.
	const handshake = setInterval(announce, 250);
	try {
		announce();
		await waitFor(() => expect(post.mock.calls.some(([message]) => (message as { type?: string }).type === "context")).toBe(true));
		return post;
	} finally { clearInterval(handshake); }
}

it("loads the matching package's settings inline only after expansion, without a chat session", async () => {
	const views: WebResourceView[] = [settings, { ...settings, id: "user:demo-resource:settings", scope: "user", title: "Other scope" },
		{ ...settings, id: "project:unrelated:settings", resourceId: "unrelated", title: "Other package" },
		{ ...settings, id: "project:demo-resource:dialog", placement: "dialog", title: "Command dialog" }];
	const fetcher = vi.fn(async (input: RequestInfo | URL) => response(String(input).startsWith("/api/resources?")
		? registry(views, [member, { ...member, scope: "user" }, { ...member, id: "unrelated", source: "npm:another" }])
		: { packages: [item], extensions: [extension] }));
	vi.stubGlobal("fetch", fetcher);
	const { container } = render(<PluginsSection cwd="/workspace" />);
	await screen.findByText("demo");
	expect(container.querySelector("iframe")).toBeNull();
	expect(fetcher.mock.calls.some(([input]) => String(input).startsWith("/api/resources?"))).toBe(false);
	fireEvent.click(screen.getByText("demo"));
	const frame = await screen.findByTitle("Project settings") as HTMLIFrameElement;
	expect(container.querySelectorAll("iframe")).toHaveLength(1);
	expect(row().contains(frame)).toBe(true);
	const post = await ready(frame);
	await waitFor(() => expect(post).toHaveBeenCalled());
	const context = (post.mock.calls[0][0] as { context: { cwd: string; sessionPath?: string } }).context;
	expect(context.cwd).toBe("/workspace"); expect(context.sessionPath).toBeUndefined();
	expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
	fireEvent.click(screen.getByText("demo"));
	expect(container.querySelector("iframe")).toBeNull();
});

it.each(["disabled-package", "disabled-resource", "manifest-error", "extension-error", "disabled-extension"] as const)("does not mount settings for %s", async kind => {
	const packageItem = { ...item, disabled: kind === "disabled-package" };
	const packageMember = { ...member, enabled: kind !== "disabled-resource", error: kind === "manifest-error" ? "Invalid manifest" : undefined };
	const native = { ...extension, error: kind === "extension-error" ? "Cannot load extension" : undefined, disabled: kind === "disabled-extension" };
	const fetcher = vi.fn(async (input: RequestInfo | URL) => response(String(input).startsWith("/api/resources?")
		? registry([settings], [packageMember]) : { packages: [packageItem], extensions: [native] }));
	vi.stubGlobal("fetch", fetcher);
	const { container } = render(<PluginsSection cwd="/workspace" />);
	await screen.findByText("demo"); fireEvent.click(screen.getByText("demo"));
	if (kind !== "disabled-package") await waitFor(() => expect(fetcher.mock.calls.some(([input]) => String(input).startsWith("/api/resources?"))).toBe(true));
	await waitFor(() => expect(container.querySelector("iframe")).toBeNull());
});

it("keeps enabled collection members separate from a sibling's load failure", async () => {
	const second = { ...member, id: "second", extensionPaths: ["second/index.ts"] };
	const secondView = { ...settings, id: "project:second:settings", resourceId: "second", title: "Second settings" };
	vi.stubGlobal("fetch", vi.fn(async () => response(registry([settings, secondView], [member, second]))));
	const { container } = render(<PackageResourceSettings cwd="/workspace" item={item} extensions={[
		extension, { ...extension, path: "/workspace/package/second/index.ts", error: "Sibling failed" },
	]} />);
	await screen.findByTitle("Project settings");
	expect(container.querySelectorAll("iframe")).toHaveLength(1);
	expect(screen.queryByTitle("Second settings")).toBeNull();
});

it("destroys the previous workspace frame and cancels its pending request before loading the next registry", async () => {
	const nextRegistry = pending<unknown>(), oldAction = pending<unknown>(); let actionSignal: AbortSignal | undefined;
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") { actionSignal = init.signal as AbortSignal; return oldAction.promise; }
		if (String(input).includes(encodeURIComponent("/next"))) return nextRegistry.promise;
		return response(registry());
	}));
	const { container, rerender } = render(<PackageResourceSettings cwd="/workspace" item={item} extensions={[extension]} />);
	const previous = await screen.findByTitle("Project settings") as HTMLIFrameElement;
	const post = await ready(previous);
	await waitFor(() => expect(post).toHaveBeenCalled());
	const token = (post.mock.calls[0][0] as { token: string }).token;
	fireEvent(window, new MessageEvent("message", { source: previous.contentWindow!, data: { channel: RESOURCE_FRAME_CHANNEL, type: "invoke", token, id: "pending", name: "state", args: {} } }));
	await waitFor(() => expect(actionSignal).toBeDefined());
	rerender(<PackageResourceSettings cwd="/next" item={item} extensions={[extension]} />);
	expect(container.querySelector("iframe")).toBeNull(); expect(actionSignal!.aborted).toBe(true);
	oldAction.resolve(response({ changed: true })); nextRegistry.resolve(response(registry()));
	const current = await screen.findByTitle("Project settings");
	expect(current).not.toBe(previous);
	expect(post.mock.calls.some(([message]) => (message as { id?: string }).id === "pending")).toBe(false);
});

it("removes an active settings frame when a registry refresh fails", async () => {
	let failed = false;
	vi.stubGlobal("fetch", vi.fn(async () => failed ? { ok: false, json: async () => ({ success: false, error: "Registry unavailable" }) } : response(registry())));
	const { container } = render(<PackageResourceSettings cwd="/workspace" item={item} extensions={[extension]} />);
	await screen.findByTitle("Project settings");
	failed = true; fireEvent(window, new Event(RESOURCE_CHANGE_EVENT));
	await waitFor(() => expect(container.querySelector("iframe")).toBeNull());
});

it.each(["disabled", "uninstalled"] as const)("revokes an active %s package's settings and pending actions while another package stays mounted", async kind => {
	const siblingItem = { ...item, source: "npm:sibling", installedPath: "/workspace/sibling" };
	const sibling = { ...member, id: "sibling", source: siblingItem.source };
	const siblingExtension = { ...extension, path: "/workspace/sibling/index.ts", sourceInfo: { ...extension.sourceInfo, source: siblingItem.source } };
	const siblingView = { ...settings, id: "project:sibling:settings", resourceId: sibling.id, title: "Sibling settings", url: "/api/resources/views/sibling/assets/index.html" };
	let catalog = registry([settings, siblingView], [member, sibling]);
	const action = pending<unknown>(); let actionSignal: AbortSignal | undefined;
	vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") { actionSignal = init.signal as AbortSignal; return action.promise; }
		return Promise.resolve(response(catalog));
	}));
	render(<><PackageResourceSettings cwd="/workspace" item={item} extensions={[extension]} />
		<PackageResourceSettings cwd="/workspace" item={siblingItem} extensions={[siblingExtension]} /></>);
	const removed = await screen.findByTitle("Project settings") as HTMLIFrameElement;
	const kept = await screen.findByTitle("Sibling settings");
	const source = removed.contentWindow!; const post = await ready(removed);
	const token = (post.mock.calls.find(([message]) => (message as { type?: string }).type === "context")![0] as { token: string }).token;
	fireEvent(window, new MessageEvent("message", { source, data: { channel: RESOURCE_FRAME_CHANNEL, type: "invoke", token, id: "removed-action", name: "state", args: {} } }));
	await waitFor(() => expect(actionSignal).toBeDefined());
	catalog = registry([siblingView], kind === "disabled" ? [{ ...member, enabled: false }, sibling] : [sibling]);
	fireEvent(window, new Event(RESOURCE_CHANGE_EVENT));
	await waitFor(() => expect(screen.queryByTitle("Project settings")).toBeNull());
	expect(actionSignal!.aborted).toBe(true); expect(screen.getByTitle("Sibling settings")).toBe(kept);
	await act(async () => action.resolve(response({ changed: true })));
	expect(post.mock.calls.some(([message]) => (message as { id?: string }).id === "removed-action")).toBe(false);
});
