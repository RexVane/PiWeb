import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
