/**
 * 各来源适配器：用"最小但真实"的样本（字段按本机真实文件抄）验证映射。
 *
 * 每个来源的样本目录通过 mock `paths` 指到临时目录，避免碰真实用户数据。
 * 断言的重点是**无损**：三类角色、思考、工具调用与结果的配对、时间戳、标题、模型。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots = {
	claude: "",
	codex: "",
	grok: "",
	dsh: "",
	zcode: "",
	opencode: "",
};

vi.mock("../src/lib/session-import/paths", () => ({
	claudeRoot: () => roots.claude,
	codexRoot: () => roots.codex,
	grokRoot: () => roots.grok,
	dshRoot: () => roots.dsh,
	zcodeDb: () => roots.zcode,
	opencodeDb: () => roots.opencode,
}));

import { claudeSource } from "../src/lib/session-import/claude";
import { codexSource } from "../src/lib/session-import/codex";
import { grokSource } from "../src/lib/session-import/grok";
import { dshSource, decodeCwdDir } from "../src/lib/session-import/dsh";
import { createOcFamilySource } from "../src/lib/session-import/oc-family";
import { decodeZstdFrames } from "../src/lib/session-import/dsh-zstd";
import type { ImportedEntry, ImportedMessage } from "../src/lib/session-import/types";

let root: string;
const TS = Date.UTC(2026, 8, 13, 4, 10, 51);

/** dsh 的真实文件是多帧 zstd 拼接，这里按同样方式合成（单帧解压只能拿到第一帧） */
function multiFrame(lines: string[], perFrame = 2): Buffer {
	const frames: Buffer[] = [];
	for (let index = 0; index < lines.length; index += perFrame) {
		frames.push(zlib.zstdCompressSync(Buffer.from(`${lines.slice(index, index + perFrame).join("\n")}\n`, "utf8")));
	}
	return Buffer.concat(frames);
}

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-import-src-")));
	for (const key of Object.keys(roots) as Array<keyof typeof roots>) roots[key] = path.join(root, key);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function write(file: string, content: string): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content, "utf8");
	return file;
}

const messagesOf = (entries: ImportedEntry[]): ImportedMessage[] =>
	entries.filter((entry): entry is { type: "message"; message: ImportedMessage } => entry.type === "message").map((entry) => entry.message);

describe("Claude Code", () => {
	async function fixture() {
		const file = path.join(roots.claude, "-D-AIApp-PiWeb", "763deadc-d149-44d6-ace1-398792539a91.jsonl");
		await write(file, [
			JSON.stringify({ type: "summary", summary: "会话摘要" }),
			JSON.stringify({ type: "user", cwd: "D:\\AIApp\\PiWeb", timestamp: new Date(TS).toISOString(), message: { role: "user", content: "看下这个项目" } }),
			JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "子代理的输入" } }),
			JSON.stringify({
				type: "assistant",
				timestamp: new Date(TS + 1000).toISOString(),
				message: {
					role: "assistant",
					model: "claude-sonnet-4-5",
					stop_reason: "tool_use",
					usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 8, cache_creation_input_tokens: 3 },
					content: [
						{ type: "thinking", thinking: "先列目录" },
						{ type: "text", text: "我来看看" },
						{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
					],
				},
			}),
			JSON.stringify({
				type: "user",
				timestamp: new Date(TS + 2000).toISOString(),
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.ts b.ts", is_error: false }] },
			}),
			JSON.stringify({ type: "user", timestamp: new Date(TS + 3000).toISOString(), message: { role: "user", content: "<system-reminder>环境信息</system-reminder>" } }),
		].join("\n"));
		return file;
	}

	it("扫描得到 cwd 与模型，读取保留思考/工具调用/工具结果与用量", async () => {
		await fixture();
		const [summary] = await claudeSource.scan();
		// Claude Code 不写标题字段：扫描时用摘要行（没有摘要就退回首条用户消息）当标题
		expect(summary).toMatchObject({ source: "claude", externalId: "763deadc-d149-44d6-ace1-398792539a91", title: "会话摘要", projectPath: "D:\\AIApp\\PiWeb", model: "claude-sonnet-4-5" });

		const read = await claudeSource.read(summary);
		expect(read).not.toBeNull();
		const messages = messagesOf(read!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		const assistant = messages[1] as Extract<ImportedMessage, { role: "assistant" }>;
		expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(assistant.usage).toMatchObject({ input: 120, output: 40, cacheRead: 8, cacheWrite: 3 });
		expect((messages[2] as Extract<ImportedMessage, { role: "toolResult" }>).toolCallId).toBe("toolu_1");
		expect(read!.skipped?.join()).toMatch(/1 条侧链/);
		expect(read!.skipped?.join()).toMatch(/1 条合成输入/);
		// 时间戳逐条保留，不是导入时刻
		expect(assistant.timestamp).toBe(TS + 1000);
	});

	it("只有图片、没有文字的用户消息不会被丢掉", async () => {
		const file = path.join(roots.claude, "-proj", "image-only.jsonl");
		await write(file, JSON.stringify({
			type: "user",
			cwd: "/ws",
			timestamp: new Date(TS).toISOString(),
			message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] },
		}));
		const summary = (await claudeSource.scan()).find((item) => item.externalId === "image-only")!;
		const messages = messagesOf((await claudeSource.read(summary))!.entries);
		expect(messages[0].content).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
	});
});

