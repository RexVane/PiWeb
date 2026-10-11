import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** 自建的缓存式会话列表必须与 SDK `SessionManager.listAll()` 逐字段一致（侧栏 / 搜索 / 排序都靠它） */
describe("session-reader listSessions parity", () => {
	let tempDir = "";
	let previousAgentDir: string | undefined;
	beforeEach(async () => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-sessions-"));
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent");
	});
	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("refuses to delete paths outside the session store", async () => {
		const outside = path.join(tempDir, "outside.jsonl");
		await fs.writeFile(outside, "keep");
		const { deleteSession } = await import("../src/lib/session-reader");
		await expect(deleteSession(outside)).rejects.toThrow("outside the Pi session store");
		expect(await fs.readFile(outside, "utf8")).toBe("keep");
	}, 15_000);

	it("matches the SDK listing field by field and reuses cached summaries for unchanged files", async () => {
		const dir = path.join(tempDir, "agent", "sessions", "--D--Proj--");
		await fs.mkdir(dir, { recursive: true });
		const line = (o: unknown) => `${JSON.stringify(o)}\n`;
		// 1) 正常会话：改过名、含 toolResult、助手消息有数字时间戳
		await fs.writeFile(path.join(dir, "a.jsonl"), [
			line({ type: "session", version: 3, id: "s-a", timestamp: "2026-09-10T01:00:00.000Z", cwd: "D:\\Proj" }),
			line({ type: "message", id: "u1", parentId: null, timestamp: "2026-09-10T01:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first" }, { type: "image", data: "x" }, { type: "text", text: "question" }], timestamp: 1789000000000 } }),
			line({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-10T01:00:05.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], timestamp: 1789000005000 } }),
			line({ type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-10T01:00:06.000Z", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok" }], timestamp: 1789000006000 } }),
			line({ type: "session_info", id: "n1", parentId: "r1", timestamp: "2026-09-10T01:00:07.000Z", name: "  Renamed  " }),
			"not json\n",
		].join(""));
		// 2) 只有头没有消息（惰性会话刚落盘）
		await fs.writeFile(path.join(dir, "b.jsonl"), line({ type: "session", version: 3, id: "s-b", timestamp: "2026-09-11T02:00:00.000Z", cwd: "D:\\Proj" }));
		// 3) 首行不是 session 头 → 两边都应忽略
		await fs.writeFile(path.join(dir, "c.jsonl"), line({ type: "message", id: "x", message: { role: "user", content: "hi" } }));
		// 4) 字符串 content、无 message.timestamp（回落到条目时间戳）、清空名字的 session_info
		await fs.writeFile(path.join(dir, "d.jsonl"), [
			line({ type: "session", version: 3, id: "s-d", timestamp: "2026-09-09T03:00:00.000Z", cwd: "D:\\Proj" }),
			line({ type: "session_info", id: "n0", parentId: null, timestamp: "2026-09-09T03:00:00.500Z", name: "temp" }),
			line({ type: "message", id: "u1", parentId: "n0", timestamp: "2026-09-09T03:00:01.000Z", message: { role: "user", content: "plain string" } }),
			line({ type: "session_info", id: "n1", parentId: "u1", timestamp: "2026-09-09T03:00:02.000Z", name: "   " }),
		].join(""));

		const { listSessions } = await import("../src/lib/session-reader");
		const mine = await listSessions();
		const sdk = (await SessionManager.listAll()).map((s) => ({
			path: s.path, name: s.name, cwd: s.cwd, created: s.created.toISOString(), modified: s.modified.toISOString(), messageCount: s.messageCount, firstMessage: s.firstMessage,
		})).sort((a, b) => b.modified.localeCompare(a.modified));
		expect(mine).toEqual(sdk);
		expect(mine.map((s) => path.basename(s.path))).toEqual(["b.jsonl", "a.jsonl", "d.jsonl"]);
		expect(mine.find((s) => s.path.endsWith("a.jsonl"))).toMatchObject({ name: "Renamed", messageCount: 3, firstMessage: "first question" });
		expect(mine.find((s) => s.path.endsWith("d.jsonl"))).toMatchObject({ name: undefined, messageCount: 1, firstMessage: "plain string" });

		// 追加一条消息后（跳过 1.2 秒列表缓存）：变化的文件重新读，其它沿用缓存
		await new Promise((r) => setTimeout(r, 1300));
		await fs.appendFile(path.join(dir, "b.jsonl"), line({ type: "message", id: "u1", parentId: null, timestamp: "2026-09-12T02:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "late" }], timestamp: 1789200000000 } }));
		const again = await listSessions();
		expect(again.find((s) => s.path.endsWith("b.jsonl"))).toMatchObject({ messageCount: 1, firstMessage: "late" });
		const sdkAgain = (await SessionManager.listAll()).map((s) => ({
			path: s.path, name: s.name, cwd: s.cwd, created: s.created.toISOString(), modified: s.modified.toISOString(), messageCount: s.messageCount, firstMessage: s.firstMessage,
		})).sort((a, b) => b.modified.localeCompare(a.modified));
		expect(again).toEqual(sdkAgain);
		// 搜索按名字 / 首条消息 / 工作区路径
		expect((await listSessions("renamed")).map((s) => path.basename(s.path))).toEqual(["a.jsonl"]);
		expect((await listSessions("proj")).length).toBe(3);
	}, 15_000);

	it("clips a pasted wall of text to a title-sized first message", async () => {
		// 唯一有意偏离 SDK 的字段：整段贴进来的提问不该随每次列表轮询原样下发
		const dir = path.join(tempDir, "agent", "sessions", "--D--Proj--");
		await fs.mkdir(dir, { recursive: true });
		const line = (o: unknown) => `${JSON.stringify(o)}\n`;
		// 新模块实例：别吃到上一个用例 1.2 秒内的列表缓存
		vi.resetModules();
		const { FIRST_MESSAGE_MAX_CHARS, listSessions } = await import("../src/lib/session-reader");
		// 截断点正好落在一个 emoji（代理对）中间
		const text = `${"x".repeat(FIRST_MESSAGE_MAX_CHARS - 1)}😀${"y".repeat(50_000)}`;
		await fs.writeFile(path.join(dir, "long.jsonl"), [
			line({ type: "session", version: 3, id: "s-l", timestamp: "2026-09-10T01:00:00.000Z", cwd: "D:\\Proj" }),
			line({ type: "message", id: "u1", parentId: null, timestamp: "2026-09-10T01:00:01.000Z", message: { role: "user", content: text, timestamp: 1789000000000 } }),
		].join(""));
		const [summary] = await listSessions();
		expect(summary.firstMessage).toBe(`${"x".repeat(FIRST_MESSAGE_MAX_CHARS - 1)}…`);
	}, 15_000);

	it("reuses the persisted summary index after a restart, and still re-reads changed files", async () => {
		const dir = path.join(tempDir, "agent", "sessions", "--D--Proj--");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "a.jsonl");
		const line = (o: unknown) => `${JSON.stringify(o)}\n`;
		await fs.writeFile(file, [
			line({ type: "session", version: 3, id: "s-a", timestamp: "2026-09-10T01:00:00.000Z", cwd: "D:\\Proj" }),
			line({ type: "message", id: "u1", timestamp: "2026-09-10T01:00:01.000Z", message: { role: "user", content: "first", timestamp: 1789000000000 } }),
		].join(""));

		// 上一个用例留下了 1.2 秒的列表短缓存，这里要一个干净的模块
		vi.resetModules();
		const cold = await import("../src/lib/session-reader");
		const initial = await cold.listSessions();
		expect(initial[0]).toMatchObject({ messageCount: 1, firstMessage: "first" });

		// 摘要索引由 debounce 落盘，等它出现
		const indexFile = path.join(tempDir, "agent", "piweb-session-index.json");
		for (let i = 0; i < 60; i += 1) {
			if (await fs.stat(indexFile).catch(() => null)) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(await fs.stat(indexFile).catch(() => null)).toBeTruthy();

		// 把索引里这条会话的首条消息改成一个只有索引才可能给出的值：
		// 重启后若真的走了索引就会读到它，若又去解析 JSONL 就会读到 "first"。
		const index = JSON.parse(await fs.readFile(indexFile, "utf8"));
		const entries = Object.entries(index.entries as Record<string, [number, number, { firstMessage: string } | null]>);
		const entry = entries.find(([key]) => key === file || key.endsWith("a.jsonl"));
		expect(entry).toBeTruthy();
		(entry![1][2] as { firstMessage: string }).firstMessage = "from-index";
		await fs.writeFile(indexFile, JSON.stringify(index));

		vi.resetModules();
		const restarted = await import("../src/lib/session-reader");
		const afterRestart = await restarted.listSessions();
		expect(afterRestart[0]).toMatchObject({ messageCount: 1, firstMessage: "from-index" });

		// 文件变了（mtime / 大小任一变化）就必须重新解析，索引不能变成陈旧数据
		await fs.appendFile(file, line({ type: "message", id: "u2", timestamp: "2026-09-10T01:00:02.000Z", message: { role: "user", content: "second", timestamp: 1789000002000 } }));
		await new Promise((resolve) => setTimeout(resolve, 1300));
		const changed = await restarted.listSessions();
		expect(changed[0]).toMatchObject({ messageCount: 2, firstMessage: "first" });
	}, 20_000);
});
