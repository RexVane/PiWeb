/**
 * 各来源适配器：用"最小但真实"的样本（字段按本机真实文件抄）验证映射。
 *
 * 每个来源的样本目录通过 mock `paths` 指到临时目录，避免碰真实用户数据。
 * 断言的重点是**无损**：三类角色、思考、工具调用与结果的配对、时间戳、标题、模型。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots = {
	claude: "",
	codex: "",
	grok: "",
	dsh: "",
	zcode: "",
	opencode: "",
	kimi: "",
	kimiHome: "",
	workbuddy: [] as string[],
	antigravity: "",
	antigravityCli: "",
	qwenProjects: "",
	qwenTmp: "",
	cursor: "",
};

vi.mock("../src/lib/session-import/paths", () => ({
	claudeRoot: () => roots.claude,
	codexRoot: () => roots.codex,
	grokRoot: () => roots.grok,
	dshRoot: () => roots.dsh,
	zcodeDb: () => roots.zcode,
	opencodeDb: () => roots.opencode,
	kimiSessionsRoot: () => roots.kimi,
	kimiHome: () => roots.kimiHome,
	workbuddyRoots: () => roots.workbuddy,
	antigravityRoot: () => roots.antigravity,
	antigravityCliRoot: () => roots.antigravityCli,
	qwenProjectsRoot: () => roots.qwenProjects,
	qwenLegacyTmpRoot: () => roots.qwenTmp,
	cursorChatsRoot: () => roots.cursor,
}));

import { claudeSource } from "../src/lib/session-import/claude";
import { codexSource } from "../src/lib/session-import/codex";
import { grokSource } from "../src/lib/session-import/grok";
import { dshSource, decodeCwdDir } from "../src/lib/session-import/dsh";
import { kimiSource } from "../src/lib/session-import/kimi";
import { workbuddySource } from "../src/lib/session-import/workbuddy";
import { antigravitySource, antigravityCliSource } from "../src/lib/session-import/antigravity";
import { qwenSource } from "../src/lib/session-import/qwen";
import { cursorSource } from "../src/lib/session-import/cursor";
import { createOcFamilySource } from "../src/lib/session-import/oc-family";
import { decodeZstdFrames, readZstdHead } from "../src/lib/session-import/dsh-zstd";
import type { ImportedEntry, ImportedMessage } from "../src/lib/session-import/types";

let root: string;
const TS = Date.UTC(2026, 8, 13, 4, 10, 51);

/** dsh 的真实文件是多帧 zstd 拼接，这里按同样方式合成。 */
function multiFrame(lines: string[], perFrame = 2): Buffer {
	const frames: Buffer[] = [];
	for (let index = 0; index < lines.length; index += perFrame) {
		frames.push(zlib.zstdCompressSync(Buffer.from(`${lines.slice(index, index + perFrame).join("\n")}\n`, "utf8")));
	}
	return Buffer.concat(frames);
}

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-import-src-")));
	roots.claude = path.join(root, "claude");
	roots.codex = path.join(root, "codex");
	roots.grok = path.join(root, "grok");
	roots.dsh = path.join(root, "dsh");
	roots.zcode = path.join(root, "zcode");
	roots.opencode = path.join(root, "opencode");
	roots.kimi = path.join(root, "kimi", "sessions");
	roots.kimiHome = path.join(root, "kimi");
	roots.workbuddy = [path.join(root, "workbuddy")];
	roots.antigravity = path.join(root, "antigravity");
	roots.antigravityCli = path.join(root, "antigravity-cli");
	roots.qwenProjects = path.join(root, "qwen", "projects");
	roots.qwenTmp = path.join(root, "qwen", "tmp");
	roots.cursor = path.join(root, "cursor-chats");
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
	it("does not import background-task notifications as user messages or conversation titles", async () => {
		const notification = "<task-notification><task-id>task-1</task-id><status>killed</status><summary>Background server stopped</summary></task-notification>";
		const question = `请解释这段通知：${notification}`;
		await write(path.join(roots.claude, "-proj", "notifications.jsonl"), [
			{ type: "user", cwd: root, origin: { kind: "task-notification" }, promptSource: "system", message: { content: notification } },
			{ type: "user", cwd: root, message: { content: "真正的提问" } },
			{ type: "user", message: { content: [{ type: "text", text: notification }] } },
			{ type: "user", message: { content: question } },
			{ type: "user", message: { content: [{ type: "text", text: notification }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }] } },
		].map((line) => JSON.stringify(line)).join("\n"));
		const [summary] = await claudeSource.scan();
		expect(summary.title).toBe("真正的提问");
		const imported = (await claudeSource.read(summary))!;
		expect(messagesOf(imported.entries).map((message) => message.content)).toEqual([
			[{ type: "text", text: "真正的提问" }], [{ type: "text", text: question }],
			[{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }, { type: "text", text: notification }],
		]);
		expect(imported.skipped?.join()).toMatch(/2 条合成输入/);
	});

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

	it("按 message.id 把拆开的记录合回一条回复：并行调用不再拆散，用量只记一次，stop_reason 转成 pi 的写法", async () => {
		// 真实形状：一次回复按块拆成多行、共用 id 与 usage；流式时工具边跑边出结果，同一 id 的行之间夹着 tool_result
		const usage = { input_tokens: 4853, output_tokens: 483, cache_read_input_tokens: 0, cache_creation_input_tokens: 33978 };
		const reply = (content: unknown[], at: number, id = "msg_1", stop = "tool_use", replyUsage: unknown = usage) =>
			JSON.stringify({ type: "assistant", timestamp: new Date(TS + at).toISOString(), message: { id, role: "assistant", model: "claude-opus-4-1", stop_reason: stop, usage: replyUsage, content } });
		const result = (id: string, at: number) =>
			JSON.stringify({ type: "user", timestamp: new Date(TS + at).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `${id} ok` }] } });
		const file = path.join(roots.claude, "-D-AIApp-PiWeb", "1b6c1c5e-9f0e-4e7e-9d55-5f6a2b0c7a11.jsonl");
		await write(file, [
			JSON.stringify({ type: "user", cwd: "D:\\AIApp\\PiWeb", timestamp: new Date(TS).toISOString(), message: { role: "user", content: "改一下这三个文件" } }),
			reply([{ type: "thinking", thinking: "三个文件可以并行读" }], 1000),
			reply([{ type: "text", text: "我先把三个文件读出来" }], 1001),
			reply([{ type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "a.ts" } }], 1002),
			reply([{ type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "b.ts" } }], 1003),
			result("toolu_a", 1004),
			reply([{ type: "tool_use", id: "toolu_c", name: "Read", input: { file_path: "c.ts" } }], 1005),
			result("toolu_b", 1006),
			result("toolu_c", 1007),
			reply([{ type: "text", text: "都改好了" }], 2000, "msg_2", "end_turn", { input_tokens: 10, output_tokens: 5 }),
		].join("\n"));
		const [summary] = await claudeSource.scan();
		const messages = messagesOf((await claudeSource.read(summary))!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "toolResult", "assistant"]);
		const first = messages[1] as Extract<ImportedMessage, { role: "assistant" }>;
		expect(first.content.map((block) => (block.type === "toolCall" ? block.id : block.type))).toEqual(["thinking", "text", "toolu_a", "toolu_b", "toolu_c"]);
		expect(first.stopReason).toBe("toolUse");
		expect(first.timestamp).toBe(TS + 1000);
		expect(first.usage).toEqual({ input: 4853, output: 483, cacheRead: 0, cacheWrite: 33978 });
		// 收尾的说明是最终回答：pi 只认 stop，原样的 end_turn 会让界面把它当成中途输出
		expect((messages[5] as Extract<ImportedMessage, { role: "assistant" }>).stopReason).toBe("stop");
		// pi-ai 的规则：带调用的 assistant 之后、下一条 assistant/user 之前，每个调用都要有结果，否则补 "No result provided"，
		// 真结果随后变成孤儿，Anthropic 直接 400
		let pending = new Set<string>();
		for (const message of messages) {
			if (message.role === "toolResult") {
				pending.delete(message.toolCallId);
				continue;
			}
			expect([...pending]).toEqual([]);
			pending = new Set(message.role === "assistant" ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) : []);
		}
		expect([...pending]).toEqual([]);
	});

	it("refusal 记成 error 并带上原因，max_tokens 记成 length", async () => {
		const file = path.join(roots.claude, "-D-AIApp-PiWeb", "8a4f0c2e-1d3b-4c5a-9e7f-0b1c2d3e4f5a.jsonl");
		await write(file, [
			JSON.stringify({ type: "user", cwd: "D:\\AIApp\\PiWeb", timestamp: new Date(TS).toISOString(), message: { role: "user", content: "第一问" } }),
			JSON.stringify({ type: "assistant", timestamp: new Date(TS + 1000).toISOString(), message: { id: "msg_r", role: "assistant", stop_reason: "refusal", content: [{ type: "text", text: "不能做" }] } }),
			JSON.stringify({ type: "user", timestamp: new Date(TS + 2000).toISOString(), message: { role: "user", content: "第二问" } }),
			JSON.stringify({ type: "assistant", timestamp: new Date(TS + 3000).toISOString(), message: { id: "msg_l", role: "assistant", stop_reason: "max_tokens", content: [{ type: "text", text: "写到一半" }] } }),
		].join("\n"));
		const [summary] = await claudeSource.scan();
		const assistants = messagesOf((await claudeSource.read(summary))!.entries).filter((message): message is Extract<ImportedMessage, { role: "assistant" }> => message.role === "assistant");
		expect(assistants.map((message) => [message.stopReason, message.errorMessage])).toEqual([["error", "Claude stopped with: refusal"], ["length", undefined]]);
	});
});

