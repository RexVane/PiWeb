/**
 * pi 终端和 PiWeb 同时打开一个会话：终端写进 JSONL 的新条目，PiWeb 在打开 / 发送（getManaged）、
 * 侧栏拉列表时核对出来。空闲就从磁盘重载（会话级选择带过去、正在看的浏览器收到 external_reload 后重连），
 * 正在跑只发 external_write 提醒、空闲后再重载；自己写的条目不算外来。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebEvent, WebMessage } from "../src/lib/types";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

let root: string;
let cwd: string;
let manager: typeof import("../src/lib/agent-manager");
let reader: typeof import("../src/lib/session-reader");
let pi: typeof import("../src/lib/pi");

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-external-write-"));
	cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in external write test"); }));
	vi.resetModules();
	manager = await import("../src/lib/agent-manager");
	reader = await import("../src/lib/session-reader");
	pi = await import("../src/lib/pi");
}, 90_000);

const files: string[] = [];

afterAll(async () => {
	for (const file of files) await manager.disposeSessionPath(file);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await fs.rm(root, { recursive: true, force: true });
});

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string, timestamp = Date.now()) => ({ role: "user" as const, content: text, timestamp });
const assistant = (text: string, timestamp = Date.now()) => ({
	role: "assistant" as const, api: "anthropic-messages", provider: "anthropic", model: "test",
	content: [{ type: "text" as const, text }], timestamp, stopReason: "stop" as const, usage,
});
const texts = (messages: WebMessage[]) => messages
	.filter((message) => message.role === "user" || message.role === "assistant")
	.map((message) => message.content.map((block) => ("text" in block ? block.text : "")).join(""));

function seed() {
	const sm = pi.SessionManager.create(cwd);
	sm.appendMessage(user("网页里的问题"));
	sm.appendMessage(assistant("网页里的回答"));
	files.push(sm.getSessionFile()!);
	return sm.getSessionFile()!;
}

/** 终端 pi：另开一个 SessionManager 往同一个文件里接着写 */
function terminalWrites(file: string, ...lines: string[]) {
	const terminal = pi.SessionManager.open(file);
	for (const line of lines) terminal.appendMessage(line.startsWith("答") ? assistant(line) : user(line));
}

describe("终端 pi 同时写会话", () => {
	it("空闲时重开：消息换成磁盘上的、会话级选择带过去、正在看的浏览器收到重载事件", async () => {
		const file = seed();
		const m = manager.getManaged(file);
		await manager.ensureSession(m);
		m.toolPreset = "full";
		m.desiredThinkingLevel = "high";
		const events: WebEvent[] = [];
		expect(manager.subscribe(m, (_seq, json) => events.push(JSON.parse(json)), m.seq)).toBe(true);

		terminalWrites(file, "终端的问题", "答：终端的回答");
		const fresh = manager.getManaged(file);

		expect(fresh).not.toBe(m);
		expect(m.disposed).toBe(true);
		expect(events.map((event) => (event.type === "status" ? `status:${event.state}` : event.type))).toEqual(["external_reload", "status:disposed"]);
		expect(events[0]).toMatchObject({ type: "external_reload", entries: 2 });
		expect(fresh.toolPreset).toBe("full");
		expect(fresh.desiredThinkingLevel).toBe("high");
		const snap = await manager.buildSnapshot(fresh);
		expect(texts(snap.messages)).toEqual(["网页里的问题", "网页里的回答", "终端的问题", "答：终端的回答"]);
		expect(snap.externalReload).toEqual({ entries: 2, at: (events[0] as { at: number }).at });
		expect(manager.getManaged(file)).toBe(fresh);
	}, 60_000);

	it("自己写的条目不算外来，不重载", async () => {
		const file = seed();
		const m = manager.getManaged(file);
		m.sm.appendMessage(user("网页接着问"));
		m.sm.appendMessage(assistant("网页接着答"));
		expect(manager.getManaged(file)).toBe(m);
		expect((await manager.buildSnapshot(m)).externalReload).toBeUndefined();
	}, 60_000);

	it("正在跑只提醒；空闲后侧栏拉列表时重载", async () => {
		const file = seed();
		const m = manager.getManaged(file);
		const events: WebEvent[] = [];
		manager.subscribe(m, (_seq, json) => events.push(JSON.parse(json)), m.seq);
		m.runActive = true;

		terminalWrites(file, "终端插进来的问题");
		expect(manager.getManaged(file)).toBe(m);
		expect(events).toContainEqual(expect.objectContaining({ type: "external_write", entries: 1 }));
		// 再核对一次没有新写入：不重复提醒
		manager.getManaged(file);
		expect(events.filter((event) => event.type === "external_write")).toHaveLength(1);

		m.runActive = false;
		await reader.listSessions();
		const fresh = manager.getManaged(file);
		expect(fresh).not.toBe(m);
		expect(texts((await manager.buildSnapshot(fresh)).messages)).toContain("终端插进来的问题");
	}, 60_000);

	it("终端那一行还没写完：先不算，写完后再重载", async () => {
		const file = seed();
		const m = manager.getManaged(file);
		const line = JSON.stringify({
			type: "message", id: "ext00001", parentId: m.sm.getLeafId(), timestamp: new Date().toISOString(),
			message: user("分两次写完的问题"),
		});
		await fs.appendFile(file, line.slice(0, 20));
		expect(manager.getManaged(file)).toBe(m);
		await fs.appendFile(file, `${line.slice(20)}\n`);
		const fresh = manager.getManaged(file);
		expect(fresh).not.toBe(m);
		expect(texts((await manager.buildSnapshot(fresh)).messages)).toContain("分两次写完的问题");
	}, 60_000);
});
