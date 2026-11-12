/**
 * pi 面向扩展 / 用户的那一层在网页端是否完整：
 *  - 扩展注入的消息（custom）、用户的 `!` 命令（bashExecution）、工具自己发起的嵌套调用，模型看得到的界面也要看得到；
 *  - 模型正在生成的工具调用、压缩重试这类事件要推给前端；
 *  - 扩展命令里的 ctx.newSession / fork / navigateTree / switchSession / reload / shutdown 真的会发生，不是静默 no-op。
 * 用真实 SDK（离线、临时 agent 目录）跑，不 mock 会话。
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
type Managed = ReturnType<typeof import("../src/lib/agent-manager")["getManaged"]>;
const managed: Managed[] = [];

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-extension-surface-"));
	cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in extension surface test"); }));
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
const visible = (messages: WebMessage[]) => messages.filter((message) => message.role !== "other");
const textOf = (message: WebMessage) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

async function newSession() {
	const { SessionManager } = await import("../src/lib/pi");
	return SessionManager.create(cwd);
}

function open(sessionFile: string) {
	const m = manager.getManaged(sessionFile);
	managed.push(m);
	return m;
}

/** 这份会话发过的全部事件帧（环形缓冲里的） */
const frames = (m: Managed) => m.buffer.map((frame) => JSON.parse(frame.json) as WebEvent);
/** 让 SDK 会话发一个事件（等同于它自己的 _emit）：驱动 PiWeb 的事件翻译 */
const emit = (m: Managed, event: Record<string, unknown>) => (m.session as unknown as { _emit(event: unknown): void })._emit(event);

describe("模型看得到的，界面也看得到", () => {
	it("扩展注入的消息按 display 显示：冷快照、只读接口、热快照一致", async () => {
		const sm = await newSession();
		sm.appendMessage(user("开始", 1000));
		const shown = sm.appendCustomMessageEntry("plan-mode", "计划已批准：先改 A 再改 B", true);
		sm.appendCustomMessageEntry("internal-state", "只给模型看的提示", false);
		// 另一种持久化形态：role 为 custom 的普通消息条目
		const inline = sm.appendMessage({ role: "custom", customType: "todo", content: [{ type: "text", text: "待办 1/3" }], display: true, timestamp: 1050 });
		sm.appendMessage(assistant("好的", 1100));

		const m = open(sm.getSessionFile()!);
		const cold = visible((await manager.buildSnapshot(m)).messages);
		expect(cold.map((message) => message.role)).toEqual(["user", "custom", "custom", "assistant"]);
		expect(cold[1]).toMatchObject({ role: "custom", id: shown, customType: "plan-mode" });
		expect(textOf(cold[1])).toBe("计划已批准：先改 A 再改 B");
		expect(cold[2]).toMatchObject({ role: "custom", id: inline, customType: "todo" });
		expect(textOf(cold[2])).toBe("待办 1/3");
		// display: false 的注入不出现在任何一条里
		expect(JSON.stringify(cold)).not.toContain("只给模型看的提示");
		expect(visible((await reader.readSession(sm.getSessionFile()!)).messages)).toEqual(cold);

		await manager.ensureSession(m);
		const live = visible((await manager.buildSnapshot(m)).messages);
		expect(live.map((message) => message.role)).toEqual(["user", "custom", "custom", "assistant"]);
		expect(live.filter((message) => message.role === "custom").map((message) => [message.customType, textOf(message)])).toEqual([
			["plan-mode", "计划已批准：先改 A 再改 B"],
			["todo", "待办 1/3"],
		]);
		expect(JSON.stringify(live)).not.toContain("只给模型看的提示");
	}, 60_000);

	it("用户的 ! 命令作为 bashExecution 消息显示，带命令、输出和退出码", async () => {
		const sm = await newSession();
		sm.appendMessage(user("看看状态", 1000));
		sm.appendMessage(assistant("好", 1100));
		const bash = sm.appendMessage({ role: "bashExecution", command: "git status --short", output: " M src/a.ts\n", exitCode: 0, cancelled: false, truncated: false, timestamp: 1200 });
		const failed = sm.appendMessage({ role: "bashExecution", command: "npm test", output: "1 failed", exitCode: 1, cancelled: false, truncated: true, excludeFromContext: true, timestamp: 1300 });

		const m = open(sm.getSessionFile()!);
		const cold = visible((await manager.buildSnapshot(m)).messages);
		expect(cold.map((message) => message.role)).toEqual(["user", "assistant", "bashExecution", "bashExecution"]);
		expect(cold[2]).toMatchObject({ id: bash, bash: { command: "git status --short", output: " M src/a.ts\n", exitCode: 0 } });
		expect(cold[3]).toMatchObject({ id: failed, bash: { command: "npm test", output: "1 failed", exitCode: 1, truncated: true, excludeFromContext: true } });

		await manager.ensureSession(m);
		const live = visible((await manager.buildSnapshot(m)).messages);
		expect(live.filter((message) => message.role === "bashExecution").map((message) => message.bash?.command)).toEqual(["git status --short", "npm test"]);
	}, 60_000);

	it("工具自己发起的嵌套调用随父调用的结果带出来", async () => {
		const sm = await newSession();
		sm.appendMessage(user("重构", 1000));
		sm.appendMessage({ ...assistant("", 1100), stopReason: "toolUse" as const, content: [{ type: "toolCall" as const, id: "call-1", name: "codemode", arguments: { script: "…" } }] });
		sm.appendMessage({
			role: "toolResult", toolCallId: "call-1", toolName: "codemode", isError: false, timestamp: 1200,
			content: [{ type: "text", text: "done" }],
			nestedCalls: { complete: true, calls: [
				{ id: "call-1/1", name: "read", arguments: { path: "src/a.ts" }, status: "ok", durationMs: 12 },
				{ id: "call-1/2", name: "edit", arguments: { path: "src/a.ts" }, status: "error", error: "oldText not found" },
			] },
		});

		const m = open(sm.getSessionFile()!);
		const result = (await manager.buildSnapshot(m)).messages.find((message) => message.role === "toolResult")?.content[0];
		expect(result).toMatchObject({
			type: "toolResult", toolCallId: "call-1",
			nestedCalls: [
				{ id: "call-1/1", name: "read", args: { path: "src/a.ts" }, status: "ok", durationMs: 12 },
				{ id: "call-1/2", name: "edit", args: { path: "src/a.ts" }, status: "error", error: "oldText not found" },
			],
		});
	}, 60_000);
});