describe("Codex CLI", () => {
	async function fixture() {
		const file = path.join(roots.codex, "2026", "09", "13", "rollout-2026-09-13T18-03-08-01a09a38-7d6c-7b40-8d8a-c4e384b101b5.jsonl");
		await write(file, [
			JSON.stringify({ timestamp: new Date(TS).toISOString(), type: "session_meta", payload: { cwd: "D:\\AIApp\\PiWeb", timestamp: new Date(TS).toISOString(), model: "gpt-5-codex", model_provider: "openai", base_instructions: "x".repeat(20000) } }),
			JSON.stringify({ timestamp: new Date(TS).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "修复这个 bug" }] } }),
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
		const reasoning = messages[1] as Extract<ImportedMessage, { role: "assistant" }>;
		expect(reasoning.content[0]).toEqual({ type: "thinking", thinking: "定位到类型错误" });
		const call = messages[3] as Extract<ImportedMessage, { role: "assistant" }>;
		expect(call.content[0]).toMatchObject({ type: "toolCall", id: "call_1", name: "shell", arguments: { command: "npm test" } });
		expect((messages[4] as Extract<ImportedMessage, { role: "toolResult" }>).toolCallId).toBe("call_1");
		// 跳过计数汇总成两行，不逐条刷屏
		expect(read!.skipped).toEqual(["跳过 1 条合成输入", "跳过 1 条仅含加密内容的推理记录"]);
	});
});