describe("Codex CLI", () => {
	async function fixture() {
		const file = path.join(roots.codex, "2026", "09", "13", "rollout-2026-09-13T18-03-08-01a09a38-7d6c-7b40-8d8a-c4e384b101b5.jsonl");
		await write(file, [
			JSON.stringify({ timestamp: new Date(TS).toISOString(), type: "session_meta", payload: { cwd: "D:\\AIApp\\PiWeb", timestamp: new Date(TS).toISOString(), model: "gpt-5-codex", model_provider: "openai", base_instructions: "x".repeat(20000) } }),
			JSON.stringify({ timestamp: new Date(TS).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "修复这个 bug" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] } }),
			JSON.stringify({ timestamp: new Date(TS).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# Files mentioned by the user:\nfoo.ts" }] } }),
			JSON.stringify({ timestamp: new Date(TS + 1000).toISOString(), type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "定位到类型错误" }] } }),
			JSON.stringify({ timestamp: new Date(TS + 1000).toISOString(), type: "response_item", payload: { type: "reasoning", encrypted_content: "gAAAA..." } }),
			JSON.stringify({ timestamp: new Date(TS + 2000).toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已经修好" }] } }),
			JSON.stringify({ timestamp: new Date(TS + 3000).toISOString(), type: "response_item", payload: { type: "function_call", call_id: "call_1", name: "shell", arguments: "{\"command\":\"npm test\"}" } }),
			JSON.stringify({ timestamp: new Date(TS + 4000).toISOString(), type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "ok" } }),
		].join("\n"));
		return file;
	}

	it("读得出 cwd/模型/思考/调用配对，合成输入与加密推理被跳过并计数", async () => {
		await fixture();
		const [summary] = await codexSource.scan();
		// Codex 也没有标题字段：用首条真人用户消息（合成输入不算）
		expect(summary).toMatchObject({ source: "codex", title: "修复这个 bug", projectPath: "D:\\AIApp\\PiWeb", model: "gpt-5-codex", provider: "openai" });

		const read = await codexSource.read(summary);
		const messages = messagesOf(read!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant", "toolResult"]);
		expect(messages[0].content[1]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
		const reasoning = messages[1] as Extract<ImportedMessage, { role: "assistant" }>;
		expect(reasoning.content[0]).toEqual({ type: "thinking", thinking: "定位到类型错误" });
		const call = messages[3] as Extract<ImportedMessage, { role: "assistant" }>;
		expect(call.content[0]).toMatchObject({ type: "toolCall", id: "call_1", name: "shell", arguments: { command: "npm test" } });
		expect((messages[4] as Extract<ImportedMessage, { role: "toolResult" }>).toolCallId).toBe("call_1");
		// 跳过计数按类别汇总，不逐条刷屏；系统上下文会由 pi 按目标工作区重建
		expect(read!.skipped).toEqual([
			"跳过 1 条合成输入",
			"跳过 1 条仅含加密内容的推理记录",
			"跳过 1 条源工具运行时上下文（pi 会按当前工作区重新生成）",
		]);
	});
});

