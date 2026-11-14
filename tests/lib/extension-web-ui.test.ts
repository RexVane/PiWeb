import { describe, expect, it, vi } from "vitest";
import { createExtensionUiBridge, isUiTree, sanitizeUiTree } from "@/lib/extension-ui";
import type { WebEvent, WebUiNode } from "@/lib/types";

const bridge = (opts: { hasViewers?: boolean } = {}) => {
	const events: WebEvent[] = [];
	const instance = createExtensionUiBridge({ publish: (evt) => events.push(evt), hasViewers: () => opts.hasViewers ?? true });
	return { instance, events };
};

type WebUi = { web: (tree: unknown, opts?: Record<string, unknown>) => Promise<unknown>; custom: (component: unknown, opts?: Record<string, unknown>) => Promise<unknown> };
const uiOf = (instance: { uiContext: Record<string, unknown> }) => instance.uiContext as unknown as WebUi;

const lastUi = (events: WebEvent[]) => {
	const ui = events.filter((evt): evt is Extract<WebEvent, { type: "extension_ui" }> => evt.type === "extension_ui");
	return ui[ui.length - 1];
};

describe("sanitizeUiTree", () => {
	it("keeps whitelisted nodes and drops unknown ones", () => {
		const tree = sanitizeUiTree({ type: "box", direction: "row", children: [{ type: "text", text: "hi", tone: "danger", mono: true }, { type: "iframe", src: "x" }] });
		expect(tree).toEqual({ type: "box", direction: "row", gap: 8, children: [{ type: "text", text: "hi", tone: "danger", mono: true }] });
	});

	it("clips oversized text, lists and tables", () => {
		const tree = sanitizeUiTree({
			type: "list",
			items: Array.from({ length: 500 }, (_, i) => ({ label: `item-${i}`, description: "d".repeat(999) })),
		}) as Extract<WebUiNode, { type: "list" }>;
		expect(tree.items).toHaveLength(200);
		expect(tree.items[0].description!.length).toBe(800);
		const long = sanitizeUiTree({ type: "text", text: "x".repeat(9000) }) as Extract<WebUiNode, { type: "text" }>;
		expect(long.text).toHaveLength(4000);
		const table = sanitizeUiTree({ type: "table", columns: ["a", "b"], rows: Array.from({ length: 500 }, () => ["1", "2"]) }) as Extract<WebUiNode, { type: "table" }>;
		expect(table.rows).toHaveLength(200);
	});

	it("rejects non-objects and unknown roots", () => {
		expect(sanitizeUiTree(null)).toBeUndefined();
		expect(sanitizeUiTree("text")).toBeUndefined();
		expect(sanitizeUiTree({ type: "video" })).toBeUndefined();
		expect(isUiTree({ type: "progress", value: 0.5 })).toBe(true);
		expect(isUiTree({ render: () => [] })).toBe(false);
	});
});

describe("extension web UI bridge", () => {
	it("publishes a sanitized tree and resolves with the parsed answer", async () => {
		const { instance, events } = bridge();
		const pending = uiOf(instance).web({ type: "text", text: "hello" }, { title: "Panel" }) as Promise<{ action?: string } | undefined>;
		const event = lastUi(events);
		expect(event.method).toBe("web");
		expect(event.title).toBe("Panel");
		expect(event.tree).toEqual({ type: "text", text: "hello" });
		expect(instance.respond(event.id, { value: JSON.stringify({ action: "run" }) })).toBe(true);
		await expect(pending).resolves.toEqual({ action: "run" });
	});

	it("treats a plain string answer as the action", async () => {
		const { instance, events } = bridge();
		const pending = uiOf(instance).web({ type: "text", text: "x" }) as Promise<{ action?: string } | undefined>;
		instance.respond(lastUi(events).id, { value: "approve" });
		await expect(pending).resolves.toEqual({ action: "approve" });
	});

	it("resolves undefined when the user cancels", async () => {
		const { instance, events } = bridge();
		const pending = uiOf(instance).web({ type: "text", text: "x" });
		instance.respond(lastUi(events).id, { cancelled: true });
		await expect(pending).resolves.toBeUndefined();
	});

	it("renders a terminal component as read-only text instead of staying silent", async () => {
		const { instance, events } = bridge();
		const component = { render: () => ["Tasks 1/3", "────────"] };
		const pending = uiOf(instance).custom(component, { title: "Todo" }) as Promise<unknown>;
		await vi.waitFor(() => expect(lastUi(events)).toBeDefined());
		const event = lastUi(events);
		expect(event.method).toBe("web");
		expect(event.tree).toEqual({ type: "code", text: "Tasks 1/3\n────────" });
		instance.respond(event.id, { cancelled: true });
		await expect(pending).resolves.toBeUndefined();
	});

	it("accepts a UI tree passed to custom()", async () => {
		const { instance, events } = bridge();
		const pending = uiOf(instance).custom({ type: "progress", value: 0.5, label: "half" }) as Promise<unknown>;
		expect(lastUi(events).tree).toEqual({ type: "progress", value: 0.5, label: "half" });
		instance.respond(lastUi(events).id, { value: JSON.stringify({ action: "ok" }) });
		await expect(pending).resolves.toEqual({ action: "ok" });
	});

	it("waits through a temporary viewer disconnect and can be cancelled", async () => {
		const { instance } = bridge({ hasViewers: false });
		const controller = new AbortController();
		const pending = uiOf(instance).web({ type: "text", text: "x" }, { signal: controller.signal });
		expect(instance.getPendingRequests()).toHaveLength(1);
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(instance.getPendingRequests()).toHaveLength(0);
	});

	it("ignores custom() payloads that are neither a tree nor a component", async () => {
		const { instance, events } = bridge();
		await expect(uiOf(instance).custom(42)).resolves.toBeUndefined();
		await expect(uiOf(instance).custom({ nope: true })).resolves.toBeUndefined();
		expect(events).toHaveLength(0);
	});
});

describe("sanitize keeps nested depth bounded", () => {
	it("drops nodes past the depth limit", () => {
		let node: Record<string, unknown> = { type: "text", text: "deep" };
		for (let i = 0; i < 20; i += 1) node = { type: "box", children: [node] };
		const tree = sanitizeUiTree(node) as Extract<WebUiNode, { type: "box" }>;
		let depth = 0;
		let cursor: WebUiNode | undefined = tree;
		while (cursor && cursor.type === "box") {
			depth += 1;
			cursor = cursor.children[0];
		}
		expect(depth).toBeLessThanOrEqual(10);
		expect(cursor).toBeUndefined();
	});
});