describe("Grok CLI", () => {
	it("retains a valid history when summary.json is missing or malformed", async () => {
		for (const [id, summary] of [["missing-summary", undefined], ["broken-summary", "{unfinished"]] as const) {
			const dir = path.join(roots.grok, "D%3A%5CAIApp%5CPiWeb", id);
			await write(path.join(dir, "chat_history.jsonl"), JSON.stringify({ type: "user", content: id }));
			if (summary) await write(path.join(dir, "summary.json"), summary);
		}
		const summaries = await grokSource.scan();
		expect(summaries.map((item) => item.externalId).sort()).toEqual(["broken-summary", "missing-summary"]);
		for (const summary of summaries) {
			expect(summary.projectPath).toBe("D:\\AIApp\\PiWeb");
			expect(messagesOf((await grokSource.read(summary))!.entries)).toHaveLength(1);
		}
	});
	async function fixture() {
		const dir = path.join(roots.grok, "D%3A%5CAIApp%5CPiWeb", "01a0a4d5-728e-76d0-92d6-ba247553e656");
		await write(path.join(dir, "summary.json"), JSON.stringify({ session_summary: "整理索引", current_model_id: "grok-4", num_messages: 4, created_at: TS, updated_at: TS + 500, info: { cwd: "D:\\AIApp\\PiWeb" } }));
		await write(path.join(dir, "chat_history.jsonl"), [
			JSON.stringify({ type: "system", content: "系统提示" }),
			JSON.stringify({ type: "user", content: "把这个整理一下" }),
			JSON.stringify({ type: "user", content: "注入的提醒", synthetic_reason: "reminder" }),
			JSON.stringify({ type: "reasoning", summary: "先看目录" }),
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
		expect(read!.skipped).toEqual(["跳过 1 条合成输入", "跳过 1 条仅含加密内容的推理记录"]);
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

	it("没有 summary.json 的 cwd 时从目录名解出来", async () => {
		const dir = path.join(roots.grok, "D%3A%5CAIApp%5CPiWeb", "session-2");
		await write(path.join(dir, "summary.json"), JSON.stringify({ info: {} }));
		await write(path.join(dir, "chat_history.jsonl"), JSON.stringify({ type: "user", content: "hi" }));
		const [summary] = await grokSource.scan();
		expect(summary.projectPath).toBe("D:\\AIApp\\PiWeb");
	});
});

describe("import source failure boundaries", () => {
	it.each([claudeSource, codexSource, grokSource, dshSource])("%s keeps good records and reports malformed JSON lines", async (source) => {
		const user = source.id === "claude" ? { type: "user", cwd: root, message: { role: "user", content: "keep me" } }
			: source.id === "codex" ? { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "keep me" }] } }
				: source.id === "grok" ? { type: "user", content: "keep me" }
					: { type: "user/message", time: TS, data: { content: [{ type: "text", text: "keep me" }], source: { kind: "user" }, role: "user" } };
		const records = [JSON.stringify({ type: "session", cwd: root, createdAt: TS }), "{truncated", JSON.stringify(user)];
		const file = path.join(root, `${source.id}-broken.jsonl`);
		await fs.writeFile(file, source.id === "dsh" ? multiFrame(records) : records.join("\n"));
		const imported = await source.read({ source: source.id, externalId: "broken", projectPath: root, location: file });
		expect(messagesOf(imported!.entries)).toHaveLength(1);
		expect(imported!.skipped?.join()).toContain("1 行损坏");
	});
	it.each([claudeSource, codexSource, grokSource, dshSource])("%s handles a source removed after scanning without throwing", async (source) => {
		expect(await source.read({ source: source.id, externalId: "gone", projectPath: root, location: path.join(root, "no-longer-exists") })).toBeNull();
	});
	it("does not certify a truncated compressed history as an empty complete session", async () => {
		const raw = multiFrame([JSON.stringify({ type: "session", cwd: root }), JSON.stringify({ type: "user/message", data: { content: "hello" } })], 1);
		const truncated = raw.subarray(0, raw.length - 5);
		const file = path.join(root, "truncated.jsonl.zstd"); await fs.writeFile(file, truncated);
		expect(() => decodeZstdFrames(truncated)).toThrow("无法解压");
		expect((await readZstdHead(file)).complete).toBe(false);
		expect(await dshSource.read({ source: "dsh", externalId: "truncated", projectPath: root, location: file })).toBeNull();
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

	it("多帧 zstd 完整保留每帧记录和末尾标题", async () => {
		await fixture();
		const file = path.join(roots.dsh, "--D-AIApp-PiWeb--", "session-9de5f238-e4e1-4b51-b557-cf77c60e7cee", "session.jsonl.zstd");
		const decoded = decodeZstdFrames(await fs.readFile(file)).toString("utf8").trim().split("\n");
		expect(decoded).toHaveLength(8);
		const records = decoded.map((line) => JSON.parse(line));
		expect(records.map((record) => record.type)).toEqual([
			"session", "request/header", "user/message", "user/message",
			"assistant/message", "tool/call", "tool/result", "session/title",
		]);
		expect(records.slice(1).map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(records[7].data.title).toBe("看看这个项目");
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
	it("lists a Codex session whose first user message follows a large instruction block", async () => {
		const file = path.join(roots.codex, "rollout-large-prompt.jsonl");
		await write(file, [
			JSON.stringify({ type: "session_meta", payload: { cwd: "D:\\ws" } }),
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "x".repeat(100_000) }] } }),
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "real question" }] } }),
		].join("\n"));
		expect((await codexSource.scan()).map((item) => item.externalId)).toContain("rollout-large-prompt");
	});
	it("rejects zstd output over a cumulative limit before constructing the final buffer", () => {
		const raw = Buffer.concat([zlib.zstdCompressSync(Buffer.alloc(128, 65)), zlib.zstdCompressSync(Buffer.alloc(128, 66))]);
		expect(() => decodeZstdFrames(raw, 200)).toThrow("大小上限");
	});
	it("reports a corrupt SQLite source instead of an empty successful scan", async () => {
		const file = path.join(root, "corrupt.sqlite"); await fs.writeFile(file, "not a database");
		await expect(createOcFamilySource("zcode", () => file).scan()).rejects.toThrow("源会话库");
	});
	it("filters soft deleted and archived SQLite sessions while retaining zero-valued lifecycle fields", async () => {
		const { DatabaseSync } = await import("node:sqlite"); const file = path.join(root, "lifecycle.sqlite"); const db = new DatabaseSync(file);
		db.exec("CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_deleted INTEGER, time_archived INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
		for (const [id, deleted, archived] of [["active", 0, 0], ["deleted", TS, 0], ["archived", 0, TS]] as const) {
			db.prepare("INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?, ?, ?)").run(id, "D:\\ws", id, TS, TS, deleted, archived);
			db.prepare("INSERT INTO message VALUES (?, ?, ?)").run(`${id}-m`, id, "{}");
		}
		db.close(); expect((await createOcFamilySource("zcode", () => file).scan()).map((item) => item.externalId)).toEqual(["active"]);
	});
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

describe("Kimi Code", () => {
	it("从 state.json 取标题/工作区，按 wire.jsonl 还原提示、思考、工具调用与结果", async () => {
		const project = path.join(root, "proj");
		await fs.mkdir(project, { recursive: true });
		const dir = path.join(roots.kimi, "wd_D--proj", "abc123");
		await write(path.join(dir, "state.json"), JSON.stringify({ title: "整理项目", cwd: project, createdAt: TS, updatedAt: TS + 10_000 }));
		await write(path.join(dir, "agents", "main", "wire.jsonl"), [
			{ type: "metadata", protocol_version: "1.4", created_at: TS },
			{ type: "turn.prompt", origin: { kind: "user" }, input: [{ type: "text", text: "帮我看下项目" }], time: TS },
			{ type: "turn.prompt", origin: { kind: "system_trigger", name: "subagent" }, input: [{ type: "text", text: "子代理任务" }], time: TS + 1 },
			{ type: "context.append_loop_event", event: { type: "content.part", part: { type: "think", think: "先找入口" } }, time: TS + 2 },
			{ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "我先读一下" } }, time: TS + 3 },
			{ type: "context.append_loop_event", event: { type: "tool.call", name: "read_file", toolCallId: "c1", args: { path: "a.ts" } }, time: TS + 4 },
			{ type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "c1", result: { output: "文件内容" } }, time: TS + 5 },
			{ type: "usage.record", model: "kimi-code/k3", usage: {}, time: TS + 6 },
			{ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "好了" } }, time: TS + 7 },
		].map((line) => JSON.stringify(line)).join("\n"));

		const [summary] = await kimiSource.scan({ limit: 0 });
		expect(summary).toMatchObject({ source: "kimi", externalId: "abc123", title: "整理项目", projectPath: project });

		const imported = await kimiSource.read(summary);
		expect(imported).not.toBeNull();
		const messages = messagesOf(imported!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const assistant = messages[1];
		if (assistant.role !== "assistant") throw new Error("expected assistant");
		expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(assistant.stopReason).toBe("toolUse");
		const result = messages[2];
		if (result.role !== "toolResult") throw new Error("expected tool result");
		expect(result.toolCallId).toBe("c1");
		expect(result.toolName).toBe("read_file");
		expect(imported!.summary.model).toBe("kimi-code/k3");
		expect(imported!.skipped ?? []).toContain("跳过 1 条非用户触发的注入消息");
	});
});