describe("Grok CLI", () => {
	async function fixture() {
		const dir = path.join(roots.grok, "D%3A%5CAIApp%5CPiWeb", "01a0a4d5-728e-76d0-92d6-ba247553e656");
		await write(path.join(dir, "summary.json"), JSON.stringify({ session_summary: "整理索引", current_model_id: "grok-4", num_messages: 4, created_at: TS, updated_at: TS + 500, info: { cwd: "D:\\AIApp\\PiWeb" } }));
		await write(path.join(dir, "chat_history.jsonl"), [
			JSON.stringify({ type: "system", content: "系统提示" }),
			JSON.stringify({ type: "user", content: "把这个整理一下" }),
			JSON.stringify({ type: "user", content: "注入的提醒", synthetic_reason: "reminder" }),
			// Grok 新版的 summary 是块数组，不再是纯字符串
			JSON.stringify({ type: "reasoning", summary: [{ type: "summary_text", text: "先看目录" }] }),
			JSON.stringify({ type: "reasoning", encrypted_content: "gAAAA" }),
			JSON.stringify({ type: "assistant", content: "好的", tool_calls: [{ id: "call_9", name: "read_file", arguments: "{\"path\":\"a\"}" }] }),
			JSON.stringify({ type: "tool_result", tool_call_id: "call_9", content: "文件内容" }),
		].join("\n"));
		return dir;
	}

	it("标题/模型/cwd 来自 summary.json，工具调用与结果按 id 配对", async () => {
		await fixture();
		const [summary] = await grokSource.scan();
		expect(summary).toMatchObject({ source: "grok", externalId: "01a0a4d5-728e-76d0-92d6-ba247553e656", title: "整理索引", projectPath: "D:\\AIApp\\PiWeb", model: "grok-4", messageCount: 4 });

		const read = await grokSource.read(summary);
		const messages = messagesOf(read!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "toolResult"]);
		expect((messages[1] as Extract<ImportedMessage, { role: "assistant" }>).content[0]).toEqual({ type: "thinking", thinking: "先看目录" });
		const call = messages[2] as Extract<ImportedMessage, { role: "assistant" }>;
		expect(call.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(call.content[1]).toMatchObject({ id: "call_9", name: "read_file", arguments: { path: "a" } });
		expect(read!.skipped).toEqual([
			"跳过 1 条合成输入",
			"跳过 1 条仅含加密内容的推理记录",
			"跳过 1 条源工具运行时上下文（pi 会按当前工作区重新生成）",
		]);
	});

	it("只有系统提示与合成提醒、没有真实对话的会话不列进列表", async () => {
		const dir = path.join(roots.grok, "D%3A%5C", "01a04e98-9ac8-7de0-8048-ff46e4a24ba5");
		await write(path.join(dir, "summary.json"), JSON.stringify({ session_summary: "", num_messages: 0, info: { cwd: "D:\\" } }));
		await write(path.join(dir, "chat_history.jsonl"), [
			JSON.stringify({ type: "system", content: "系统提示" }),
			JSON.stringify({ type: "user", content: [{ type: "text", text: "<system-reminder>可用技能一览</system-reminder>" }], synthetic_reason: "system_reminder" }),
		].join("\n"));
		await fixture();
		const summaries = await grokSource.scan();
		expect(summaries.map((summary) => summary.externalId)).toEqual(["01a0a4d5-728e-76d0-92d6-ba247553e656"]);
	});

	it("新版 reasoning 块数组与用户 data URL 图片都能完整导入", async () => {
		const dir = path.join(roots.grok, "D%3A%5C", "session-media");
		await write(path.join(dir, "summary.json"), JSON.stringify({ num_chat_messages: 2, num_messages: 99, info: { cwd: "D:\\" } }));
		await write(path.join(dir, "chat_history.jsonl"), [
			JSON.stringify({ type: "user", content: [{ type: "image", url: "data:image/png;base64,aGVsbG8=" }] }),
			JSON.stringify({ type: "reasoning", summary: [{ type: "summary_text", text: "看图" }] }),
		].join("\n"));
		const summary = (await grokSource.scan()).find((item) => item.externalId === "session-media")!;
		expect(summary.messageCount).toBe(2); // 用 chat 数，不用包含内部 trace 的 num_messages
		const messages = messagesOf((await grokSource.read(summary))!.entries);
		expect(messages[0].content[0]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
		expect(messages[1].content[0]).toEqual({ type: "thinking", thinking: "看图" });
	});

	it("没有 summary.json 的 cwd 时从目录名解出来", async () => {
		const dir = path.join(roots.grok, "D%3A%5CAIApp%5CPiWeb", "session-2");
		await write(path.join(dir, "summary.json"), JSON.stringify({ info: {} }));
		await write(path.join(dir, "chat_history.jsonl"), JSON.stringify({ type: "user", content: "hi" }));
		const [summary] = await grokSource.scan();
		expect(summary.projectPath).toBe("D:\\AIApp\\PiWeb");
	});
});

describe("dsh", () => {
	async function fixture() {
		const dir = path.join(roots.dsh, "--D-AIApp-PiWeb--", "session-9de5f238-e4e1-4b51-b557-cf77c60e7cee");
		const lines = [
			JSON.stringify({ type: "session", version: 0, id: "session-9de5f238-e4e1-4b51-b557-cf77c60e7cee", createdAt: TS, cwd: "D:\\AIApp\\PiWeb" }),
			JSON.stringify({ type: "request/header", seq: 1, time: TS, data: { header: { config: { provider: "laoyou", model: "DeepSeek-V4-Flash-0731" } } } }),
			JSON.stringify({ type: "user/message", seq: 2, time: TS + 100, data: { content: [{ type: "text", text: "看看这个项目" }], source: { kind: "user" }, role: "user", id: "u1" } }),
			JSON.stringify({ type: "user/message", seq: 3, time: TS + 150, data: { content: [{ type: "text", text: "沙箱策略快照" }], source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }, role: "user", id: "u2" } }),
			JSON.stringify({ type: "assistant/message", seq: 4, time: TS + 200, data: { message: { role: "assistant", content: [{ type: "reasoning", text: "先列目录" }, { type: "text", text: "好的" }, { type: "tool-call", id: "call_481f", name: "pwsh", arguments: "{\"command\":\"ls\"}" }] } } }),
			// 与 assistant 里的 tool-call 是同一批调用：不能重复导入
			JSON.stringify({ type: "tool/call", seq: 5, time: TS + 200, data: { callId: "call_481f", name: "pwsh", arguments: "{\"command\":\"ls\"}" } }),
			JSON.stringify({ type: "tool/result", seq: 6, time: TS + 300, data: { message: { source: { kind: "tool", callId: "call_481f" }, content: [{ type: "tool-result", toolCallId: "call_481f", content: [{ type: "text", text: "a.ts" }] }] } } }),
			JSON.stringify({ type: "session/title", seq: 7, time: TS + 400, data: { title: "看看这个项目" } }),
		];
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "session.jsonl.zstd"), multiFrame(lines));
		return dir;
	}

	it("多帧 zstd 能完整解出来（单帧解压只能拿到第一帧）", async () => {
		await fixture();
		const file = path.join(roots.dsh, "--D-AIApp-PiWeb--", "session-9de5f238-e4e1-4b51-b557-cf77c60e7cee", "session.jsonl.zstd");
		const decoded = decodeZstdFrames(await fs.readFile(file)).toString("utf8").trim().split("\n");
		expect(decoded).toHaveLength(8);
		expect(zlib.zstdDecompressSync(await fs.readFile(file)).toString("utf8").trim().split("\n").length).toBeLessThan(8);
	});

	it("工具调用不重复、注入消息被跳过、标题与模型带出来", async () => {
		await fixture();
		const [summary] = await dshSource.scan();
		expect(summary).toMatchObject({ source: "dsh", externalId: "session-9de5f238-e4e1-4b51-b557-cf77c60e7cee", title: "看看这个项目", projectPath: "D:\\AIApp\\PiWeb", provider: "laoyou", model: "DeepSeek-V4-Flash-0731" });

		const read = await dshSource.read(summary);
		const messages = messagesOf(read!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		const assistant = messages[1] as Extract<ImportedMessage, { role: "assistant" }>;
		expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(read!.skipped?.join()).toMatch(/1 条运行时注入消息/);
		expect(read!.summary.model).toBe("DeepSeek-V4-Flash-0731");
	});

	it("建了却没用过的空会话不列进列表（本机 198 条里有 51 条是这种）", async () => {
		const dir = path.join(roots.dsh, "--D-AIApp-PiWeb--", "session-empty");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "session.v3.jsonl.zstd"), multiFrame([
			JSON.stringify({ type: "session", version: 3, id: "session-empty", createdAt: TS, cwd: "D:\\AIApp\\PiWeb" }),
			JSON.stringify({ type: "sandbox/mode", seq: 1, time: TS, data: { mode: "workspace-write" } }),
		]));
		// 有消息的那个照常列出
		await fixture();
		const summaries = await dshSource.scan();
		expect(summaries.map((summary) => summary.externalId)).toEqual(["session-9de5f238-e4e1-4b51-b557-cf77c60e7cee"]);
	});

	it("同一会话同时有 session.jsonl.zstd 与 v3 版本时只列一次，且用 v3（迁移后的规范格式）", async () => {
		const dir = path.join(roots.dsh, "--D-AIApp-PiWeb--", "session-9de5f238-e4e1-4b51-b557-cf77c60e7cee");
		await fixture();
		// 老格式：内容更少（少了流式分片那份历史）
		await fs.writeFile(path.join(dir, "session.v3.jsonl.zstd"), multiFrame([
			JSON.stringify({ type: "session", version: 3, id: "session-9de5f238-e4e1-4b51-b557-cf77c60e7cee", createdAt: TS, cwd: "D:\AIApp\PiWeb" }),
			JSON.stringify({ type: "user/message", seq: 1, time: TS, data: { content: [{ type: "text", text: "v3 里的消息" }], source: { kind: "user" }, role: "user" } }),
			JSON.stringify({ type: "session/title", seq: 2, time: TS, data: { title: "v3 标题" } }),
		]));
		const summaries = await dshSource.scan();
		expect(summaries).toHaveLength(1);
		expect(summaries[0].title).toBe("v3 标题");
		expect(summaries[0].location).toContain("session.v3.jsonl.zstd");
	});

	it("目录名能兜底还原出路径（含 ~XXXX 转义的非 ASCII）", () => {
		expect(decodeCwdDir("--D-AIApp-PiWeb--")).toBe("D:\\AIApp\\PiWeb");
		// 这个编码把 "-" 与路径分隔符写成同一个字符，所以只保证盘符和转义字符能还原；
		// header.cwd 才是权威来源，这里只是它缺失时的兜底
		const decoded = decodeCwdDir("--D-AIApp-Ordo-~524D~7AEF~9875~9762--");
		expect(decoded).toMatch(/^D:\\AIApp\\Ordo/);
		expect(decoded).toContain("前端页面");
		expect(decodeCwdDir("_no-cwd")).toBeUndefined();
	});
});

