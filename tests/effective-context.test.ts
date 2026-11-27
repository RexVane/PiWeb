/**
 * 真正有效上下文抽取的单元测试：
 * 覆盖持久化 system 分段、热会话激活工具/技能拆分、冷会话回退、pi-ai transformMessages 口径
 * （error/aborted 回复剔除、切模型后跨模型 thinking 剔除）、SessionManager 真实投影
 * （压缩、分支摘要、context_edit 改删、! / !! 命令、display: false 隐藏扩展消息、大条目截断）。
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildEffectiveContext,
	extractClientEffectiveContext,
	MAX_INSPECT_ITEM_CHARS,
} from "../src/lib/effective-context";

describe("buildEffectiveContext — 系统/工具/记忆/技能三分支", () => {
	it("持久化 system 消息存在时按投影分段拆出，不混入未注入的磁盘记忆文件", () => {
		const readTool = { name: "read", description: "Read a file", parameters: { type: "object" } };
		const customTool = { name: "my_ext_tool", description: "Custom", parameters: { type: "object" } };
		const result = buildEffectiveContext({
			projectedMessages: [
				{
					role: "system",
					content: "Core prompt body",
					sections: {
						project_context: "Injected AGENTS.md content",
						skills: "<available_skills>demo</available_skills>",
						rules: "Extra system rules",
					},
					toolsAdded: [readTool, customTool],
				},
			],
			projectMemoryResources: [{ path: "/ws/UNINJECTED.md", content: "Should not appear" }],
		});

		expect(result.cold).toBe(false);
		expect(result.categories.system.map((i) => [i.title, i.content])).toEqual([
			["System Prompt", "Core prompt body"],
			["rules", "Extra system rules"],
		]);
		expect(result.totals.system).toBe("Core prompt body".length + "Extra system rules".length);
		expect(result.categories.memory).toHaveLength(1);
		expect(result.categories.memory[0].content).toBe("Injected AGENTS.md content");
		expect(result.categories.skills).toHaveLength(1);
		expect(result.categories.skills[0].content).toBe("<available_skills>demo</available_skills>");
		expect(result.categories.builtin.map((i) => i.title)).toEqual(["read"]);
		expect(result.categories.custom.map((i) => i.title)).toEqual(["my_ext_tool"]);
	});

	it("热会话无持久化 system 时只列激活工具，并从 systemPrompt 剥离 <available_skills>", () => {
		const skills = "The following skills provide specialized instructions for tasks.\n\n<available_skills>\n- demo\n</available_skills>";
		const memory = "# AGENTS\nAlways test.";
		const result = buildEffectiveContext({
			projectedMessages: [],
			session: {
				systemPrompt: `You are pi.\n\n${memory}\n\n${skills}`,
				getActiveToolNames: () => ["read", "active_ext"],
				getAllTools: () => [
					{ name: "read", description: "Read", parameters: {}, sourceInfo: { source: "builtin" } },
					{ name: "bash", description: "Disabled builtin", parameters: {}, sourceInfo: { source: "builtin" } },
					{ name: "active_ext", description: "Active ext", parameters: {}, sourceInfo: { source: "extension" } },
					{ name: "inactive_ext", description: "Inactive ext", parameters: {}, sourceInfo: { source: "extension" } },
				],
			},
			projectMemoryResources: [{ path: "/ws/AGENTS.md", content: memory }],
		});

		expect(result.cold).toBe(false);
		expect(result.categories.system.map((i) => i.content)).toEqual(["You are pi."]);
		expect(result.categories.memory.map((i) => i.title)).toEqual(["AGENTS.md"]);
		expect(result.categories.skills.map((i) => i.content)).toEqual([skills]);
		expect(result.categories.builtin.map((i) => i.title)).toEqual(["read"]);
		expect(result.categories.custom.map((i) => i.title)).toEqual(["active_ext"]);
	});

	it("冷会话无持久化 system 时标记 cold，仅展示待注入的记忆与技能", () => {
		const result = buildEffectiveContext({
			projectedMessages: [],
			session: null,
			projectMemoryResources: [{ path: "/ws/AGENTS.md", content: "Rules" }],
			coldSkillsText: "<available_skills>cold</available_skills>",
		});

		expect(result.cold).toBe(true);
		expect(result.categories.system).toEqual([]);
		expect(result.categories.builtin).toEqual([]);
		expect(result.categories.custom).toEqual([]);
		expect(result.categories.memory).toHaveLength(1);
		expect(result.categories.skills).toHaveLength(1);
	});
});

describe("pi-ai transformMessages 有效口径对齐", () => {
	it("剔除 stopReason 为 error / aborted 的助手消息，并跳过其未生效的 toolCall", () => {
		const projectedMessages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "assistant",
				stopReason: "error",
				content: [
					{ type: "text", text: "partial error text" },
					{ type: "thinking", thinking: "error thinking" },
					{ type: "toolCall", id: "err-1", name: "read", arguments: { path: "bad.ts" } },
				],
			},
			{
				role: "assistant",
				stopReason: "aborted",
				content: [{ type: "text", text: "aborted text" }],
			},
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "valid reply" }],
			},
		];

		const serverRes = buildEffectiveContext({ projectedMessages });
		expect(serverRes.categories.text.map((i) => i.content)).toEqual(["valid reply"]);
		expect(serverRes.totals.text).toBe("valid reply".length);
		expect(serverRes.totals.thinking).toBe(0);
		expect(serverRes.totals.call).toBe(0);

		const clientRes = extractClientEffectiveContext(projectedMessages as never);
		expect(clientRes.categories.text.map((i) => i.content)).toEqual(["valid reply"]);
		expect(clientRes.totals.thinking).toBe(0);
		expect(clientRes.totals.call).toBe(0);
	});

	it("切换模型后剔除旧模型产生的 thinking 块，保留文本/调用与当前模型的 thinking", () => {
		const projectedMessages = [
			{ role: "user", content: [{ type: "text", text: "step 1" }] },
			{
				role: "assistant",
				provider: "anthropic",
				model: "claude-opus-5-5",
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "old model secret thought" },
					{ type: "text", text: "old model answer" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
				],
			},
			{
				role: "assistant",
				provider: "openai",
				model: "gpt-6.2-sol",
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "   \n  " },
					{ type: "thinking", thinking: "current model thought" },
					{ type: "text", text: "new model answer" },
				],
			},
		];

		const res = buildEffectiveContext({
			projectedMessages,
			currentModel: { provider: "openai", id: "gpt-6.2-sol" },
		});
		expect(res.categories.thinking.map((i) => i.content)).toEqual(["current model thought"]);
		expect(res.totals.thinking).toBe("current model thought".length);
		expect(res.categories.text.map((i) => i.content)).toEqual(["old model answer", "new model answer"]);
		expect(res.categories.call).toHaveLength(1);
	});
});

describe("SessionManager 真实投影：压缩、分支、context_edit、!/!!、隐藏扩展消息", () => {
	it("只保留当前分支、压缩保留区、context_edit 改删后的有效内容", () => {
		const sm = SessionManager.inMemory();
		const oldUser = sm.appendMessage({ role: "user", content: "old message before compaction", timestamp: 1 });
		sm.appendMessage({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5-5",
			stopReason: "stop",
			content: [{ type: "text", text: "old reply" }],
			timestamp: 2,
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		const keptUser = sm.appendMessage({ role: "user", content: "kept question", timestamp: 3 });
		sm.appendCompaction("Compacted earlier chat", keptUser, 500);
		sm.appendMessage({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5-5",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/foo.ts" } }],
			timestamp: 4,
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "call-read",
			toolName: "read",
			content: [{ type: "text", text: "export const x = 1;" }],
			isError: false,
			timestamp: 5,
		});
		sm.appendMessage({ role: "bashExecution", command: "ls", output: "README.md", exitCode: 0, cancelled: false, truncated: false, timestamp: 6 } as never);
		sm.appendMessage({ role: "bashExecution", command: "secret", output: "ignored", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 7 } as never);
		sm.appendCustomMessageEntry("ext-hidden", "hidden context note", false, undefined);
		const toDelete = sm.appendMessage({ role: "user", content: "deleted user turn", timestamp: 8 });
		sm.appendContextEdit(keptUser, { content: "edited kept question" });
		sm.appendContextEdit(toDelete, null);

		const res = buildEffectiveContext({
			projectedMessages: sm.buildSessionProjection().messages as unknown as Array<Record<string, unknown>>,
			currentModel: { provider: "anthropic", id: "claude-opus-5-5" },
		});

		expect(oldUser).toBeTruthy();
		expect(res.categories.compacted.map((i) => [i.tag, i.content])).toEqual([["compaction", "Compacted earlier chat"]]);
		expect(res.categories.user.map((i) => ({ title: i.title, tag: i.tag, content: i.content }))).toEqual([
			{ title: "", tag: undefined, content: "edited kept question" },
			{ title: "! ls", tag: "shell", content: "$ ls\nREADME.md" },
			{ title: "ext-hidden", tag: "hidden", content: "hidden context note" },
		]);
		expect(res.categories.output).toHaveLength(1);
		expect(res.categories.output[0]).toMatchObject({
			title: "read",
			subtitle: "src/foo.ts",
			content: "export const x = 1;",
		});
	});

	it("超大条目截断返回内容但保留精确字符总数", () => {
		const bigText = "a".repeat(MAX_INSPECT_ITEM_CHARS + 250);
		const res = buildEffectiveContext({
			projectedMessages: [{ role: "user", content: [{ type: "text", text: bigText }] }],
		});
		expect(res.categories.user[0].chars).toBe(MAX_INSPECT_ITEM_CHARS + 250);
		expect(res.categories.user[0].content.length).toBe(MAX_INSPECT_ITEM_CHARS);
		expect(res.categories.user[0].truncated).toBe(true);
	});
});