describe("SDK 事件 → 前端事件", () => {
	it("工具调用的参数流出期间就推进度：起止必推、中间限速、长字符串截短", async () => {
		const sm = await newSession();
		sm.appendMessage(user("写个文件", 1000));
		const m = open(sm.getSessionFile()!);
		await manager.ensureSession(m);
		const partial = { ...assistant("", Date.now()), content: [] as unknown[] };
		emit(m, { type: "message_start", message: partial });
		const before = frames(m).length;
		const block = { type: "toolCall", id: "call-9", name: "write", arguments: {} as Record<string, unknown> };
		partial.content = [block];
		emit(m, { type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial } });
		block.arguments = { path: "src/big.ts", content: "x".repeat(100) };
		emit(m, { type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "…", partial } });
		// 紧接着的第二个增量在限速窗口内：不推
		block.arguments = { path: "src/big.ts", content: "x".repeat(200) };
		emit(m, { type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "…", partial } });
		const done = { ...block, arguments: { path: "src/big.ts", content: "y".repeat(5000) } };
		emit(m, { type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: done, partial } });

		const progress = frames(m).slice(before).filter((frame): frame is Extract<WebEvent, { type: "toolcall" }> => frame.type === "toolcall");
		expect(progress.map((frame) => [frame.id, frame.name, frame.contentIndex])).toEqual([["call-9", "write", 0], ["call-9", "write", 0], ["call-9", "write", 0]]);
		// 与这条助手消息的流 ID 对得上，前端才知道往哪条消息里放
		const start = frames(m).find((frame) => frame.type === "message" && frame.phase === "start" && frame.message.role === "assistant");
		expect(progress[0].messageId).toBe(start?.type === "message" ? start.message.streamId : "missing");
		expect((progress[1].args as { content: string }).content).toHaveLength(100);
		// 结束帧一定推，但 5000 字符的内容截到预览长度：完整参数随 message end 到达
		const clipped = (progress[2].args as { path: string; content: string });
		expect(clipped.path).toBe("src/big.ts");
		expect(clipped.content.length).toBeLessThan(2100);
		expect(clipped.content.endsWith("…")).toBe(true);
	}, 60_000);

	it("嵌套调用的工具事件带上父调用，压缩重试聚合成重试提示", async () => {
		const sm = await newSession();
		sm.appendMessage(user("跑脚本", 1000));
		const m = open(sm.getSessionFile()!);
		await manager.ensureSession(m);
		const before = frames(m).length;
		emit(m, { type: "tool_execution_start", toolCallId: "call-1/1", toolName: "read", args: { path: "a.ts" }, parentToolCallId: "call-1" });
		emit(m, { type: "tool_execution_end", toolCallId: "call-1/1", toolName: "read", result: { content: [{ type: "text", text: "内容" }] }, isError: false, parentToolCallId: "call-1" });
		emit(m, { type: "summarization_retry_scheduled", attempt: 2, maxAttempts: 5, delayMs: 10, errorMessage: "overloaded" });
		emit(m, { type: "summarization_retry_finished" });
		const seen = frames(m).slice(before);
		expect(seen.filter((frame) => frame.type === "tool")).toMatchObject([
			{ id: "call-1/1", name: "read", parentId: "call-1", state: "running", args: { path: "a.ts" } },
			{ id: "call-1/1", name: "read", parentId: "call-1", state: "done", result: "内容" },
		]);
		expect(seen.find((frame) => frame.type === "retry")).toMatchObject({ attempt: 2, maxAttempts: 5, message: "overloaded" });
		expect(seen.some((frame) => frame.type === "retry_end")).toBe(true);
	}, 60_000);

	it("扩展实时注入的消息：要显示的走 start/end 两帧，不显示的不推 start", async () => {
		const sm = await newSession();
		sm.appendMessage(user("开始", 1000));
		const m = open(sm.getSessionFile()!);
		await manager.ensureSession(m);
		const before = frames(m).length;
		const shown = { role: "custom", customType: "notice", content: "扩展说：已启用计划模式", display: true, timestamp: Date.now() };
		emit(m, { type: "message_start", message: shown });
		emit(m, { type: "message_start", message: { role: "custom", customType: "hidden", content: "内部", display: false, timestamp: Date.now() } });
		const starts = frames(m).slice(before).filter((frame) => frame.type === "message" && frame.phase === "start");
		expect(starts).toHaveLength(1);
		expect(starts[0]).toMatchObject({ message: { role: "custom", customType: "notice", content: [{ type: "text", text: "扩展说：已启用计划模式" }] } });
	}, 60_000);
});

