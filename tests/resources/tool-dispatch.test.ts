import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recycleFixture } from "../fixtures/recycle";
import type { ResourceUiApi } from "../../src/lib/resources/protocol";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

vi.mock("../../src/lib/growth-tracker", () => ({ GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));
let root: string;
let cwd: string;
let manager: typeof import("../../src/lib/agent-manager");
const managed: ReturnType<typeof import("../../src/lib/agent-manager")["getManaged"]>[] = [];
const probe = () => (globalThis as any).__piwebResourceDispatchProbe as Array<Record<string, unknown>>;

beforeAll(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-resource-dispatch-")));
	cwd = path.join(root, "workspace"); const agentDir = path.join(root, "agent");
	await fs.mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true }); await fs.mkdir(agentDir);
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", compaction: { enabled: false } }));
	await fs.writeFile(path.join(cwd, ".pi", "extensions", "dispatch-probe.js"), `export default function(pi) {
		const record = (value) => (globalThis.__piwebResourceDispatchProbe ??= []).push(value);
		const parameters = { type: "object", properties: { text: { type: "string" }, deny: { type: "boolean" }, ask: { type: "boolean" }, holdPermission: { type: "boolean" }, holdResult: { type: "boolean" } }, required: ["text"], additionalProperties: false };
		pi.registerTool({ name: "resource_probe", label: "Resource probe", description: "Offline read-only probe", annotations: { readOnlyHint: true }, parameters,
			execute: async (id, args, signal, update, ctx) => {
				const sessionId = ctx.sessionManager.getSessionId(); record({ kind: "execute", id, text: args.text, sessionId });
				if (args.holdResult) await new Promise(release => record({ kind: "result-pending", release }));
				update?.({ content: [{ type: "text", text: "progress" }], details: {} });
				return { content: [{ type: "text", text: args.text }], details: { sessionId } };
			} });
		pi.registerTool({ name: "resource_nested", label: "Nested resource probe", description: "Offline read-only nested probe", annotations: { readOnlyHint: true }, parameters,
			execute: async (_id, args, signal, _update, ctx) => { const outcome = await ctx.executeTool("resource_probe", args, { signal }); return { ...outcome.result, isError: outcome.isError }; } });
		const executeLeaf = async (id, args, signal) => {
			record({ kind: "leaf-start", id, text: args.text });
			try {
				await new Promise((resolve, reject) => {
					const onAbort = () => { clearTimeout(timer); reject(new Error("leaf probe cancelled")); };
					const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 100);
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				});
				return { content: [{ type: "text", text: args.text }], details: {} };
			} finally { record({ kind: "leaf-end", id, text: args.text }); }
		};
		for (const [name, executionMode] of [["resource_serial_leaf", "sequential"], ["resource_parallel_leaf", "parallel"]]) {
			pi.registerTool({ name, label: "Resource leaf", description: "Offline read-only ordering probe", annotations: { readOnlyHint: true }, parameters, executionMode, execute: executeLeaf });
		}
		pi.registerTool({ name: "resource_recursive_leaf", label: "Recursive resource leaf", description: "Offline read-only recursive ordering probe", annotations: { readOnlyHint: true }, parameters, executionMode: "sequential",
			execute: async (_id, args, signal, _update, ctx) => { const outcome = await ctx.executeTool("resource_serial_leaf", args, { signal }); return { ...outcome.result, isError: outcome.isError }; } });
		pi.registerTool({ name: "resource_fanout", label: "Resource fanout", description: "Offline read-only concurrent ordering probe", annotations: { readOnlyHint: true },
			parameters: { ...parameters, properties: { ...parameters.properties, leaf: { type: "string", enum: ["resource_serial_leaf", "resource_parallel_leaf", "resource_recursive_leaf"] } } },
			execute: async (_id, args, signal, _update, ctx) => {
				const outcomes = await Promise.all([ctx.executeTool(args.leaf ?? "resource_serial_leaf", { text: args.text + ":a" }, { signal }), ctx.executeTool(args.leaf ?? "resource_serial_leaf", { text: args.text + ":b" }, { signal })]);
				return { content: [{ type: "text", text: "fanout finished" }], details: {}, isError: outcomes.some(outcome => outcome.isError) };
			} });
		pi.registerTool({ name: "resource_capture_ui", label: "Capture resource UI", description: "Offline read-only UI lifetime probe", annotations: { readOnlyHint: true }, parameters,
			execute: async (_id, _args, _signal, _update, ctx) => { const ui = ctx.ui; record({ kind: "captured-ui", ui, notify: ui.notify }); return { content: [], details: {} }; } });
		pi.on("tool_call", async (event, ctx) => {
			if (!event.toolName.startsWith("resource_")) return;
			record({ kind: "call", name: event.toolName, id: event.toolCallId, parentId: event.parentToolCallId, sessionId: ctx.sessionManager.getSessionId() });
			if (event.toolName === "resource_probe" && event.input.deny) return { block: true, reason: "probe permission refused", terminate: true };
			if (event.toolName === "resource_probe" && event.input.ask && !await ctx.ui.confirm("Resource probe permission", "Allow this exact probe?", { signal: ctx.signal })) return { block: true, reason: "probe confirmation cancelled" };
			if (event.toolName === "resource_probe" && event.input.holdPermission) await new Promise(release => record({ kind: "permission-pending", release }));
		});
		pi.on("tool_result", (event) => { if (event.toolName === "resource_probe") {
			if (event.input.holdResult) record({ kind: "after-result", id: event.toolCallId });
			return { content: [{ type: "text", text: "after:" + event.input.text }] };
		} });
	}`);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir); vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("__piwebResourceDispatchProbe", []);
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in resource SDK regression"); }));
	vi.resetModules(); manager = await import("../../src/lib/agent-manager");
}, 90_000);
afterAll(async () => {
	await Promise.all(managed.map(m => manager.disposeSession(m)));
	vi.unstubAllGlobals(); vi.unstubAllEnvs(); await recycleFixture(root);
});
async function create() {
	const { sessionPath } = await manager.createNewSession(cwd); const m = manager.getManaged(sessionPath); managed.push(m);
	m.viewerAvailable = () => true;
	const session = await manager.ensureSession(m);
	const api = () => (session.extensionRunner.createContext().ui as unknown as { resources: ResourceUiApi }).resources;
	return { m, session, api };
}
describe("public resource tool execution in a real empty SDK session", () => {
	it("validates arguments, runs real hooks and emits progress without adding model messages", async () => {
		const { m, session, api } = await create(); const before = session.messages.slice(); const offset = probe().length;
		const invalid = await api().executeTool!("resource_probe", {});
		expect(invalid.isError).toBe(true); expect(probe().slice(offset)).toEqual([]);
		const result = await api().executeTool!("resource_probe", { text: "user action" });
		expect(result).toMatchObject({ isError: false, result: { content: [{ type: "text", text: "after:user action" }] } });
		expect(probe().slice(offset).map(item => item.kind)).toEqual(["call", "execute"]);
		expect(session.messages).toEqual(before); expect(before).toEqual([]);
		const events = m.buffer.map(frame => JSON.parse(frame.json));
		expect(events.some(event => event.type === "traj" && JSON.stringify(event).includes("resource_probe"))).toBe(true);
		expect(probe().at(-1)?.id).toMatch(/^piweb-resource-/);
	});
	it("blocks the original name in tool_call before its implementation executes", async () => {
		const { api } = await create(); const offset = probe().length;
		const result = await api().executeTool!("resource_probe", { text: "refused", deny: true });
		expect(result.isError).toBe(true); expect(result.result).toMatchObject({ terminate: true });
		expect(JSON.stringify(result)).toContain("probe permission refused");
		expect(probe().slice(offset).map(item => item.kind)).toEqual(["call"]);
	});
	it("routes nested tools through the same validation and permissions in an empty chat", async () => {
		const { api, session } = await create(); const offset = probe().length;
		expect((await api().executeTool!("resource_nested", { text: "nested" })).isError).toBe(false);
		const calls = probe().slice(offset).filter(item => item.kind === "call");
		expect(calls.map(item => item.name)).toEqual(["resource_nested", "resource_probe"]);
		expect(calls[1].parentId).toBe(calls[0].id); expect(session.messages).toEqual([]);
		const refusedOffset = probe().length;
		expect((await api().executeTool!("resource_nested", { text: "denied child", deny: true })).isError).toBe(true);
		expect(probe().slice(refusedOffset).some(item => item.kind === "execute")).toBe(false);
	});
	it.each([["parallel", "resource_serial_leaf"], ["sequential", "resource_parallel_leaf"]] as const)("serializes simultaneous nested calls with %s session execution and %s", async (mode, leaf) => {
		const { api, session } = await create(); const offset = probe().length;
		session.agent.toolExecution = mode;
		expect((await api().executeTool!("resource_fanout", { text: mode, leaf })).isError).toBe(false);
		const records = probe().slice(offset);
		expect(records.filter(item => item.kind === "leaf-start" || item.kind === "leaf-end").map(item => item.kind)).toEqual(["leaf-start", "leaf-end", "leaf-start", "leaf-end"]);
		const calls = records.filter(item => item.kind === "call");
		expect(calls.map(item => item.name)).toEqual(["resource_fanout", leaf, leaf]);
		expect(calls.slice(1).map(item => item.parentId)).toEqual([calls[0].id, calls[0].id]);
		expect(session.messages).toEqual([]);
	});
	it("allows queued sequential tools to await their own nested calls without deadlocking", async () => {
		const { api, session } = await create(); const offset = probe().length;
		session.agent.toolExecution = "parallel";
		expect((await api().executeTool!("resource_fanout", { text: "recursive", leaf: "resource_recursive_leaf" })).isError).toBe(false);
		const records = probe().slice(offset);
		expect(records.filter(item => item.kind === "leaf-start" || item.kind === "leaf-end").map(item => item.kind)).toEqual(["leaf-start", "leaf-end", "leaf-start", "leaf-end"]);
		const calls = records.filter(item => item.kind === "call");
		expect(calls.map(item => item.name)).toEqual(["resource_fanout", "resource_recursive_leaf", "resource_serial_leaf", "resource_recursive_leaf", "resource_serial_leaf"]);
		expect(calls[2].parentId).toBe(calls[1].id); expect(calls[4].parentId).toBe(calls[3].id);
		expect(session.messages).toEqual([]);
	});
	it("cancels a queued nested call before execution and releases the queue for later work", async () => {
		const { api, session } = await create(); const controller = new AbortController(); const offset = probe().length;
		session.agent.toolExecution = "parallel";
		const pending = api().executeTool!("resource_fanout", { text: "cancel queued" }, { signal: controller.signal });
		const rejected = expect(pending).rejects.toThrow(/cancelled|replaced/i);
		await vi.waitFor(() => expect(probe().slice(offset).filter(item => item.kind === "leaf-start")).toHaveLength(1), { interval: 5 });
		controller.abort(); await rejected;
		expect(probe().slice(offset).filter(item => item.kind === "leaf-start").map(item => item.text)).toEqual(["cancel queued:a"]);
		expect((await api().executeTool!("resource_fanout", { text: "after cancellation" })).isError).toBe(false);
		expect(session.messages).toEqual([]);
	});
	it("keeps ordinary tool contexts on the SDK path after queued resource work", async () => {
		const { api, session } = await create();
		expect((await api().executeTool!("resource_fanout", { text: "resource operation" })).isError).toBe(false);
		const offset = probe().length;
		const context = session.extensionRunner.createToolContext("model-call", new AbortController().signal);
		expect(context.signal).toBeUndefined();
		const result = await context.executeTool("resource_probe", { text: "ordinary SDK operation" });
		expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("No assistant message issued this call");
		expect(probe().slice(offset)).toEqual([]); expect(session.messages).toEqual([]);
	});
	it("rechecks the generation after a waiting permission hook before executing", async () => {
		const { api, m, session } = await create(); const offset = probe().length;
		const pending = api().executeTool!("resource_probe", { text: "late permission", holdPermission: true });
		const rejected = expect(pending).rejects.toThrow(/cancelled|replaced/i);
		await vi.waitFor(() => expect(probe().slice(offset).some(item => item.kind === "permission-pending")).toBe(true));
		try {
			m.resourceReloading = true;
			(probe().slice(offset).find(item => item.kind === "permission-pending")!.release as () => void)();
			await rejected;
			expect(probe().slice(offset).some(item => item.kind === "execute")).toBe(false);
			expect(session.messages).toEqual([]);
		} finally { m.resourceReloading = false; }
	});
	it("does not deliver a slow old-generation result to the replacement runner's hooks", async () => {
		const { api, session } = await create(); const offset = probe().length;
		const pending = api().executeTool!("resource_probe", { text: "old result", holdResult: true });
		const rejected = expect(pending).rejects.toThrow(/cancelled|replaced/i);
		await vi.waitFor(() => expect(probe().slice(offset).some(item => item.kind === "result-pending")).toBe(true));
		try { await session.reload(); }
		finally { (probe().slice(offset).find(item => item.kind === "result-pending")!.release as () => void)(); }
		await rejected;
		expect(probe().slice(offset).some(item => item.kind === "after-result")).toBe(false);
		expect((await api().executeTool!("resource_probe", { text: "fresh result" })).isError).toBe(false);
		expect(session.messages).toEqual([]);
	});
	it("revokes stored UI side effects and resource capabilities when their operation ends", async () => {
		const { api, m } = await create(); const offset = probe().length;
		expect((await api().executeTool!("resource_capture_ui", { text: "capture" })).isError).toBe(false);
		const captured = probe().slice(offset).find(item => item.kind === "captured-ui")!;
		const ui = captured.ui as ExtensionUIContext & { resources: ResourceUiApi };
		expect(() => ui.notify("late notification")).toThrow(/cancelled|replaced/i);
		expect(() => (captured.notify as Function)("saved late notification")).toThrow(/cancelled|replaced/i);
		expect(() => ui.setStatus("late-status", "late")).toThrow(/cancelled|replaced/i);
		expect(() => ui.setWidget("late-widget", ["late"])).toThrow(/cancelled|replaced/i);
		expect(() => ui.setEditorText("late editor")).toThrow(/cancelled|replaced/i);
		await expect(Promise.resolve().then(() => ui.resources.invoke("missing-test-resource", "late"))).rejects.toThrow(/cancelled|replaced/i);
		await expect(Promise.resolve().then(() => ui.resources.executeTool!("resource_probe", { text: "late child" }))).rejects.toThrow(/cancelled|replaced/i);
		expect(await ui.resources.request("missing-test-resource", "main", null)).toEqual({ status: "cancelled" });
		expect(m.ui!.getPendingRequests()).toEqual([]);
		expect(probe().slice(offset).some(item => item.kind === "execute")).toBe(false);
	});
	it("cancels only the owning permission request and never treats a late answer as approval", async () => {
		const a = await create(); const b = await create(); const controller = new AbortController(); const offset = probe().length;
		const pending = a.api().executeTool!("resource_probe", { text: "must not run", ask: true }, { signal: controller.signal });
		const rejected = expect(pending).rejects.toThrow(/cancelled|replaced/i);
		await vi.waitFor(() => expect(a.m.ui?.getPendingRequests()).toHaveLength(1));
		const requestId = a.m.ui!.getPendingRequests()[0].id;
		controller.abort(); await rejected;
		expect(a.m.ui!.respond(requestId, { confirmed: true })).toBe(false);
		expect(probe().slice(offset).some(item => item.kind === "execute")).toBe(false);
		expect((await b.api().executeTool!("resource_probe", { text: "B alive" })).isError).toBe(false);
	});
	it("revokes saved capabilities on reload and disposal while preserving the other same-cwd chat", async () => {
		const a = await create(); const b = await create(); const old = a.api();
		await a.session.reload();
		await expect(old.executeTool!("resource_probe", { text: "old generation" })).rejects.toThrow(/generation|unavailable/i);
		expect((await a.api().executeTool!("resource_probe", { text: "fresh generation" })).isError).toBe(false);
		const disposed = a.api(); await manager.disposeSession(a.m);
		await expect(disposed.executeTool!("resource_probe", { text: "disposed" })).rejects.toThrow(/unavailable/i);
		expect((await b.api().executeTool!("resource_probe", { text: "still B" })).isError).toBe(false);
	});
});
