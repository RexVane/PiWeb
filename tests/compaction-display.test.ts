/**
 * 压缩后被压缩掉的上下文照常显示：消息列表 = 压缩掉的历史 + 当前上下文，压缩条目投影成分隔卡，
 * 卡片在保留下来的第一条消息前面（卡片以上就是模型只看得到摘要的部分）。
 * 冷会话、热会话、只读接口、压缩完成事件四条路径的位置必须一致，刷新 / 重连后不变。
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
const managed: ReturnType<typeof import("../src/lib/agent-manager")["getManaged"]>[] = [];

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-compaction-display-"));
	cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in compaction display test"); }));
	vi.resetModules();
	manager = await import("../src/lib/agent-manager");
	reader = await import("../src/lib/session-reader");
}, 90_000);

afterAll(async () => {
	for (const m of managed) manager.disposeSession(m);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await fs.rm(root, { recursive: true, force: true });
});

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string, timestamp: number) => ({ role: "user" as const, content: text, timestamp });
const assistant = (text: string, timestamp: number) => ({
	role: "assistant" as const, api: "anthropic-messages", provider: "anthropic", model: "test",
	content: [{ type: "text" as const, text }], timestamp, stopReason: "stop" as const, usage,
});
/** 只比身份和顺序；system 等不显示的条目不算 */
const shape = (messages: WebMessage[]) => messages
	.filter((message) => message.role !== "other")
	.map((message) => (message.role === "summary" ? `summary:${message.summaryKind}:${message.id}` : `${message.role}:${message.id}`));

async function newSession() {
	const { SessionManager } = await import("../src/lib/pi");
	return SessionManager.create(cwd);
}

function open(sessionFile: string) {
	const m = manager.getManaged(sessionFile);
	managed.push(m);
	return m;
}

describe("压缩后的消息显示", () => {
	it("冷快照、只读接口、热快照都保留压缩前的消息，分隔卡在保留的第一条前面", async () => {
		const sm = await newSession();
		const u1 = sm.appendMessage(user("第一个问题", 1000));
		const a1 = sm.appendMessage(assistant("第一个回答", 1100));
		const u2 = sm.appendMessage(user("第二个问题", 2000));
		const a2 = sm.appendMessage(assistant("第二个回答", 2100));
		const c = sm.appendCompaction("## 摘要\n讨论了第一个问题", u2, 12345, undefined, false);
		const u3 = sm.appendMessage(user("压缩后的问题", Date.now()));
		const a3 = sm.appendMessage(assistant("压缩后的回答", Date.now()));
		const expected = [`user:${u1}`, `assistant:${a1}`, `summary:compaction:${c}`, `user:${u2}`, `assistant:${a2}`, `user:${u3}`, `assistant:${a3}`];

		const m = open(sm.getSessionFile()!);
		const cold = (await manager.buildSnapshot(m)).messages;
		expect(shape(cold)).toEqual(expected);
		expect(cold.find((message) => message.role === "summary")).toMatchObject({ summary: "## 摘要\n讨论了第一个问题", tokensBefore: 12345 });
		expect((await reader.readSession(sm.getSessionFile()!)).messages).toEqual(cold);

		await manager.ensureSession(m);
		const live = (await manager.buildSnapshot(m)).messages;
		expect(shape(live)).toEqual(expected);
		expect(live.find((message) => message.role === "summary")).toMatchObject({ summary: "## 摘要\n讨论了第一个问题", tokensBefore: 12345 });
	}, 60_000);

	it("多次压缩：更早的分隔卡也挪到它保留的第一条前面", async () => {
		const sm = await newSession();
		const u1 = sm.appendMessage(user("q1", 1000));
		const a1 = sm.appendMessage(assistant("a1", 1100));
		const u2 = sm.appendMessage(user("q2", 2000));
		const a2 = sm.appendMessage(assistant("a2", 2100));
		const c1 = sm.appendCompaction("旧摘要", u2, 500, undefined, false);
		const u3 = sm.appendMessage(user("q3", 3000));
		const a3 = sm.appendMessage(assistant("a3", 3100));
		const c2 = sm.appendCompaction("新摘要", u3, 900, undefined, false);
		const u4 = sm.appendMessage(user("q4", 4000));
		const a4 = sm.appendMessage(assistant("a4", 4100));

		const m = open(sm.getSessionFile()!);
		expect(shape((await manager.buildSnapshot(m)).messages)).toEqual([
			`user:${u1}`, `assistant:${a1}`, `summary:compaction:${c1}`, `user:${u2}`, `assistant:${a2}`,
			`summary:compaction:${c2}`, `user:${u3}`, `assistant:${a3}`, `user:${u4}`, `assistant:${a4}`,
		]);
	}, 60_000);

	it("分支摘要在原位置显示成摘要卡，冷热一致", async () => {
		const sm = await newSession();
		const u1 = sm.appendMessage(user("q1", 1000));
		const a1 = sm.appendMessage(assistant("a1", 1100));
		sm.appendMessage(user("被放弃的问题", 2000));
		sm.appendMessage(assistant("被放弃的回答", 2100));
		const b = sm.branchWithSummary(a1, "离开的分支：试过方案 B");
		const u3 = sm.appendMessage(user("q3", 3000));
		const a3 = sm.appendMessage(assistant("a3", 3100));
		const expected = [`user:${u1}`, `assistant:${a1}`, `summary:branch:${b}`, `user:${u3}`, `assistant:${a3}`];

		const m = open(sm.getSessionFile()!);
		const cold = (await manager.buildSnapshot(m)).messages;
		expect(shape(cold)).toEqual(expected);
		expect(cold.find((message) => message.role === "summary")?.summary).toBe("离开的分支：试过方案 B");
		await manager.ensureSession(m);
		expect(shape((await manager.buildSnapshot(m)).messages)).toEqual(expected);
	}, 60_000);

	it("压缩完成事件带分隔卡和插入位置；失败时不带", async () => {
		const sm = await newSession();
		sm.appendMessage(user("q1", 1000));
		sm.appendMessage(assistant("a1", 1100));
		const u2 = sm.appendMessage(user("q2", 2000));
		sm.appendMessage(assistant("a2", 2100));
		const m = open(sm.getSessionFile()!);
		await manager.ensureSession(m);
		const events: WebEvent[] = [];
		expect(manager.subscribe(m, (_seq, json) => events.push(JSON.parse(json)), m.seq)).toBe(true);

		// SDK 先写压缩条目再发 compaction_end
		const c = m.sm.appendCompaction("压缩摘要", u2, 4321, undefined, false);
		const session = m.session as unknown as { _emit(event: unknown): void };
		session._emit({ type: "compaction_end", reason: "threshold", result: { summary: "压缩摘要", firstKeptEntryId: u2, tokensBefore: 4321 }, aborted: false, willRetry: false });
		session._emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: "boom" });

		const ends = events.filter((event): event is Extract<WebEvent, { type: "compaction" }> => event.type === "compaction" && event.phase === "end");
		expect(ends).toHaveLength(2);
		expect(ends[0]).toMatchObject({
			marker: { id: c, role: "summary", summaryKind: "compaction", summary: "压缩摘要", tokensBefore: 4321 },
			beforeId: u2,
		});
		expect(ends[1].errorMessage).toBe("boom");
		expect(ends[1].marker).toBeUndefined();
	}, 60_000);
});