describe("用户的 ! 命令", () => {
	it("受理即返回；消息帧、输出增量、落盘后的条目 ID 都由 PiWeb 自己推", async () => {
		const sm = await newSession();
		sm.appendMessage(user("先聊一句", 1000));
		sm.appendMessage(assistant("好", 1100));
		const m = open(sm.getSessionFile()!);
		const session = await manager.ensureSession(m);
		// 不真的起 shell：只换掉执行这一步，记账仍走 SDK 自己的 recordBashResult
		vi.spyOn(session, "executeBash").mockImplementation(async (command, onChunk, options) => {
			onChunk?.("hello\n");
			const result = { output: "hello\n", exitCode: 0, cancelled: false, truncated: false };
			session.recordBashResult(command, result, options);
			return result;
		});
		const before = frames(m).length;
		expect(await manager.execute(m, { cmd: "bash", command: "echo hello" })).toEqual({ ok: true, data: { accepted: true } });
		await vi.waitFor(() => expect(frames(m).slice(before).some((frame) => frame.type === "message" && frame.phase === "end")).toBe(true));
		const seen = frames(m).slice(before);
		const start = seen.find((frame) => frame.type === "message" && frame.phase === "start");
		const end = seen.find((frame) => frame.type === "message" && frame.phase === "end");
		if (start?.type !== "message" || end?.type !== "message") throw new Error("missing bash frames");
		expect(start.message).toMatchObject({ role: "bashExecution", bash: { command: "echo hello", output: "", running: true } });
		expect(seen.find((frame) => frame.type === "bash_output")).toMatchObject({ messageId: start.message.streamId, delta: "hello\n" });
		// 结束帧沿用同一个流 ID，并带上会话里那条消息的条目 ID：重连后的快照不会多出一条
		expect(end.message).toMatchObject({ role: "bashExecution", streamId: start.message.streamId, bash: { command: "echo hello", output: "hello\n", exitCode: 0 } });
		expect(end.message.bash?.running).toBeUndefined();
		const persisted = visible((await manager.buildSnapshot(m)).messages).filter((message) => message.role === "bashExecution");
		expect(persisted).toHaveLength(1);
		expect(persisted[0].id).toBe(end.message.id);
		// 命令跑着的时候算忙（停止按钮能中断它），跑完回到空闲
		expect(seen.filter((frame) => frame.type === "status").map((frame) => frame.type === "status" && frame.isStreaming)).toEqual([true, false]);
	}, 60_000);

	it("没能跑起来的命令也收尾成一条失败的消息，不留一个永远在跑的卡片", async () => {
		const sm = await newSession();
		sm.appendMessage(user("开始", 1000));
		sm.appendMessage(assistant("好", 1100));
		const m = open(sm.getSessionFile()!);
		const session = await manager.ensureSession(m);
		vi.spyOn(session, "executeBash").mockRejectedValue(new Error("spawn bash ENOENT"));
		const before = frames(m).length;
		expect(await manager.execute(m, { cmd: "bash", command: "ls", excludeFromContext: true })).toMatchObject({ ok: true });
		await vi.waitFor(() => expect(frames(m).slice(before).some((frame) => frame.type === "message" && frame.phase === "end")).toBe(true));
		const end = frames(m).slice(before).find((frame) => frame.type === "message" && frame.phase === "end");
		expect(end).toMatchObject({ message: { role: "bashExecution", bash: { command: "ls", output: "spawn bash ENOENT", failed: true, excludeFromContext: true } } });
		// 同一时间只跑一条：上一条收尾后才能再发
		expect(await manager.execute(m, { cmd: "bash", command: "   " })).toMatchObject({ ok: false });
	}, 60_000);

	it("停止按钮同时中断正在跑的 ! 命令", async () => {
		const sm = await newSession();
		sm.appendMessage(user("开始", 1000));
		sm.appendMessage(assistant("好", 1100));
		const m = open(sm.getSessionFile()!);
		const session = await manager.ensureSession(m);
		const abortBash = vi.spyOn(session, "abortBash");
		expect(await manager.execute(m, { cmd: "abort" })).toMatchObject({ ok: true });
		expect(abortBash).toHaveBeenCalledTimes(1);
		expect(await manager.execute(m, { cmd: "abortBash" })).toEqual({ ok: true });
		expect(abortBash).toHaveBeenCalledTimes(2);
	}, 60_000);

	it("模型回合先结束时，仍在运行的 ! 命令保持忙态，命令结束后才回到空闲", async () => {
		const sm = await newSession();
		sm.appendMessage(user("开始", 1000));
		sm.appendMessage(assistant("好", 1100));
		const m = open(sm.getSessionFile()!);
		const session = await manager.ensureSession(m);
		let finishCommand!: () => void;
		const pending = new Promise<void>((resolve) => { finishCommand = resolve; });
		vi.spyOn(session, "executeBash").mockImplementation(async () => {
			await pending;
			return { output: "done", exitCode: 0, cancelled: false, truncated: false };
		});
		expect(await manager.execute(m, { cmd: "bash", command: "long-command" })).toMatchObject({ ok: true });
		emit(m, { type: "agent_settled", aborted: false });
		expect(frames(m).filter((frame) => frame.type === "status").at(-1)).toMatchObject({ isStreaming: true, state: "running" });
		finishCommand();
		await vi.waitFor(() => expect(frames(m).filter((frame) => frame.type === "status").at(-1)).toMatchObject({ isStreaming: false, state: "idle" }));
	}, 60_000);

	it("! 命令结束后执行运行期间延后的资源重载", async () => {
		const sm = await newSession();
		sm.appendMessage(user("开始", 1000));
		sm.appendMessage(assistant("好", 1100));
		const m = open(sm.getSessionFile()!);
		const session = await manager.ensureSession(m);
		let finishCommand!: () => void;
		const pending = new Promise<void>((resolve) => { finishCommand = resolve; });
		vi.spyOn(session, "executeBash").mockImplementation(async () => {
			await pending;
			return { output: "done", exitCode: 0, cancelled: false, truncated: false };
		});
		const reload = vi.spyOn(session, "reload").mockResolvedValue();
		expect(await manager.execute(m, { cmd: "bash", command: "long-command" })).toMatchObject({ ok: true });
		m.resourceReloadPending = true;
		finishCommand();
		await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
		expect(m.resourceReloadPending).toBe(false);
	}, 60_000);
});