describe("ZCode / opencode（同一套表结构）", () => {
	async function buildDb(file: string, kind: "zcode" | "opencode") {
		const { DatabaseSync } = await import("node:sqlite");
		await fs.mkdir(path.dirname(file), { recursive: true });
		const db = new DatabaseSync(file);
		// zcode 的 message/part 有 sequence，opencode 没有——适配器就是靠这一点选排序字段
		const sequence = kind === "zcode" ? ", sequence INTEGER" : "";
		db.exec(`
			CREATE TABLE session (id TEXT, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER${kind === "opencode" ? ", model TEXT, tokens_input INTEGER, tokens_output INTEGER" : ""});
			CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT${sequence});
			CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT${sequence});
		`);
		const insert = (table: string, row: Record<string, unknown>) => {
			const keys = Object.keys(row);
			db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...(Object.values(row) as never[]));
		};
		// opencode 没有 sequence 列，传进来的序号要丢掉，否则 INSERT 报"no column named sequence"
		const withSeq = (row: Record<string, unknown>, seq?: number) => (seq === undefined || kind !== "zcode" ? row : { ...row, sequence: seq });
		insert("session", { id: "ses_main", project_id: "p1", parent_id: null, directory: "D:\\AIApp\\PiWeb", title: kind === "opencode" ? "New session - 2026-09-13T04:10:51.000Z" : "整理导入功能", time_created: TS, time_updated: TS + 900 });
		insert("session", { id: "ses_sub", project_id: "p1", parent_id: "ses_main", directory: "D:\\AIApp\\PiWeb", title: "子代理", time_created: TS + 10, time_updated: TS + 20 });

		const model = kind === "zcode" ? { providerId: "laoyou", modelId: "deepseek-v4-flash" } : { providerID: "opencode", modelID: "muse-spark" };
		const message = (id: string, sessionId: string, at: number, data: Record<string, unknown>, seq?: number) =>
			insert("message", withSeq({ id, session_id: sessionId, time_created: at, data: JSON.stringify(data) }, seq));
		const part = (id: string, messageId: string, sessionId: string, at: number, data: Record<string, unknown>, seq?: number) =>
			insert("part", withSeq({ id, message_id: messageId, session_id: sessionId, time_created: at, data: JSON.stringify(data) }, seq));

		message("m1", "ses_main", TS + 100, { role: "user", time: { created: TS + 100 } }, 1);
		part("p1", "m1", "ses_main", TS + 100, { type: "text", text: "看看这个项目" }, 1);
		part("p2", "m1", "ses_main", TS + 110, { type: "step-start" }, 2);
		message("m2", "ses_main", TS + 200, { role: "assistant", time: { created: TS + 200, completed: TS + 500 }, ...model, tokens: { total: 100, input: 80, output: 20, reasoning: 5, cache: { read: 3, write: 1 } }, cost: 0 }, 2);
		part("p3", "m2", "ses_main", TS + 200, { type: "reasoning", text: "先看目录" }, 1);
		part("p4", "m2", "ses_main", TS + 210, { type: "text", text: "好的" }, 2);
		part("p5", "m2", "ses_main", TS + 220, { type: "tool", tool: "read", callID: "call_01a0", state: { status: "completed", input: { filePath: "a.ts" }, output: "文件内容" } }, 3);
		part("p6", "m2", "ses_main", TS + 230, { type: "tool", tool: "bash", callID: "call_fail", state: { status: "error", input: { command: "x" }, error: "命令失败" } }, 4);
		part("p7", "m2", "ses_main", TS + 240, { type: "step-finish" }, 5);
		part("p8", "m2", "ses_main", TS + 250, { type: "compaction", auto: true }, 6);
		db.close();
		return file;
	}

	for (const kind of ["zcode", "opencode"] as const) {
		it(`${kind}: 只列顶层会话，工具调用/结果成对，用量与错误标记带出来`, async () => {
			const file = await buildDb(path.join(root, `${kind}.sqlite`), kind);
			const source = createOcFamilySource(kind, () => file);

			const summaries = await source.scan();
			expect(summaries.map((summary) => summary.externalId)).toEqual(["ses_main"]); // 子代理不列
			const [summary] = summaries;
			expect(summary.title).toBe(kind === "opencode" ? undefined : "整理导入功能"); // "New session - …" 视为无标题
			expect(summary.messageCount).toBe(2);
			expect(summary.projectPath).toBe("D:\\AIApp\\PiWeb");

			const read = await source.read(summary);
			const messages = messagesOf(read!.entries);
			// 一条 assistant 消息装下这一轮的全部块，紧跟每个调用的结果——与 pi 自己写的形状一致
			expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult"]);
			const assistant = messages[1] as Extract<ImportedMessage, { role: "assistant" }>;
			expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall", "toolCall"]);
			expect(assistant.content[2]).toMatchObject({ type: "toolCall", id: "call_01a0", name: "read", arguments: { filePath: "a.ts" } });
			expect(assistant.stopReason).toBe("toolUse");
			expect(assistant.provider).toBe(kind === "zcode" ? "laoyou" : "opencode");
			expect(assistant.usage).toMatchObject({ input: 80, output: 20, reasoning: 5, cacheRead: 3, cacheWrite: 1, totalTokens: 100 });
			expect((messages[2] as Extract<ImportedMessage, { role: "toolResult" }>).content[0]).toEqual({ type: "text", text: "文件内容" });
			expect((messages[3] as Extract<ImportedMessage, { role: "toolResult" }>).isError).toBe(true);
			expect((messages[3] as Extract<ImportedMessage, { role: "toolResult" }>).toolCallId).toBe("call_fail");
			expect(read!.skipped?.join()).toMatch(/内部片段/);
		});

		it(`${kind}: 只读打开，扫完 / 读完之后数据库文件一字节没变`, async () => {
			const file = await buildDb(path.join(root, `${kind}.sqlite`), kind);
			const before = await fs.readFile(file);
			const source = createOcFamilySource(kind, () => file);
			const [summary] = await source.scan();
			await source.read(summary);
			expect(await fs.readFile(file)).toEqual(before);
			// 也不该冒出 -wal / -journal 之类的旁路文件
			const siblings = await fs.readdir(path.dirname(file));
			expect(siblings.filter((name) => name.includes("-wal") || name.includes("-journal") || name.includes("tmp"))).toEqual([]);
		});
	}
});

