/**
 * 导入写入器：写出的文件必须能被 pi 自己读回来。
 *
 * 这里断言的都是"写错就炸"的硬约束：header version=3（否则 SDK 迁移会重写条目 id）、
 * parentId 单链、每个 toolResult 都能对上一条 toolCall（否则模型请求 400）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSessionDir, importedFileName, importedKey, listImportedKeys, writeImportedSession } from "../src/lib/session-import/writer";
import type { ImportedEntry, ImportedSession } from "../src/lib/session-import/types";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readSession } from "../src/lib/session-reader";

let root: string;
let agentDir: string;
let cwd: string;
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-import-writer-")));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "workspace");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	// SessionManager 会按 PI_CODING_AGENT_DIR 推算默认会话目录：指到临时目录，别碰真实的 agent 目录
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	await fs.rm(root, { recursive: true, force: true });
});

function session(entries: ImportedEntry[], overrides: Partial<ImportedSession["summary"]> = {}): ImportedSession {
	return {
		summary: {
			source: "claude",
			externalId: "abc-123",
			title: "原始标题",
			projectPath: cwd,
			createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
			location: "/src/session.jsonl",
			...overrides,
		},
		entries,
	};
}

async function readLines(file: string): Promise<Record<string, any>[]> {
	return (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

describe("写出的会话文件是合法 pi 会话", () => {
	it("header 是 version 3、cwd 是目标工作区，父链单链且首条为 null", async () => {
		const written = await writeImportedSession(session([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1_700_000_000_000 } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "在的" }], timestamp: 1_700_000_001_000, stopReason: "stop" } },
		]), { cwd, agentDir });

		const lines = await readLines(written.path);
		expect(lines[0]).toMatchObject({ type: "session", version: 3, cwd: path.resolve(cwd) });
		const entries = lines.slice(1);
		expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		expect(entries[0].parentId).toBeNull();
		// 单链：每条指向紧邻的前一条
		for (let index = 1; index < entries.length; index += 1) expect(entries[index].parentId).toBe(entries[index - 1].id);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
		// 文件名带来源与外部 id，幂等键与之一致
		expect(path.basename(written.path)).toBe(`2026-01-02T03-04-05-000Z_import-claude-abc-123.jsonl`);
		expect(importedKey("claude", "abc-123")).toBe("claude:abc-123");
	});

	it("源里缺调用记录的孤立 toolResult 会补一条占位 toolCall，读回时不会报错", async () => {
		const written = await writeImportedSession(session([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "查一下" }], timestamp: 1_700_000_000_000 } },
			// 只有结果、调用记录在源里被截断了
			{ type: "message", message: { role: "toolResult", toolCallId: "call_missing", toolName: "Bash", content: [{ type: "text", text: "输出" }], timestamp: 1_700_000_002_000 } },
		]), { cwd, agentDir });

		const lines = await readLines(written.path);
		const toolCallIds = lines.flatMap((entry) => (entry.type === "message" && Array.isArray(entry.message?.content) ? entry.message.content.filter((block: any) => block.type === "toolCall").map((block: any) => block.id) : []));
		const resultIds = lines.flatMap((entry) => (entry.type === "message" && entry.message?.role === "toolResult" ? [entry.message.toolCallId] : []));
		expect(resultIds).toEqual(["call_missing"]);
		expect(toolCallIds).toContain("call_missing");
		expect(written.skipped.join()).toMatch(/补齐 1 条缺失的工具调用记录/);

		const read = await readSession(written.path);
		expect(read.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
	});

	it("工具调用与结果按源里的顺序保留，思考/用量/模型都带过去", async () => {
		const written = await writeImportedSession(session([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "帮我看看" }], timestamp: 1_700_000_000_000 } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "先看文件" },
						{ type: "text", text: "好的" },
						{ type: "toolCall", id: "call_1", name: "Read", arguments: { path: "a.ts" } },
					],
					timestamp: 1_700_000_001_000,
					model: "deepseek-v4-flash",
					provider: "laoyou",
					usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 },
					stopReason: "toolUse",
				},
			},
			{ type: "message", message: { role: "toolResult", toolCallId: "call_1", toolName: "Read", content: [{ type: "text", text: "内容" }], isError: true, timestamp: 1_700_000_002_000 } },
		]), { cwd, agentDir });

		const lines = await readLines(written.path);
		const messages = lines.filter((entry) => entry.type === "message").map((entry) => entry.message);
		expect(messages[1].content.map((block: any) => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(messages[1].usage).toMatchObject({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 126 });
		expect(messages[1].model).toBe("deepseek-v4-flash");
		expect(messages[2].toolCallId).toBe("call_1");
		expect(messages[2].isError).toBe(true);
	});

	it("标题写成【来源】原标题，并留下可追溯的来源条目", async () => {
		const written = await writeImportedSession(session([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "第一句话" }], timestamp: 1_700_000_000_000 } },
		]), { cwd, agentDir });

		const lines = await readLines(written.path);
		expect(lines.find((entry) => entry.type === "session_info")?.name).toBe("【Claude】原始标题");
		const provenance = lines.find((entry) => entry.customType === "piweb-import");
		expect(provenance?.data).toMatchObject({ source: "claude", externalId: "abc-123", sourcePath: "/src/session.jsonl", projectPath: cwd });
	});

	it("源没有标题时用首条用户消息当标题", async () => {
		const written = await writeImportedSession(session([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "  这段对话到底在说些什么呢  " }], timestamp: 1_700_000_000_000 } },
		], { title: undefined }), { cwd, agentDir });
		const lines = await readLines(written.path);
		expect(lines.find((entry) => entry.type === "session_info")?.name).toBe("【Claude】这段对话到底在说些什么呢");
	});

	it("会话目录编码与 SDK 的 SessionManager 逐字一致", async () => {
		// 直接和 SDK 算出来的目录名比：这是导入能被 pi 读到的前提。
		// 注意不能用 "D:\\AIApp\\PiWeb" 这类字面路径去断言——在 POSIX 上它只是含反斜杠的相对路径，
		// path.resolve 会拼到当前工作目录后（CI 上就是这么挂的），所以用真实临时目录比。
		const sm = SessionManager.create(cwd);
		expect(path.basename(sm.getSessionDir())).toBe(encodeSessionDir(cwd));
		// Windows 上另外验证一下盘符风格
		if (process.platform === "win32") expect(encodeSessionDir("D:\\AIApp\\PiWeb")).toBe("--D--AIApp-PiWeb--");
		// 不变量：一定是 -- 开头结尾、内部不含路径分隔符或冒号（否则目录会散开）
		const encoded = encodeSessionDir(cwd);
		expect(encoded).toMatch(/^--.+--$/);
		expect(encoded.slice(2, -2)).not.toMatch(/[/\\:]/);
		// 文件名里的外部 id 会滤掉非法字符，路径分隔符不能泄漏进文件名
		expect(importedFileName("codex", "rollout/../etc/passwd", 0)).not.toMatch(/[/\\]/);
	});

	it("已导入索引与幂等键口径一致", async () => {
		const written = await writeImportedSession(session([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1_700_000_000_000 } },
		]), { cwd, agentDir });
		expect(path.basename(written.path)).toContain("import-claude-abc-123");
		const keys = await listImportedKeys(agentDir);
		expect(keys.has(importedKey("claude", "abc-123"))).toBe(true);
		expect(keys.has(importedKey("grok", "abc-123"))).toBe(false);
	});
});