describe("设置面板改动对已开会话的即时生效", () => {
	it("排队投递方式当场换到开着的会话上（SDK 只在建会话时读一次）", async () => {
		const sm = await newSession();
		sm.appendMessage(user("开始", 1000));
		sm.appendMessage(assistant("好", 1100));
		const m = open(sm.getSessionFile()!);
		const session = await manager.ensureSession(m);
		expect(session.agent.steeringMode).toBe("one-at-a-time");
		expect(manager.applySettingsToSessions({ steeringMode: "all", followUpMode: "all" })).toBeGreaterThanOrEqual(1);
		expect(session.agent.steeringMode).toBe("all");
		expect(session.agent.followUpMode).toBe("all");
		// 没有需要当场生效的字段就不碰任何会话
		expect(manager.applySettingsToSessions({})).toBe(0);
		expect(manager.applySettingsToSessions({ steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" })).toBeGreaterThanOrEqual(1);
		expect(session.agent.steeringMode).toBe("one-at-a-time");
	}, 60_000);
});

describe("会话分支：树、切换、标签", () => {
	it("真实会话树上的分叉：列得出来、切得过去、标签落盘", async () => {
		const sm = await newSession();
		sm.appendMessage(user("第一问", 1000));
		const a1 = sm.appendMessage(assistant("第一答", 1100));
		const u2 = sm.appendMessage(user("旧的第二问", 2000));
		const a2 = sm.appendMessage(assistant("旧的第二答", 2100));
		// 回到第一答之后重新提问：从这里长出一条新分支，旧的还在文件里
		sm.branch(a1);
		sm.appendMessage(user("新的第二问", 3000));
		sm.appendMessage(assistant("新的第二答", 3100));
		const file = sm.getSessionFile()!;
		const m = open(file);
		const { buildSessionTree } = await import("../src/lib/session-tree");

		expect(buildSessionTree(m.sm).nodes.map((node) => [node.text, node.indent, node.forked, node.active, node.current])).toEqual([
			["第一问", 0, false, true, false],
			["旧的第二问", 1, true, false, false],
			["新的第二问", 1, true, true, true],
		]);
		expect(buildSessionTree(m.sm).nodes[1].leafId).toBe(a2);

		// 接口返回同一份，并保留最早的两个字段
		const route = await import("../src/app/api/agent/[id]/tree/route");
		const { encodeSessionId } = await import("../src/lib/pi");
		const response = await route.GET(new Request("http://localhost/api/agent/x/tree"), { params: Promise.resolve({ id: encodeSessionId(file) }) });
		const json = await response.json();
		expect(json.success).toBe(true);
		expect(json.data.nodes).toHaveLength(3);
		expect(json.data.userMessages.map((item: { text: string; depth: number }) => [item.text, item.depth])).toEqual([["第一问", 0], ["旧的第二问", 1], ["新的第二问", 1]]);
		expect(json.data.activeUserId).toBe(json.data.nodes[2].entryId);

		// 切到旧分支：对话变成那条分支的内容，并通知所有开着这份会话的页面重新取快照
		const before = frames(m).length;
		expect(await manager.execute(m, { cmd: "navigate", entryId: a2 })).toMatchObject({ ok: true, data: { cancelled: false } });
		expect(frames(m).slice(before).some((frame) => frame.type === "resync")).toBe(true);
		expect(visible((await manager.buildSnapshot(m)).messages).map(textOf)).toEqual(["第一问", "第一答", "旧的第二问", "旧的第二答"]);
		expect(buildSessionTree(m.sm).nodes.map((node) => [node.text, node.active])).toEqual([["第一问", true], ["旧的第二问", true], ["新的第二问", false]]);

		// 标签存进会话文件（pi 终端的 /tree 读的也是它）：重新从磁盘打开还在
		expect(await manager.execute(m, { cmd: "setLabel", entryId: u2, text: "  回滚点 " })).toEqual({ ok: true, data: { label: "回滚点" } });
		expect(buildSessionTree(m.sm).nodes.find((node) => node.entryId === u2)?.label).toBe("回滚点");
		const { SessionManager } = await import("../src/lib/pi");
		expect(SessionManager.open(file).getLabel(u2)).toBe("回滚点");
		// 打标签不改变眼前的对话
		expect(visible((await manager.buildSnapshot(m)).messages).map(textOf)).toEqual(["第一问", "第一答", "旧的第二问", "旧的第二答"]);
		// 空 = 清掉；不存在的条目拒绝
		expect(await manager.execute(m, { cmd: "setLabel", entryId: u2, text: "" })).toEqual({ ok: true, data: { label: null } });
		expect(SessionManager.open(file).getLabel(u2)).toBeUndefined();
		expect(await manager.execute(m, { cmd: "setLabel", entryId: "no-such-entry", text: "x" })).toMatchObject({ ok: false });
	}, 90_000);

	it("pi 正在跑的时候不换分支，冷会话也能打标签", async () => {
		const sm = await newSession();
		const u1 = sm.appendMessage(user("第一问", 1000));
		const a1 = sm.appendMessage(assistant("第一答", 1100));
		const m = open(sm.getSessionFile()!);
		// 冷会话打标签不需要启动 agent
		expect(await manager.execute(m, { cmd: "setLabel", entryId: u1, text: "起点" })).toMatchObject({ ok: true });
		expect(m.session).toBeNull();
		m.runActive = true;
		try {
			expect(await manager.execute(m, { cmd: "navigate", entryId: a1 })).toEqual({ ok: false, error: "session is busy" });
			expect(m.session).toBeNull();
		} finally {
			m.runActive = false;
		}
	}, 60_000);
});

describe("扩展命令里的会话操作", () => {
	/** 扩展命令处理器拿到的上下文（ctx.newSession / ctx.fork / …） */
	const commandContext = (m: Managed) => m.session!.extensionRunner.createCommandContext();

	it("ctx.newSession 真的建出新会话、跑 setup / withSession，并把浏览器领过去", async () => {
		const sm = await newSession();
		sm.appendMessage(user("原会话", 1000));
		const m = open(sm.getSessionFile()!);
		m.toolPreset = "standard";
		await manager.ensureSession(m);
		let replaced: unknown;
		const result = await commandContext(m).newSession({
			setup: async (next) => { next.appendMessage(user("扩展预置的第一句", 2000)); },
			withSession: async (ctx) => { replaced = ctx; },
		});
		expect(result).toEqual({ cancelled: false });
		const navigate = frames(m).find((frame) => frame.type === "session_navigate");
		if (navigate?.type !== "session_navigate") throw new Error("missing session_navigate");
		expect(navigate.reason).toBe("new");
		expect(navigate.sessionPath).not.toBe(m.sessionPath);
		const target = open(navigate.sessionPath);
		// 目标会话已经热启动，扩展预置的内容在里面，权限档位跟着来源会话
		expect(target.session).toBeTruthy();
		expect(visible((await manager.buildSnapshot(target)).messages).map(textOf)).toEqual(["扩展预置的第一句"]);
		expect(target.toolPreset).toBe("standard");
		expect(replaced).toBeTruthy();
	}, 90_000);

	it("ctx.fork 从指定条目切出分支会话，ctx.switchSession 打开已有会话", async () => {
		const sm = await newSession();
		const u1 = sm.appendMessage(user("第一问", 1000));
		sm.appendMessage(assistant("第一答", 1100));
		sm.appendMessage(user("第二问", 2000));
		sm.appendMessage(assistant("第二答", 2100));
		const m = open(sm.getSessionFile()!);
		await manager.ensureSession(m);

		expect(await commandContext(m).fork(u1, { position: "at" })).toEqual({ cancelled: false });
		const forked = frames(m).find((frame) => frame.type === "session_navigate");
		if (forked?.type !== "session_navigate") throw new Error("missing fork navigate");
		expect(forked.reason).toBe("fork");
		const branch = open(forked.sessionPath);
		expect(visible((await manager.buildSnapshot(branch)).messages).map(textOf)).toEqual(["第一问"]);

		const other = await newSession();
		other.appendMessage(user("另一个会话", 3000));
		other.appendMessage(assistant("在的", 3100));
		// 那份会话有自己保存过的权限选择；来源会话是另一个档位
		const otherManaged = open(other.getSessionFile()!);
		expect(await manager.execute(otherManaged, { cmd: "setToolPreset", preset: "readonly" })).toMatchObject({ ok: true });
		m.toolPreset = "full";
		const before = frames(m).length;
		expect(await commandContext(m).switchSession(other.getSessionFile()!)).toEqual({ cancelled: false });
		const switched = frames(m).slice(before).find((frame) => frame.type === "session_navigate");
		expect(switched).toMatchObject({ reason: "resume", sessionPath: other.getSessionFile() });
		// 切到已有会话不拿来源会话的档位覆盖它（新建 / 分叉才继承）
		expect(manager.getManaged(other.getSessionFile()!).toolPreset).toBe("readonly");
	}, 90_000);

	it("ctx.navigateTree 换分支后让浏览器重新取快照", async () => {
		const sm = await newSession();
		sm.appendMessage(user("第一问", 1000));
		const a1 = sm.appendMessage(assistant("第一答", 1100));
		sm.appendMessage(user("第二问", 2000));
		sm.appendMessage(assistant("第二答", 2100));
		const m = open(sm.getSessionFile()!);
		await manager.ensureSession(m);
		const before = frames(m).length;
		expect(await commandContext(m).navigateTree(a1)).toEqual({ cancelled: false });
		expect(frames(m).slice(before).some((frame) => frame.type === "resync")).toBe(true);
		expect(visible((await manager.buildSnapshot(m)).messages).map(textOf)).toEqual(["第一问", "第一答"]);
	}, 90_000);

	it("ctx.reload 在命令处理器里能跑：发起它的那次提交不算「忙」", async () => {
		const sm = await newSession();
		sm.appendMessage(user("开始", 1000));
		const m = open(sm.getSessionFile()!);
		const session = await manager.ensureSession(m);
		// 扩展命令处理器就在一次 prompt 提交里跑
		m.promptSubmitting = true;
		try {
			await expect(commandContext(m).reload()).resolves.toBeUndefined();
			// 普通路径（设置面板触发的重载等）在提交期间仍然被挡住
			await expect(session.reload()).rejects.toThrow(/busy/);
		} finally {
			m.promptSubmitting = false;
		}
		expect(m.resourceReloading).toBe(false);
	}, 90_000);

	it("ctx.shutdown 让这份会话收工，会话文件留着", async () => {
		const sm = await newSession();
		sm.appendMessage(user("开始", 1000));
		sm.appendMessage(assistant("好", 1100));
		const m = open(sm.getSessionFile()!);
		await manager.ensureSession(m);
		m.session!.extensionRunner.createContext().shutdown();
		await vi.waitFor(() => expect(m.disposed).toBe(true), { timeout: 5000 });
		// 重新打开就是一份冷会话，内容还在
		const reopened = open(sm.getSessionFile()!);
		expect(reopened).not.toBe(m);
		expect(visible((await manager.buildSnapshot(reopened)).messages).map(textOf)).toEqual(["开始", "好"]);
	}, 90_000);
});
