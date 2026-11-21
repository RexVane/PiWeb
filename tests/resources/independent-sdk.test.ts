import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebEvent } from "../../src/lib/types";
import { recycleGeneratedFixture } from "../fixtures/system-trash";

vi.mock("../../src/lib/growth-tracker", () => ({ GROWTH_TRACKER_VERSION: 1, createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }) }));
let root: string;
let cwd: string;
let manager: typeof import("../../src/lib/agent-manager");
let pi: typeof import("../../src/lib/pi");
let host: typeof import("../../src/lib/resources/host");
const sessions: Array<ReturnType<typeof import("../../src/lib/agent-manager")["getManaged"]>> = [];
let questionRoot: string;
let serviceRoot: string;

async function createQuestionFixture(directory: string) {
	await fs.mkdir(path.join(directory, "src"), { recursive: true }); await fs.mkdir(path.join(directory, "web"));
	await fs.writeFile(path.join(directory, "web/index.html"), "<!doctype html><p>Independent question view</p>");
	await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "fixture-ask-user", type: "module", pi: { extensions: ["src/index.ts"] },
		piweb: { apiVersion: 1, id: "@rexvane/piweb-ask-user", views: [{ id: "questions", entry: "web/index.html", placement: "aboveEditor" }] } }));
	await fs.writeFile(path.join(directory, "src/index.ts"), 'import { Type } from "typebox"; export default function(pi) { pi.registerTool({ name: "ask_user_question", label: "Question fixture", description: "Independent question fixture", parameters: Type.Object({ questions: Type.Array(Type.Any()) }), async execute(_id, args, _signal, _update, ctx) { const result = await ctx.ui.resources.request("@rexvane/piweb-ask-user", "questions", args); return { content: [{ type: "text", text: args.questions[0].question + " → " + result.value.answers[0].selected[0] }], details: result.value }; } }); }');
}

async function createServiceFixture(directory: string) {
	await fs.mkdir(path.join(directory, "src"), { recursive: true }); await fs.mkdir(path.join(directory, "web"));
	await fs.writeFile(path.join(directory, "web/index.html"), "<!doctype html><p>Independent service view</p>");
	await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "fixture-service", type: "module", pi: { extensions: ["src/index.ts"] },
		piweb: { apiVersion: 1, id: "fixture-service", host: "src/host.mjs", views: [{ id: "main", entry: "web/index.html", placement: "panel" }] } }));
	await fs.writeFile(path.join(directory, "src/index.ts"), 'import { Type } from "typebox"; export default function(pi) { pi.registerTool({ name: "resource_echo", label: "Service fixture", description: "Independent service fixture", parameters: Type.Object({ message: Type.String() }), async execute(_id, args, _signal, _update, ctx) { const result = await ctx.ui.resources.invoke("fixture-service", "echo", args); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; } }); }');
	await fs.writeFile(path.join(directory, "src/host.mjs"), 'export function activate(host) { host.actions.register("echo", (args) => args); host.services.register("worker", () => () => {}); }');
}

beforeAll(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-independent-sdk-"))); cwd = path.join(root, "workspace");
	// The optional path points directly to the standalone ask-user checkout. Host coverage always uses a local, neutral service fixture.
	questionRoot = process.env.PIWEB_TEST_RESOURCES_DIR ? path.resolve(process.env.PIWEB_TEST_RESOURCES_DIR) : path.join(root, "ask-user");
	serviceRoot = path.join(root, "service");
	if (!process.env.PIWEB_TEST_RESOURCES_DIR) await createQuestionFixture(questionRoot);
	await createServiceFixture(serviceRoot);
	await fs.mkdir(cwd); await fs.mkdir(path.join(root, "agent"));
	await fs.writeFile(path.join(root, "agent/settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent")); vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in this offline integration test"); }));
	vi.resetModules(); manager = await import("../../src/lib/agent-manager"); pi = await import("../../src/lib/pi"); host = await import("../../src/lib/resources/host");
});
afterAll(async () => {
	for (const session of sessions) await manager.disposeSession(session);
	await fs.writeFile(path.join(root, "agent/settings.json"), "{}"); await host.reconcileResourceHosts(cwd);
	await vi.waitFor(() => expect(host.resourceHostStatuses()).toEqual([]));
	vi.unstubAllGlobals(); vi.unstubAllEnvs(); await recycleGeneratedFixture(root);
});
async function fresh() { const { sessionPath } = await manager.createNewSession(cwd); const managed = manager.getManaged(sessionPath); sessions.push(managed); await manager.ensureSession(managed); return managed; }

describe("independent resources through the real Pi SDK", () => {
	it("starts without any PiWeb-specific tool or injected tool description when no resource is installed", async () => {
		const managed = await fresh();
		expect(managed.session!.getAllTools().map((tool) => tool.name)).not.toContain("ask_user_question");
		expect(managed.session!.getAllTools().map((tool) => tool.name)).not.toContain("resource_echo");
		expect(managed.session!.systemPrompt).not.toContain("Ask the user 1–4 multiple-choice");
	});
	it("loads the external question tool without an SDK override and sends a generic resource request", async () => {
		await fs.access(path.join(questionRoot, "src/index.ts"));
		await fs.writeFile(path.join(root, "agent/settings.json"), JSON.stringify({ packages: [questionRoot] }));
		await pi.reloadAllLoaders();
		const managed = await fresh();
		const tool = managed.session!.agent.state.tools.find((tool) => tool.name === "ask_user_question")!;
		expect(tool).toBeTruthy();
		const result = tool.execute("question-call", { questions: [{ question: "Choose?", header: "Scope", options: [{ label: "A" }, { label: "B" }] }] }, new AbortController().signal);
		await vi.waitFor(() => expect(managed.ui!.getPendingRequests()).toHaveLength(1));
		const request = managed.ui!.getPendingRequests()[0];
		expect(request).toMatchObject({ method: "resource", resourceView: { resourceId: "@rexvane/piweb-ask-user", placement: "aboveEditor" } });
		managed.ui!.respond(request.id, { value: '{"answers":[{"selected":["A"]}]}' });
		expect((await result).content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Choose? → A") });
		const source = managed.session!.getAllTools().find((tool) => tool.name === "ask_user_question")?.sourceInfo;
		expect(source?.source).not.toBe("sdk");
	});
	it("loads an independently authored service tool and host through the public path", async () => {
		await fs.writeFile(path.join(root, "agent/settings.json"), JSON.stringify({ packages: [serviceRoot] }));
		await pi.reloadAllLoaders(); await host.reconcileResourceHosts(cwd);
		const managed = await fresh();
		const tool = managed.session!.agent.state.tools.find((tool) => tool.name === "resource_echo")!;
		expect(tool).toBeTruthy();
		const result = await tool.execute("service-call", { message: "Independent value" }, new AbortController().signal);
		expect(result.content[0]).toMatchObject({ type: "text", text: JSON.stringify({ message: "Independent value" }) });
		expect(host.resourceHostStatuses()).toMatchObject([{ id: "fixture-service", services: ["worker"] }]);
		const frames = managed.buffer.map((frame) => JSON.parse(frame.json) as WebEvent);
		expect(frames.some((frame) => frame.type === "error" && /activation failed/.test(frame.message))).toBe(false);
	});
});
