// @vitest-environment jsdom
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	window.dispatchEvent(new Event("pagehide")); document.body.replaceChildren();
	vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function client() {
	document.body.innerHTML = '<main id="content"></main>'; document.body.style.margin = "0";
	const dom = { window };
	const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
	let changed: (() => void) | undefined;
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: () => void) { changed = callback; }
		observe() {}
		disconnect() {}
	});
	new Function(await fs.readFile(path.resolve("public/resources/client.js"), "utf8"))();
	const api = (dom.window as unknown as { piwebResource: {
		focusRequestSupported: boolean; requestFocus(): Promise<boolean>; observeSize(element: Element): () => void;
	} }).piwebResource;
	const receive = (data: Record<string, unknown>) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: dom.window, data: { channel: "piweb-resource/v1", ...data } }));
	const connect = (supported = false) => receive({ type: "context", token: "test-token", context: { viewId: "view", resourceId: "extension", scope: "user", cwd: "/workspace", ...(supported ? { focusRequestSupported: true } : {}) } });
	return { dom, api, post, receive, connect, changed: () => changed?.() };
}

describe("public resource browser client", () => {
	it("returns false immediately when an older host does not support focus requests", async () => {
		const { api, post, connect } = await client();
		expect(await api.requestFocus()).toBe(false);
		connect();
		expect(api.focusRequestSupported).toBe(false);
		expect(await api.requestFocus()).toBe(false);
		expect(post.mock.calls.some(([message]) => message.type === "focus")).toBe(false);
	});
	it("resolves a focus grant only from the matching token and request", async () => {
		const { api, post, receive, connect } = await client();
		connect(true);
		const pending = api.requestFocus();
		const request = post.mock.calls.find(([message]) => message.type === "focus")![0];
		let resolved = false; void pending.then(() => { resolved = true; });
		receive({ type: "result", token: "wrong", id: request.id, value: true });
		await Promise.resolve(); expect(resolved).toBe(false);
		receive({ type: "result", token: "test-token", id: request.id, value: true });
		expect(await pending).toBe(true);
	});
	it("resolves refused or abandoned focus requests to false", async () => {
		const { dom, api, post, receive, connect } = await client();
		connect(true);
		const refused = api.requestFocus();
		const request = post.mock.calls.find(([message]) => message.type === "focus")![0];
		receive({ type: "result", token: "test-token", id: request.id, value: false });
		expect(await refused).toBe(false);
		const abandoned = api.requestFocus();
		dom.window.dispatchEvent(new dom.window.Event("pagehide"));
		expect(await abandoned).toBe(false);
	});
	it("measures the selected content root and shrinks without reporting the iframe viewport", async () => {
		const { dom, api, post, connect, changed } = await client();
		const content = dom.window.document.getElementById("content")!;
		let height = 240;
		content.getBoundingClientRect = () => ({ height, width: 400, x: 0, y: 0, top: 0, left: 0, right: 400, bottom: height, toJSON() {} });
		Object.defineProperty(dom.window.document.documentElement, "scrollHeight", { value: 1000 });
		api.observeSize(content); connect();
		expect(post.mock.calls.filter(([message]) => message.type === "resize").at(-1)![0].height).toBe(240);
		height = 110; changed();
		expect(post.mock.calls.filter(([message]) => message.type === "resize").at(-1)![0].height).toBe(110);
		const count = post.mock.calls.length; changed(); expect(post.mock.calls).toHaveLength(count);
	});
});