describe("只扫最近的若干条（界面默认每组 15 条）", () => {
	/** 造 count 条 claude 会话，mtime 依次递增：s01 最旧、s20 最新 */
	async function many(count: number) {
		for (let i = 1; i <= count; i += 1) {
			const file = path.join(roots.claude, "-proj", `s${String(i).padStart(2, "0")}.jsonl`);
			await write(file, JSON.stringify({ type: "user", cwd: "/ws", timestamp: new Date(TS + i * 1000).toISOString(), message: { role: "user", content: `第 ${i} 条` } }));
			const when = new Date(TS + i * 60_000);
			await fs.utimes(file, when, when);
		}
	}

	it("limit 只取最近 N 条（按最近活动倒序），limit 0 取全部", async () => {
		await many(20);
		const capped = await claudeSource.scan({ limit: 5 });
		expect(capped.map((summary) => summary.externalId)).toEqual(["s20", "s19", "s18", "s17", "s16"]);
		// 上限不影响"最近"的定义：返回的就是最新的那几条
		expect(capped.every((summary, index, all) => index === 0 || (all[index - 1].updatedAt ?? 0) >= (summary.updatedAt ?? 0))).toBe(true);
		expect(await claudeSource.scan({ limit: 0 })).toHaveLength(20);
		expect(await claudeSource.scan()).toHaveLength(20); // 不传 = 不限（导入时按 id 反查要用全量）
	});

	it("空会话吃掉的名额会继续往下补，不会让列表短一截", async () => {
		await many(4); // s01..s04，s04 最新
		// 让最新的 s04 变成"只有元信息"的文件：它会被过滤，但 limit 2 仍应给出 s03、s02
		await write(path.join(roots.claude, "-proj", "s04.jsonl"), JSON.stringify({ type: "summary", summary: "没有消息" }));
		const capped = await claudeSource.scan({ limit: 2 });
		expect(capped.map((summary) => summary.externalId)).toEqual(["s03", "s02"]);
	});

	it("Codex 按记录里的活动时间而不是文件 mtime 选最近 N 条", async () => {
		const make = async (id: string, activity: number, mtime: number) => {
			const file = path.join(roots.codex, "2026", "09", "13", `rollout-${id}.jsonl`);
			await write(file, [
				JSON.stringify({ timestamp: new Date(activity - 1000).toISOString(), type: "session_meta", payload: { cwd: "/ws", timestamp: new Date(activity - 1000).toISOString() } }),
				JSON.stringify({ timestamp: new Date(activity).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: id }] } }),
			].join("\n"));
			await fs.utimes(file, new Date(mtime), new Date(mtime));
		};
		await make("old-content-new-mtime", TS, TS + 20_000);
		await make("new-content-old-mtime", TS + 10_000, TS);
		const [latest] = await codexSource.scan({ limit: 1 });
		expect(latest.externalId).toBe("rollout-new-content-old-mtime");
		expect(latest.updatedAt).toBe(TS + 10_000);
	});

	it("Grok 按 summary.updated_at 而不是复制后的文件 mtime 选最近 N 条", async () => {
		const make = async (id: string, activity: number, mtime: number) => {
			const dir = path.join(roots.grok, "D%3A%5C", id);
			await write(path.join(dir, "summary.json"), JSON.stringify({ updated_at: activity, num_chat_messages: 1, info: { cwd: "D:\\" } }));
			const history = await write(path.join(dir, "chat_history.jsonl"), JSON.stringify({ type: "user", content: id }));
			await fs.utimes(history, new Date(mtime), new Date(mtime));
		};
		await make("old-content-new-mtime", TS, TS + 20_000);
		await make("new-content-old-mtime", TS + 10_000, TS);
		const [latest] = await grokSource.scan({ limit: 1 });
		expect(latest.externalId).toBe("new-content-old-mtime");
		expect(latest.updatedAt).toBe(TS + 10_000);
	});

	it("SQLite 来源把上限压进 SQL，且按最近活动排序", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const file = path.join(root, "cap.sqlite");
		const db = new DatabaseSync(file);
		db.exec("CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT);");
		const addSession = (id: string, updated: number) => {
			db.prepare("INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, NULL, ?, ?, ?, ?)").run(id, "D:\ws", id, updated, updated);
			db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(`${id}-m`, id, JSON.stringify({ role: "user" }));
		};
		addSession("old", TS);
		addSession("mid", TS + 1000);
		addSession("new", TS + 2000);
		// 只有标题没消息的一条，不该占名额
		db.prepare("INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, NULL, ?, ?, ?, ?)").run("empty", "D:\ws", "empty", TS + 3000, TS + 3000);
		db.close();

		const source = createOcFamilySource("zcode", () => file);
		expect((await source.scan({ limit: 2 })).map((summary) => summary.externalId)).toEqual(["new", "mid"]);
		expect((await source.scan({ limit: 0 })).map((summary) => summary.externalId)).toEqual(["new", "mid", "old"]);
	});
});

