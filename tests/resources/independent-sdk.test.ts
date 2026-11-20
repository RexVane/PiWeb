import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebEvent } from "../../src/lib/types";

vi.mock("../../src/lib/growth-tracker", () => ({ GROWTH_TRACKER_VERSION: 1, createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }) }));
let root: string;
let cwd: string;
let manager: typeof import("../../src/lib/agent-manager");
let pi: typeof import("../../src/lib/pi");
let host: typeof import("../../src/lib/resources/host");
const sessions: Array<ReturnType<typeof import("../../src/lib/agent-manager")["getManaged"]>> = [];
let packageRoot: string;

async function createFixtures(directory: string) {
	for (const name of ["ask-user", "automations"]) {
		const root = path.join(directory, name);
		await fs.mkdir(path.join(root, "src"), { recursive: true }); await fs.mkdir(path.join(root, "web"));
		const id = name === "ask-user" ? "@rexvane/piweb-ask-user" : "@rexvane/piweb-automations";
		await fs.writeFile(path.join(root, "web/index.html"), "<!doctype html><p>Independent test view</p>");
		await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: `fixture-${name}`, type: "module", pi: { extensions: ["src/index.ts"] },
			piweb: { apiVersion: 1, id, ...(name === "automations" ? { host: "dist/host.mjs" } : {}), views: [{ id: name === "ask-user" ? "questions" : "tasks", entry: "web/index.html", placement: name === "ask-user" ? "aboveEditor" : "panel" }] } }));
		const question = `import { Type } from "typebox"; export default function(pi) { pi.registerTool({ name: "ask_user_question", label: "Question fixture", description: "Independent question fixture", parameters: Type.Object({ questions: Type.Array(Type.Any()) }), async execute(_id, args, _signal, _update, ctx) { const result = await ctx.ui.resources.request("${id}", "questions", args); return { content: [{ type: "text", text: args.questions[0].question + " → " + result.value.answers[0].selected[0] }], details: result.value }; } }); }`;
		const automation = `import { Type } from "typebox"; export default function(pi) { pi.registerTool({ name: "manage_automation", label: "Automation fixture", description: "Independent automation fixture", parameters: Type.Any(), async execute(_id, args, _signal, _update, ctx) { const result = await ctx.ui.resources.invoke("${id}", "create", args); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; } }); }`;
		await fs.writeFile(path.join(root, "src/index.ts"), name === "ask-user" ? question : automation);
		if (name === "automations") { await fs.mkdir(path.join(root, "dist")); await fs.writeFile(path.join(root, "dist/host.mjs"), 'export function activate(host) { host.actions.register("create", (args) => args); host.services.register("scheduler", () => () => {}); }'); }
	}
}

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-independent-sdk-")); cwd = path.join(root, "workspace");
	// CI exercises self-contained, independently authored fixtures. The same contract test can verify the separate real resource checkout without copying its code into PiWeb.
	packageRoot = process.env.PIWEB_TEST_RESOURCES_DIR || path.join(root, "packages");
	if (!process.env.PIWEB_TEST_RESOURCES_DIR) await createFixtures(packageRoot);
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
	vi.unstubAllGlobals(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true });
});
async function fresh() { const { sessionPath } = await manager.createNewSession(cwd); const managed = manager.getManaged(sessionPath); sessions.push(managed); await manager.ensureSession(managed); return managed; }

describe("independent resources through the real Pi SDK", () => {
	it("starts without any PiWeb-specific tool or injected tool description when no resource is installed", async () => {
		const managed = await fresh();
		expect(managed.session!.getAllTools().map((tool) => tool.name)).not.toContain("ask_user_question");
		expect(managed.session!.getAllTools().map((tool) => tool.name)).not.toContain("manage_automation");
		expect(managed.session!.systemPrompt).not.toContain("Ask the user 1–4 multiple-choice");
	});
	it("loads the external question tool without an SDK override and sends a generic resource request", async () => {
		await fs.access(path.join(packageRoot, "ask-user/src/index.ts"));
		await fs.writeFile(path.join(root, "agent/settings.json"), JSON.stringify({ packages: [path.join(packageRoot, "ask-user")] }));
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
	it("loads an external automation tool and host through the same public path", async () => {
		await fs.access(path.join(packageRoot, "automations/dist/host.mjs"));
		await fs.writeFile(path.join(root, "agent/settings.json"), JSON.stringify({ packages: [path.join(packageRoot, "automations")] }));
		await pi.reloadAllLoaders(); await host.reconcileResourceHosts(cwd);
		const managed = await fresh();
		const tool = managed.session!.agent.state.tools.find((tool) => tool.name === "manage_automation")!;
		const result = await tool.execute("automation-call", { action: "create", name: "Independent task", prompt: "Check status", enabled: false, schedule: { kind: "daily", time: "09:00" } }, new AbortController().signal);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Independent task") });
		expect(host.resourceHostStatuses()).toMatchObject([{ id: "@rexvane/piweb-automations", services: ["scheduler"] }]);
		const frames = managed.buffer.map((frame) => JSON.parse(frame.json) as WebEvent);
		expect(frames.some((frame) => frame.type === "error" && /activation failed/.test(frame.message))).toBe(false);
	});
});