describe("WorkBuddy", () => {
	it("读取 projects/ 下的 jsonl：系统提醒不进对话，工具调用与结果配对，标题取 ai-title", async () => {
		const project = "/work/wb";
		const dir = path.join(roots.workbuddy[0], "projects", "Users-me-WorkBuddy-launch");
		await write(path.join(dir, "s1.jsonl"), [
			{ id: "u1", timestamp: TS, type: "message", role: "user", content: [{ type: "input_text", text: "<system-reminder data-role=\"user-context\">OS: darwin</system-reminder>" }, { type: "input_text", text: "Draft the launch notes" }], cwd: project },
			{ timestamp: TS + 1, type: "ai-title", aiTitle: "Launch notes draft", cwd: project },
			{ id: "a1", timestamp: TS + 2, type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading." }], providerData: { model: "hy3" }, cwd: project },
			{ id: "a1", timestamp: TS + 3, type: "function_call", name: "Read", callId: "c1", arguments: JSON.stringify({ path: "notes.md" }), providerData: { model: "hy3" }, cwd: project },
			{ id: "t1", timestamp: TS + 4, type: "function_call_result", name: "Read", callId: "c1", output: { type: "text", text: "notes" }, cwd: project },
			{ id: "a2", timestamp: TS + 5, type: "message", role: "assistant", content: [{ type: "output_text", text: "Here they are." }], providerData: { model: "hy3" }, cwd: project },
		].map((line) => JSON.stringify(line)).join("\n"));
		// 子代理会话不列
		await write(path.join(dir, "s2", "subagents", "sub.jsonl"), JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "子任务" }], cwd: project }));

		const summaries = await workbuddySource.scan({ limit: 0 });
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({ source: "workbuddy", externalId: "workbuddy:s1", title: "Launch notes draft", projectPath: project });

		const imported = await workbuddySource.read(summaries[0]);
		const messages = messagesOf(imported!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "toolResult", "assistant"]);
		const user = messages[0];
		if (user.role !== "user") throw new Error("expected user");
		expect(user.content).toEqual([{ type: "text", text: "Draft the launch notes" }]);
		const call = messages[2];
		if (call.role !== "assistant") throw new Error("expected assistant");
		expect(call.content[0]).toMatchObject({ type: "toolCall", id: "c1", name: "Read" });
		const result = messages[3];
		if (result.role !== "toolResult") throw new Error("expected tool result");
		expect(result.toolCallId).toBe("c1");
		expect(result.content).toEqual([{ type: "text", text: "notes" }]);
	});
});