describe("子代理会话不算会话（要的是主代理那条对话）", () => {
	/** claude 的子代理转写放在 <项目>/<会话>/subagents/ 下，内容是主代理派出去的活 */
	it("claude：subagents/ 目录下的转写不列（哪怕记录本身不像侧链）", async () => {
		const sub = path.join(roots.claude, "-proj", "main-session-uuid", "subagents", "agent-x.jsonl");
		await write(sub, [
			JSON.stringify({ type: "user", cwd: "/ws", timestamp: new Date(TS).toISOString(), message: { role: "user", content: "子代理收到的任务" } }),
			JSON.stringify({ type: "assistant", timestamp: new Date(TS + 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "子代理的回复" }] } }),
		].join("\n"));
		await write(path.join(roots.claude, "-proj", "main.jsonl"), [
			JSON.stringify({ type: "user", cwd: "/ws", timestamp: new Date(TS).toISOString(), message: { role: "user", content: "主会话" } }),
		].join("\n"));
		const summaries = await claudeSource.scan({ limit: 0 });
		expect(summaries.map((summary) => summary.externalId)).toEqual(["main"]);
	});

	it("codex：别的线程派出来的 rollout（parent_thread_id）不列", async () => {
		const parent = { timestamp: new Date(TS).toISOString(), type: "session_meta", payload: { cwd: "/ws", model: "gpt-5", thread_source: "user", source: "cli" } };
		const child = { timestamp: new Date(TS).toISOString(), type: "session_meta", payload: { cwd: "/ws", model: "gpt-5", parent_thread_id: "01a07260-cb45", thread_source: "subagent", source: { subagent: { other: "guardian" } } } };
		const message = { timestamp: new Date(TS).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "派给子代理的活" }] } };
		await write(path.join(roots.codex, "2026", "09", "13", "rollout-main.jsonl"), [parent, message].map((r) => JSON.stringify(r)).join("\n"));
		await write(path.join(roots.codex, "2026", "09", "13", "rollout-child.jsonl"), [child, message].map((r) => JSON.stringify(r)).join("\n"));
		const summaries = await codexSource.scan({ limit: 0 });
		expect(summaries.map((summary) => summary.externalId)).toEqual(["rollout-main"]);
	});

	it("grok：session_kind 以 subagent 开头的会话不列", async () => {
		const make = async (id: string, kind?: string) => {
			const dir = path.join(roots.grok, "D%3A%5C", id);
			await write(path.join(dir, "summary.json"), JSON.stringify({ session_summary: id, num_messages: 2, created_at: TS, session_kind: kind, info: { cwd: "D:\\" } }));
			await write(path.join(dir, "chat_history.jsonl"), [
				JSON.stringify({ type: "user", content: "你好" }),
				JSON.stringify({ type: "assistant", content: "在" }),
			].join("\n"));
		};
		await make("main-session");
		await make("sub-session", "subagent");
		await make("sub-fork", "subagent_fork");
		const summaries = await grokSource.scan({ limit: 0 });
		expect(summaries.map((summary) => summary.externalId)).toEqual(["main-session"]);
	});

	it("dsh：header 里 delegationDepth > 0 的会话不列", async () => {
		const make = async (id: string, depth: number) => {
			const dir = path.join(roots.dsh, "--D--ws--", id);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, "session.jsonl.zstd"), multiFrame([
				JSON.stringify({ type: "session", version: 3, id, createdAt: TS, cwd: "D:\ws", delegationDepth: depth }),
				JSON.stringify({ type: "user/message", seq: 1, time: TS, data: { content: [{ type: "text", text: "你好" }], source: { kind: "user" }, role: "user" } }),
				JSON.stringify({ type: "assistant/message", seq: 2, time: TS + 1000, data: { message: { role: "assistant", content: [{ type: "text", text: "在" }] } } }),
			]));
		};
		await make("session-main", 0);
		await make("session-sub", 1);
		const summaries = await dshSource.scan({ limit: 0 });
		expect(summaries.map((summary) => summary.externalId)).toEqual(["session-main"]);
	});
});
