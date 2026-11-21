import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Managed } from "@/lib/agent-manager";
import { recycleGeneratedFixture } from "../fixtures/system-trash";
import { createVerificationProviderFixture, verificationModel, verificationProvider } from "../fixtures/verification-provider.js";
import { resolveHostSdkPackage } from "../fixtures/verification-provider.mjs";

// Growth sampling is unrelated to resource loading, SDK tool execution or persistence.
vi.mock("@/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

const sha = process.env.PIWEB_TEST_ASK_USER_SHA!;
const source = `git:github.com/RexVane/piweb-ask-user@${sha}`;
const resourceId = "@rexvane/piweb-ask-user";
const toolName = "ask_user_question";
const viewMethods = ["select", "confirm", "input", "editor"];
const promptSnippet = "Ask the user multiple-choice questions in an interactive window when a decision is genuinely theirs";
const promptGuidelines = [
	"Use ask_user_question for decisions genuinely belonging to the user, not facts available from code or routine permission to continue.",
	"When using ask_user_question, put the recommended option first, explain each trade-off, and allow free text without adding an Other option.",
	"Never treat a skipped, timed-out or unavailable ask_user_question request as an answer or approval.",
];
const independentInstructions = "Resource lifecycle verification preserves independent user system instructions.";
const exec = promisify(execFile);
const allSessions: Managed[] = [];
let fixture: Awaited<ReturnType<typeof createVerificationProviderFixture>>;
let generatedRoot: string | undefined;
let manager: typeof import("@/lib/agent-manager");
let pi: typeof import("@/lib/pi");
let service: typeof import("@/lib/plugins-service");
let discovery: typeof import("@/lib/resources/discovery");
let host: typeof import("@/lib/resources/host");
let answeredLine: string;
let answeredText: string;

interface QuestionPayload { questions: Array<{ question: string; header: string; options: Array<{ label: string }>; multiSelect?: boolean }> }
interface ToolResultMessage { role: string; toolName?: string; toolCallId?: string; content?: Array<{ type: string; text?: string }>; details?: { questions?: unknown; outcome?: { status: string; answers?: unknown } } }
interface PersistedEntry { type: string; message?: ToolResultMessage }
const report: Record<string, unknown> & { stages: unknown[]; pending: unknown[]; result: string } = {
	apiVersion: 1, candidateSha: sha, source, startedAt: new Date().toISOString(), result: "not-run", stages: [], pending: [],
};

beforeAll(async () => {
	if (!/^[a-f\d]{40}$/i.test(sha)) throw new Error("GitHub acceptance requires a fixed, complete candidate SHA.");
	const hostSourceRoot = process.env.PIWEB_TEST_HOST_ROOT!;
	await fs.access(path.join(hostSourceRoot, "lib", "pi.ts"));
	generatedRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-github-resources-")));
	report.fixtureRoot = generatedRoot;
	fixture = await createVerificationProviderFixture(generatedRoot, hostSourceRoot);
	await fs.writeFile(path.join(fixture.agentDir, "APPEND_SYSTEM.md"), independentInstructions, { flag: "wx" });
	vi.stubEnv("PI_CODING_AGENT_DIR", fixture.agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.resetModules();
	manager = await import("@/lib/agent-manager");
	pi = await import("@/lib/pi");
	service = await import("@/lib/plugins-service");
	discovery = await import("@/lib/resources/discovery");
	host = await import("@/lib/resources/host");
	const hostPackage = JSON.parse(await fs.readFile(path.join(path.dirname(hostSourceRoot), "package.json"), "utf8"));
	const codingAgent = resolveHostSdkPackage(hostSourceRoot, "@earendil-works/pi-coding-agent");
	const ai = resolveHostSdkPackage(hostSourceRoot, "@earendil-works/pi-ai");
	report.host = { sourceRoot: hostSourceRoot, name: hostPackage.name, version: hostPackage.version,
		codingAgentEntry: codingAgent.entry, aiEntry: ai.entry, codingAgentVersion: codingAgent.version, aiVersion: ai.version };
});

afterAll(async () => {
	const cleanupErrors: string[] = [];
	if (manager) for (const managed of allSessions) {
		try { await manager.disposeSessionPath(managed.sessionPath); } catch (error) { cleanupErrors.push(String(error)); }
	}
	if (host && fixture) for (const cwd of fixture.workspaces) {
		try { await host.reconcileResourceHosts(cwd); } catch (error) { cleanupErrors.push(String(error)); }
	}
	vi.unstubAllEnvs();
	if (generatedRoot) {
		await recycleGeneratedFixture(generatedRoot);
		const retained = await fs.access(generatedRoot).then(() => true, () => false);
		report.cleanup = { fixture: retained ? "retained-system-trash-unavailable" : "recycled", errors: cleanupErrors };
	}
	report.completedAt = new Date().toISOString();
	if (report.result !== "passed" || cleanupErrors.length) report.result = "failed";
	if (process.env.PIWEB_TEST_GITHUB_REPORT) {
		const reportPath = path.resolve(process.env.PIWEB_TEST_GITHUB_REPORT);
		await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
		console.log(`[resources:github] evidence: ${reportPath}`);
	}
	if (cleanupErrors.length) throw new Error(cleanupErrors.join("\n"));
});

async function fresh(cwd: string) {
	const { sessionPath } = await manager.createNewSession(cwd);
	const managed = manager.getManaged(sessionPath);
	allSessions.push(managed);
	await manager.ensureSession(managed);
	expect(managed.session!.model).toMatchObject({ provider: verificationProvider, id: verificationModel });
	return managed;
}

function expectContributions(managed: Managed, enabled: boolean) {
	const session = managed.session!;
	const available = session.getAllTools().map((tool) => tool.name);
	const active = session.getActiveToolNames();
	expect(available.includes(toolName)).toBe(enabled);
	expect(active.includes(toolName)).toBe(enabled);
	for (const contribution of [promptSnippet, ...promptGuidelines]) expect(session.systemPrompt.includes(contribution)).toBe(enabled);
	if (!enabled) expect(session.systemPrompt).not.toContain(toolName);
	expect(session.systemPrompt).toContain(independentInstructions);
	expect(active).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
	expect(managed.resourceReloadPending).toBe(false);
	expect(managed.resourceReloading).toBe(false);
}

async function stage(name: string, enabled: boolean, idleSessions: Managed[], configured: boolean) {
	await vi.waitFor(() => { for (const managed of idleSessions) expectContributions(managed, enabled); }, { timeout: 20_000, interval: 20 });
	const newSessions: Managed[] = [];
	try {
		for (const cwd of fixture.workspaces) {
			const managed = await fresh(cwd);
			newSessions.push(managed);
			expectContributions(managed, enabled);
			const resources = await discovery.discoverResourcePackages(cwd);
			if (configured) expect(resources).toMatchObject([{ id: resourceId, source, scope: "user", enabled }]);
			else expect(resources).toEqual([]);
			const views = await discovery.resourceViews(cwd);
			if (enabled) expect(views).toMatchObject([{ id: `user:${resourceId}:questions`, resourceId, scope: "user", placement: "aboveEditor", methods: viewMethods }]);
			else expect(views).toEqual([]);
		}
		report.stages.push({ name, enabled, configured, idleSessions: idleSessions.map((managed) => ({ cwd: managed.cwd, sessionPath: managed.sessionPath, resourceVersion: managed.resourceVersion })),
			newSessions: newSessions.map((managed) => ({ cwd: managed.cwd, sessionPath: managed.sessionPath })) });
		console.log(`[resources:github] ${name}: passed`);
	} finally { for (const managed of newSessions) await manager.disposeSessionPath(managed.sessionPath); }
}

async function ordinaryPrompt(managed: Managed) {
	await managed.session!.prompt("verification without the optional resource", { expandPromptTemplates: false });
	await vi.waitFor(() => expect(managed.runActive).toBe(false), { timeout: 10_000, interval: 20 });
	expect(managed.ui!.getPendingRequests()).toEqual([]);
	const last = managed.session!.messages.at(-1) as ToolResultMessage;
	expect(last).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Which option should be used? A (Recommended) or B?" }] });
}

async function question(managed: Managed, prompt = "verification questions=1 options=2") {
	let promptError: unknown;
	let settled = false;
	const completion = managed.session!.prompt(prompt, { expandPromptTemplates: false });
	void completion.then(() => { settled = true; }, (error) => { promptError = error; settled = true; });
	await vi.waitFor(() => {
		if (promptError) throw promptError;
		if (settled && !managed.ui!.getPendingRequests().length) throw new Error(`Expected an actual pending resource request; prompt settled. Frames: ${JSON.stringify(managed.buffer.map((frame) => JSON.parse(frame.json)).filter((frame) => frame.type === "error"))}`);
		expect(managed.ui!.getPendingRequests()).toHaveLength(1);
	}, { timeout: 20_000, interval: 20 });
	const request = managed.ui!.getPendingRequests()[0];
	expect(request).toMatchObject({ type: "extension_ui", method: "resource", resourceView: { id: `user:${resourceId}:questions`, resourceId, scope: "user", placement: "aboveEditor", methods: viewMethods } });
	const payload = request.resourceData as unknown as QuestionPayload;
	expect(payload.questions.length).toBeGreaterThan(0);
	const calls = managed.session!.messages.flatMap((message) => (message as unknown as { role: string; content?: Array<{ type: string; id: string; name: string; arguments: unknown }> }).role === "assistant"
		? ((message as unknown as { content?: Array<{ type: string; id: string; name: string; arguments: unknown }> }).content ?? []).filter((part) => part.type === "toolCall" && part.name === toolName) : []);
	const call = calls.at(-1)!;
	expect(call.arguments).toEqual(payload);
	return { completion, request, payload, callId: call.id };
}

async function persistedResults(managed: Managed) {
	return (await fs.readFile(managed.sessionPath, "utf8")).split(/\r?\n/).filter(Boolean).flatMap((line) => {
		const entry = JSON.parse(line) as PersistedEntry;
		return entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === toolName ? [{ line, message: entry.message }] : [];
	});
}

async function finishQuestion(managed: Managed, started: Awaited<ReturnType<typeof question>>, outcome: "answered" | "skipped") {
	await started.completion;
	await vi.waitFor(() => {
		expect(managed.runActive).toBe(false);
		expect(managed.session!.isStreaming).toBe(false);
		expect(managed.resourceReloadPending).toBe(false);
		expect(managed.resourceReloading).toBe(false);
	}, { timeout: 20_000, interval: 20 });
	expect(managed.ui!.getPendingRequests()).toEqual([]);
	expect(managed.buffer.map((frame) => JSON.parse(frame.json))).toEqual(expect.arrayContaining([expect.objectContaining({ type: "extension_ui_resolved", id: started.request.id })]));
	const result = (await persistedResults(managed)).find((entry) => entry.message.toolCallId === started.callId)!;
	expect(result).toBeTruthy();
	expect(result.message.details).toMatchObject({ questions: started.payload.questions, outcome: { status: outcome } });
	expect(managed.session!.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Recorded" }] });
	report.pending.push({ sessionPath: managed.sessionPath, requestId: started.request.id, toolCallId: started.callId, method: started.request.method, outcome,
		questions: started.payload.questions.length, result: result.message });
	return result;
}

async function expectAnsweredHistory(managed: Managed) {
	expect((await persistedResults(managed)).map((entry) => entry.line)).toContain(answeredLine);
	const snapshot = await manager.buildSnapshot(managed);
	expect(snapshot.messages.flatMap((message) => message.content.flatMap((part) => part.type === "text" || part.type === "toolResult" ? [part.text] : []))).toContain(answeredText);
}

describe("fixed GitHub ask-user candidate through the actual host and SDK", () => {
	it("acquires Git, refreshes user-scoped sessions, executes and persists questions, and revokes pending UI on disable and uninstall", async () => {
		report.result = "running";
		try {
			const idleA = await fresh(fixture.workspaces[0]);
			const idleB = await fresh(fixture.workspaces[1]);
			const idle = [idleA, idleB];
			await stage("not-installed", false, idle, false);
			await ordinaryPrompt(idleA);

			await service.installPackage(source, false, fixture.workspaces[0]);
			const checkout = pi.getPackageManager(fixture.workspaces[0]).getInstalledPath(source, "user")!;
			expect(checkout).toBeTruthy();
			const relativeCheckout = path.relative(fixture.agentDir, checkout);
			expect(path.isAbsolute(relativeCheckout) || relativeCheckout === ".." || relativeCheckout.startsWith(`..${path.sep}`)).toBe(false);
			const head = (await exec("git", ["-C", checkout, "rev-parse", "HEAD"], { timeout: 30_000, encoding: "utf8" })).stdout.trim();
			const remote = (await exec("git", ["-C", checkout, "config", "--get", "remote.origin.url"], { timeout: 30_000, encoding: "utf8" })).stdout.trim();
			expect(head.toLowerCase()).toBe(sha.toLowerCase());
			expect(remote).toMatch(/^(?:https:\/\/github\.com\/|git@github\.com:)RexVane\/piweb-ask-user(?:\.git)?$/i);
			const resourcePackage = JSON.parse(await fs.readFile(path.join(checkout, "package.json"), "utf8"));
			expect(resourcePackage.name).toBe(resourceId);
			await fs.access(path.join(checkout, "src", "index.ts"));
			await fs.access(path.join(checkout, "web", "index.html"));
			await stage("enabled", true, idle, true);
			const sourceInfo = idleA.session!.getAllTools().find((tool) => tool.name === toolName)!.sourceInfo!;
			expect(sourceInfo).toMatchObject({ source, scope: "user", origin: "package" });
			expect(path.resolve(sourceInfo.path)).toBe(path.resolve(checkout, "src", "index.ts"));
			report.checkout = { path: checkout, head, remote, version: resourcePackage.version, sourceInfo };
			const answered = await question(idleA, "verification questions=2 options=3 multi=1");
			const answers = answered.payload.questions.map((entry, index) => ({ selected: index === 0 ? [entry.options[0].label, entry.options[1].label] : [entry.options[1].label] }));
			expect(idleA.ui!.respond(answered.request.id, { value: JSON.stringify({ answers }) })).toBe(true);
			const saved = await finishQuestion(idleA, answered, "answered");
			expect(saved.message.details?.outcome?.answers).toEqual(answers);
			answeredLine = saved.line;
			answeredText = saved.message.content!.find((part) => part.type === "text")!.text!;
			expect(answeredText).toContain("Which option should be used for question 1? → A (Recommended)");

			const pendingDisable = await question(idleA);
			await service.toggleResource(resourceId, true, "user", fixture.workspaces[0]);
			expect(idleA.ui!.getPendingRequests()).toEqual([]);
			await finishQuestion(idleA, pendingDisable, "skipped");
			await stage("disabled", false, idle, true);
			await expectAnsweredHistory(idleA);
			await ordinaryPrompt(idleB);

			await service.toggleResource(resourceId, false, "user", fixture.workspaces[0]);
			await stage("re-enabled", true, idle, true);
			await expectAnsweredHistory(idleA);
			const restored = await question(idleB);
			expect(idleB.ui!.respond(restored.request.id, { value: JSON.stringify({ answers: [{ selected: [restored.payload.questions[0].options[1].label] }] }) })).toBe(true);
			await finishQuestion(idleB, restored, "answered");

			const pendingUninstall = await question(idleA);
			expect(await service.removePackage(source, false, fixture.workspaces[0])).toBe(true);
			expect(idleA.ui!.getPendingRequests()).toEqual([]);
			await finishQuestion(idleA, pendingUninstall, "skipped");
			await stage("uninstalled", false, idle, false);
			await expectAnsweredHistory(idleA);
			const settings = JSON.parse(await fs.readFile(path.join(fixture.agentDir, "settings.json"), "utf8"));
			expect((settings.packages ?? []).map((entry: string | { source: string }) => typeof entry === "string" ? entry : entry.source)).not.toContain(source);
			await expect(fs.access(checkout)).rejects.toMatchObject({ code: "ENOENT" });
			await ordinaryPrompt(idleB);
			report.result = "passed";
		} catch (error) {
			report.result = "failed";
			report.failure = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
			throw error;
		}
	});
});