describe("Antigravity / Antigravity CLI", () => {
	async function buildSummaries(file: string, rows: Array<Record<string, unknown>>) {
		const { DatabaseSync } = await import("node:sqlite");
		await fs.mkdir(path.dirname(file), { recursive: true });
		const db = new DatabaseSync(file);
		db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, parent_conversation_id TEXT, nesting_depth INTEGER)");
		const insert = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
		for (const row of rows) {
			insert.run(
				String(row.conversation_id ?? ""),
				String(row.title ?? ""),
				String(row.preview ?? ""),
				Number(row.step_count ?? 0),
				String(row.last_modified_time ?? ""),
				String(row.workspace_uris ?? ""),
				String(row.parent_conversation_id ?? ""),
				Number(row.nesting_depth ?? 0),
			);
		}
		db.close();
	}

	function transcriptPath(agyRoot: string, conversationId: string): string {
		return path.join(agyRoot, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl");
	}

	it("从 conversation_summaries.db 取标题/工作区，读取 transcript 的用户请求、思考与工具结果", async () => {
		const project = path.join(root, "agyproj");
		await fs.mkdir(project, { recursive: true });
		await buildSummaries(path.join(roots.antigravity, "conversation_summaries.db"), [
			{ conversation_id: "conv1", title: "需求整理", last_modified_time: "2026-11-14 13:32:00.1234567+00:00", workspace_uris: JSON.stringify([pathToFileURL(project).href]) },
			{ conversation_id: "sub1", title: "子代理", last_modified_time: "2026-11-14 13:32:00+00:00", workspace_uris: JSON.stringify([pathToFileURL(project).href]), parent_conversation_id: "conv1", nesting_depth: 1 },
			{ conversation_id: "outside", title: "项目外", last_modified_time: "2026-11-14 13:32:00+00:00", workspace_uris: "[]" },
		]);
		await write(transcriptPath(roots.antigravity, "conv1"), [
			{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-11-14T13:30:56Z", content: "<USER_REQUEST>\n修一下这个问题\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-14T21:30:56+08:00.\n</ADDITIONAL_METADATA>" },
			{ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-14T13:30:58Z", thinking: "先定位", content: "我看看", tool_calls: [{ name: "read_file", args: { Path: "a.ts" } }] },
			{ step_index: 2, source: "MODEL", type: "GENERIC", created_at: "2026-11-14T13:31:10Z", content: "Created At: 2026-11-14T21:31:10+08:00\nCompleted At: 2026-11-14T21:31:11+08:00\n文件内容" },
			{ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-14T13:31:20Z", content: "好了" },
			// 同一步骤重写：后写的覆盖
			{ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-14T13:30:58Z", thinking: "先定位", content: "我看看（重写）", tool_calls: [{ name: "read_file", args: { Path: "a.ts" } }] },
		].map((line) => JSON.stringify(line)).join("\n"));

		const summaries = await antigravitySource.scan({ limit: 0 });
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({ source: "antigravity", externalId: "conv1", title: "需求整理" });
		expect(path.resolve(summaries[0].projectPath!)).toBe(path.resolve(project));

		const imported = await antigravitySource.read(summaries[0]);
		const messages = messagesOf(imported!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const user = messages[0];
		if (user.role !== "user") throw new Error("expected user");
		expect(user.content).toEqual([{ type: "text", text: "修一下这个问题" }]);
		const assistant = messages[1];
		if (assistant.role !== "assistant") throw new Error("expected assistant");
		expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(assistant.content[1]).toMatchObject({ type: "text", text: "我看看（重写）" });
		expect(assistant.content[2]).toMatchObject({ type: "toolCall", id: "agy-1-0", name: "read_file" });
		const result = messages[2];
		if (result.role !== "toolResult") throw new Error("expected tool result");
		expect(result.toolCallId).toBe("agy-1-0");
		expect(result.content).toEqual([{ type: "text", text: "文件内容" }]);
	});

	it("Antigravity CLI 用同一套格式，来源标记为 antigravity-cli", async () => {
		const project = path.join(root, "agycliproj");
		await fs.mkdir(project, { recursive: true });
		await buildSummaries(path.join(roots.antigravityCli, "conversation_summaries.db"), [
			{ conversation_id: "cli1", title: "命令行会话", last_modified_time: "2026-11-14 13:32:00+00:00", workspace_uris: JSON.stringify([pathToFileURL(project).href]) },
		]);
		await write(transcriptPath(roots.antigravityCli, "cli1"), [
			{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-11-14T13:30:56Z", content: "看看这个项目" },
			{ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-14T13:30:58Z", content: "好的" },
		].map((line) => JSON.stringify(line)).join("\n"));

		const summaries = await antigravityCliSource.scan({ limit: 0 });
		expect(summaries.map((summary) => summary.source)).toEqual(["antigravity-cli"]);
		const imported = await antigravityCliSource.read(summaries[0]);
		expect(messagesOf(imported!.entries).map((message) => message.role)).toEqual(["user", "assistant"]);
	});
});

describe("Qwen Code", () => {
	it("新布局 JSONL：用户/模型消息、思考、functionCall 与 functionResponse 还原成工具结果", async () => {
		const project = path.join(root, "qwenproj");
		await fs.mkdir(project, { recursive: true });
		const encoded = "D--qwenproj";
		const file = path.join(roots.qwenProjects, encoded, "chats", "s1.jsonl");
		await write(file, [
			{ sessionId: "s1", startTime: new Date(TS).toISOString(), lastUpdated: new Date(TS + 10_000).toISOString(), cwd: project },
			{ type: "user", sessionId: "s1", timestamp: TS, message: { role: "user", parts: [{ text: "看一下这个函数" }] } },
			{ type: "assistant", sessionId: "s1", timestamp: TS + 1, message: { role: "model", parts: [{ text: "先想一下", thought: true }, { text: "我读一下" }, { functionCall: { name: "read_file", args: { path: "a.ts" } } }] } },
			{ type: "user", sessionId: "s1", timestamp: TS + 2, message: { role: "user", parts: [{ functionResponse: { name: "read_file", response: { output: "文件内容" } } }] } },
			{ type: "assistant", sessionId: "s1", timestamp: TS + 3, message: { role: "model", parts: [{ text: "好了" }] } },
		].map((line) => JSON.stringify(line)).join("\n"));

		const summaries = await qwenSource.scan({ limit: 0 });
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({ source: "qwen", externalId: "s1", projectPath: project, title: "看一下这个函数" });

		const imported = await qwenSource.read(summaries[0]);
		const messages = messagesOf(imported!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const assistant = messages[1];
		if (assistant.role !== "assistant") throw new Error("expected assistant");
		expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(assistant.stopReason).toBe("toolUse");
		const result = messages[2];
		if (result.role !== "toolResult") throw new Error("expected tool result");
		expect(result.toolCallId).toBe("qwen-3-2");
		expect(result.content).toEqual([{ type: "text", text: "文件内容" }]);
	});

	it("老布局（Gemini CLI fork）支持超 512KB 多行格式化 JSON、toolCalls 结果与 POSIX 编码目录兜底", async () => {
		const project = path.join(root, "qwenold-my-app");
		await fs.mkdir(project, { recursive: true });
		const posixOrWinEncoded = process.platform === "win32"
			? project.replace(/^([A-Za-z]):[\\/]/, "$1--").replace(/[\\/]/g, "-")
			: `-${project.replace(/^\/+/, "").replace(/\//g, "-")}`;
		const file = path.join(roots.qwenTmp, posixOrWinEncoded, "chats", "session-1.json");
		const bigText = `看看这个 ${"x".repeat(540 * 1024)}`;
		await write(file, JSON.stringify({
			sessionId: "session-1",
			startTime: new Date(TS).toISOString(),
			lastUpdated: new Date(TS + 1000).toISOString(),
			messages: [
				{ type: "user", timestamp: new Date(TS).toISOString(), content: [{ text: bigText }] },
				{
					type: "gemini",
					timestamp: new Date(TS + 500).toISOString(),
					content: [{ text: "好的" }],
					toolCalls: [
						{ id: "tc-1", name: "run_shell_command", args: { command: "pwd" }, result: { output: "/workspace" } },
						{},
					],
				},
			],
		}, null, 2));
		const summaries = await qwenSource.scan({ limit: 0 });
		expect(summaries).toHaveLength(1);
		expect(summaries[0].externalId).toBe("session-1");
		expect(path.resolve(summaries[0].projectPath!)).toBe(path.resolve(project));

		const imported = await qwenSource.read(summaries[0]);
		expect(imported!.skipped).toEqual([]);
		const messages = messagesOf(imported!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "tc-1", content: [{ type: "text", text: "/workspace" }] });
	});
});

describe("Cursor（Agent CLI）", () => {
	async function buildStore(dir: string, blobs: Array<Record<string, unknown> | Buffer>, meta: Record<string, unknown>) {
		const { DatabaseSync } = await import("node:sqlite");
		await fs.mkdir(dir, { recursive: true });
		const db = new DatabaseSync(path.join(dir, "store.db"));
		db.exec("CREATE TABLE blobs (id TEXT, data BLOB); CREATE TABLE meta (key TEXT, value BLOB)");
		const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
		blobs.forEach((blob, index) => {
			insert.run(`blob-${index}`, Buffer.isBuffer(blob) ? blob : JSON.stringify(blob));
		});
		db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("0", JSON.stringify(meta));
		db.close();
	}

	it("从 store.db 的 JSON blob 还原对话，跳过 protobuf 回合图，且按 updatedAt 排序后再应用 limit", async () => {
		const project = path.join(root, "cursorproj");
		await fs.mkdir(project, { recursive: true });
		const oldDir = path.join(roots.cursor, "0000", "old-session");
		await buildStore(oldDir, [{ role: "user", content: "旧消息", createdAt: 1000 }], { workspacePath: project, createdAt: 1000, updatedAt: 1000 });
		await write(path.join(oldDir, "meta.json"), JSON.stringify({ schemaVersion: 1, title: "旧会话", createdAtMs: 1000, updatedAtMs: 1000, hasConversation: true }));

		const sessionDir = path.join(roots.cursor, "ffff", "3f0e1d2c-1111-4222-8333-444455556666");
		await buildStore(sessionDir, [
			{ role: "user", content: "<user_query>看一下这个函数</user_query>", createdAt: TS },
			{ role: "assistant", content: [{ type: "text", text: "我读一下" }, { type: "tool-call", toolCallId: "call1", toolName: "Read", args: { path: "a.ts" } }], createdAt: TS + 1, providerOptions: { cursor: { modelName: "composer-2.5" } } },
			{ role: "tool", content: [{ type: "tool-result", toolCallId: "call1", toolName: "Read", result: { type: "text", text: "文件内容" } }], createdAt: TS + 2 },
			Buffer.from([0x08, 0x96, 0x01, 0x12, 0x04, 0xde, 0xad, 0xbe, 0xef]), // protobuf 回合图：跳过
			{ role: "assistant", content: [{ type: "text", text: "好了" }], createdAt: TS + 3 },
		], { workspacePath: project, createdAt: TS, lastUsedModel: "composer-2.5" });
		await write(path.join(sessionDir, "meta.json"), JSON.stringify({ schemaVersion: 1, title: "整理函数", createdAtMs: TS, updatedAtMs: TS + 10_000, hasConversation: true }));

		const topOne = await cursorSource.scan({ limit: 1 });
		expect(topOne.map((s) => s.externalId)).toEqual(["3f0e1d2c-1111-4222-8333-444455556666"]);

		const summaries = await cursorSource.scan({ limit: 0 });
		expect(summaries).toHaveLength(2);
		expect(summaries[0]).toMatchObject({ source: "cursor", externalId: "3f0e1d2c-1111-4222-8333-444455556666", title: "整理函数", projectPath: project });

		const imported = await cursorSource.read(summaries[0]);
		const messages = messagesOf(imported!.entries);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const user = messages[0];
		if (user.role !== "user") throw new Error("expected user");
		expect(user.content).toEqual([{ type: "text", text: "看一下这个函数" }]);
		const assistant = messages[1];
		if (assistant.role !== "assistant") throw new Error("expected assistant");
		expect(assistant.content[1]).toMatchObject({ type: "toolCall", id: "call1", name: "Read" });
		const result = messages[2];
		if (result.role !== "toolResult") throw new Error("expected tool result");
		expect(result.toolCallId).toBe("call1");
		expect(result.content).toEqual([{ type: "text", text: "文件内容" }]);
		expect(imported!.summary.model).toBe("composer-2.5");
	});
});
