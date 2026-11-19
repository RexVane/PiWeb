import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeImportedUsage, repairImportedAssistantUsage } from "../src/lib/session-import/usage";
import { writeImportedSession } from "../src/lib/session-import/writer";
import { openSessionManager } from "../src/lib/pi";
import { recycleFixture } from "./fixtures/recycle";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-import-usage-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
});
afterEach(async () => { vi.unstubAllEnvs(); await recycleFixture(root); });

const provenance = { type: "custom", customType: "piweb-import", data: { source: "antigravity" } };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function legacyFile() {
	const file = path.join(root, "legacy.jsonl");
	const timestamp = "2026-11-19T14:33:12.629Z";
	const entries = [
		{ type: "session", version: 3, id: "legacy-import", cwd: root, timestamp },
		{ type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Continue the task" }], timestamp: 1 } },
		{ type: "message", id: "assistant", parentId: "user", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Imported answer without reported token usage" }], timestamp: 2, stopReason: "stop" } },
		{ ...provenance, id: "source", parentId: "assistant", timestamp },
	];
	await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return file;
}

describe("imported assistant usage", () => {
	it("always writes complete usage for text replies and reconstructed tool-call placeholders", async () => {
		const result = await writeImportedSession({ summary: { source: "antigravity", externalId: "fixture", location: "/source/transcript.jsonl" }, entries: [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "No usage in the Antigravity transcript" }], timestamp: 1 } },
			{ type: "message", message: { role: "toolResult", toolCallId: "missing", toolName: "read", content: [{ type: "text", text: "File contents" }], timestamp: 2 } },
		] }, { cwd: root, agentDir: path.join(root, "agent") });
		const assistants = SessionManager.open(result.path).getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(assistants).toHaveLength(2);
		for (const entry of assistants) expect((entry as { message: { usage?: unknown } }).message.usage).toEqual(zero);
	});

	it("repairs older imports in memory without rewriting the file or changing IDs/parent links", async () => {
		const file = await legacyFile();
		const original = await fs.readFile(file, "utf8");
		const raw = SessionManager.open(file);
		const manager = openSessionManager(file);
		const context = manager.buildSessionContext();
		expect(context.messages.find((message) => message.role === "assistant")).toMatchObject({ usage: zero });
		expect(manager.getEntries().map((entry) => [entry.id, entry.parentId])).toEqual(raw.getEntries().map((entry) => [entry.id, entry.parentId]));
		expect(await fs.readFile(file, "utf8")).toBe(original);
		expect(estimateContextTokens(context.messages as Parameters<typeof responses>[1]["messages"]).tokens).toBeGreaterThan(0); // zeros mean unknown, not zero context
		expect(repairImportedAssistantUsage(manager.getEntries())).toBe(0); // idempotent
	});

	it("keeps old import branches usable even when forking before the provenance entry", async () => {
		const file = await legacyFile();
		const original = await fs.readFile(file, "utf8");
		const source = openSessionManager(file, root);
		const forked = source.createBranchedSession("assistant");
		expect(forked).toBeTruthy();
		const child = SessionManager.open(forked!);
		expect(child.getEntries().some((entry) => entry.type === "custom" && entry.customType === "piweb-import")).toBe(false);
		expect(child.buildSessionContext().messages.find((message) => message.role === "assistant")).toMatchObject({ usage: zero });
		expect(await fs.readFile(file, "utf8")).toBe(original);
	});

	it("repairs complete SDK clones of old imports when reopened", async () => {
		const file = await legacyFile();
		const clone = SessionManager.forkFrom(file, root, root);
		const reopened = openSessionManager(clone.getSessionFile()!, root);
		expect(reopened.buildSessionContext().messages.find((message) => message.role === "assistant")).toMatchObject({ usage: zero });
	});

	it("preserves complete live usage and billing, including provider-reported totals", () => {
		const usage = { ...zero, input: 123, output: 20, totalTokens: 143, cost: { ...zero.cost, total: 0.5, totalFromProvider: true } };
		const live = { type: "message", message: { role: "assistant", usage } };
		expect(repairImportedAssistantUsage([provenance, live])).toBe(0);
		expect(live.message.usage).toBe(usage);
	});

	it("fills partial usage while preserving known measurements and ignores ordinary non-imported sessions", () => {
		const assistant: { type: string; message: { role: string; usage?: unknown } } = { type: "message", message: { role: "assistant", usage: { input: 123, output: 20 } } };
		expect(repairImportedAssistantUsage([provenance, assistant])).toBe(1);
		expect(assistant.message.usage).toMatchObject({ input: 123, output: 20, totalTokens: 143, cost: zero.cost });
		const ordinary = { type: "message", message: { role: "assistant" } };
		expect(repairImportedAssistantUsage([ordinary])).toBe(0);
		expect(ordinary.message).not.toHaveProperty("usage");
		expect(normalizeImportedUsage(null)).toEqual(zero);
		expect(normalizeImportedUsage({ input: NaN, output: -1 })).toEqual(zero);
	});
});

it.each(["openai-responses", "openai-completions"] as const)("can build a %s continuation request from a legacy import without calling a paid model", async (api) => {
	const file = await legacyFile();
	const model = { id: "offline-check", name: "offline-check", provider: "offline-check", baseUrl: "https://offline-check.invalid/v1", reasoning: false,
		input: ["text" as const], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const network = vi.fn(async () => { throw new Error("Paid requests are forbidden in this test"); });
	const onPayload = vi.fn(() => { throw new Error("PAYLOAD_BUILT_OFFLINE"); });
	const options = { apiKey: "offline-placeholder", fetch: network, onPayload };
	const context = (manager: SessionManager) => normalizeContext({ messages: manager.buildSessionContext().messages as Parameters<typeof normalizeContext>[0]["messages"] });
	const send = (manager: SessionManager) => api === "openai-responses"
		? responses({ ...model, api: "openai-responses" }, context(manager), options)
		: completions({ ...model, api: "openai-completions" }, context(manager), options);
	expect(() => send(SessionManager.open(file))).toThrow(/totalTokens/);
	const result = await send(openSessionManager(file)).result();
	expect(onPayload).toHaveBeenCalledTimes(1);
	expect(result.errorMessage).toContain("PAYLOAD_BUILT_OFFLINE");
	expect(network).not.toHaveBeenCalled();
});
