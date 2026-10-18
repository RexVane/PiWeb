import { describe, expect, it } from "vitest";
import { TrajLedger, buildTrajectoryFromEntries, toolStepPreview } from "../src/lib/trajectory";
import type { TrajEntry } from "../src/lib/types";describe("trajectory timing", () => {
	it("continues sequence numbers after restored history", () => {
		const ledger = new TrajLedger([
			{ seq: 7, kind: "user", ts: 1_000, detail: "restored" },
		]);
		ledger.onEvent({ type: "message_start", message: { role: "user", content: "live" } } as any, 2_000);

		expect(ledger.entries.map((entry) => entry.seq)).toEqual([7, 8]);
	});

	it("records model duration, TTFT, and decoding time from Pi events", () => {
		const ledger = new TrajLedger();
		ledger.onEvent({ type: "message_start", message: { role: "assistant" } } as any, 1_000);
		ledger.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } } as any, 1_035);
		ledger.onEvent(
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: {} } } as any,
			1_120,
		);

		expect(ledger.entries[0]?.timing).toEqual({ ttftMs: 35, decodeMs: 85, durationMs: 120 });
	});

	it("measures LLM duration and TTFT from turn_start, not from the provider's first byte", () => {
		const ledger = new TrajLedger();
		ledger.onEvent({ type: "turn_start" } as any, 1_000);
		// 供应商 800ms 后才返回响应头（SDK 此时才发 message_start）
		ledger.onEvent({ type: "message_start", message: { role: "assistant" } } as any, 1_800);
		ledger.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } } as any, 1_850);
		ledger.onEvent(
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: {} } } as any,
			2_000,
		);
		expect(ledger.entries[0]?.timing).toEqual({ ttftMs: 850, decodeMs: 150, durationMs: 1_000 });
	});

	it("records tool execution duration without inventing cold-session timing", () => {
		const ledger = new TrajLedger();
		ledger.onEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a.ts" } } as any, 2_000);
		ledger.onEvent({ type: "tool_execution_end", toolCallId: "call-1", result: "content", isError: false } as any, 2_275);

		expect(ledger.entries[0]).toMatchObject({
			kind: "tool",
			toolName: "read",
			toolCallId: "call-1",
			timing: { durationMs: 275 },
		});
	});

	it("restores SDK durations across cold history without inventing TTFT or decoding time", () => {
		const entries = buildTrajectoryFromEntries([
			{ type: "message", message: { role: "assistant", timestamp: 1000, durationMs: 1250,
				content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }, { type: "toolCall", id: "bash-1", name: "bash", arguments: {} }], usage: { output: 50 } } },
			{ type: "message", message: { role: "toolResult", toolCallId: "bash-1", timestamp: 90000, durationMs: 240, content: [] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "read-1", timestamp: 95000, durationMs: 12, content: [] } },
			{ type: "message", message: { role: "assistant", timestamp: 100000, content: [] } },
		]);
		expect(entries.find((entry) => entry.kind === "message")?.timing).toEqual({ durationMs: 1250 });
		expect(entries.find((entry) => entry.toolCallId === "bash-1")?.timing).toEqual({ durationMs: 240 });
		expect(entries.find((entry) => entry.toolCallId === "read-1")?.timing).toEqual({ durationMs: 12 });
		expect(entries.at(-1)?.timing).toBeUndefined();
	});

	it("uses the same SDK duration for live and restored replies, including tool-only output", () => {
		const message = { role: "assistant", timestamp: 1000, durationMs: 150, content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], usage: { output: 10 } };
		const ledger = new TrajLedger();
		ledger.onEvent({ type: "turn_start" } as any, 1000);
		ledger.onEvent({ type: "message_start", message } as any, 1020);
		ledger.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } } as any, 1030);
		ledger.onEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } } as any, 1040);
		ledger.onEvent({ type: "message_end", message } as any, 1200);
		expect(ledger.entries[0].timing).toEqual({ ttftMs: 40, decodeMs: 160, durationMs: 150 });
		expect(buildTrajectoryFromEntries([{ type: "message", message }])[0].timing?.durationMs).toBe(ledger.entries[0].timing?.durationMs);
	});

	it("keeps the recorded time of compactions and branch summaries instead of stamping them now", () => {
		// 回归：会话条目的 timestamp 是 ISO 字符串，tsOf 只认数字，压缩/分支摘要每次冷加载都成了 Date.now()
		const entries = buildTrajectoryFromEntries([
			{ type: "message", timestamp: "2026-09-10T01:00:00.000Z", message: { role: "user", content: "hi", timestamp: Date.parse("2026-09-10T01:00:00.000Z") } },
			{ type: "compaction", timestamp: "2026-09-10T02:00:00.000Z", tokensBefore: 1000 },
			{ type: "branch_summary", timestamp: "2026-09-10T03:00:00.000Z", summary: "s" },
			// 没有消息体时间戳的老条目：用条目自己的 ISO 时间
			{ type: "message", timestamp: "2026-09-10T04:00:00.000Z", message: { role: "assistant", content: [] } },
			// 什么时间都没有：沿用上一条，顺序不乱
			{ type: "compaction" },
		]);
		expect(entries.map((entry) => new Date(entry.ts).toISOString())).toEqual([
			"2026-09-10T01:00:00.000Z",
			"2026-09-10T02:00:00.000Z",
			"2026-09-10T03:00:00.000Z",
			"2026-09-10T04:00:00.000Z",
			"2026-09-10T04:00:00.000Z",
		]);
	});

	it.each([-1, NaN, Infinity, "100"])("does not accept invalid historical duration %s", (durationMs) => {
		expect(buildTrajectoryFromEntries([{ type: "message", message: { role: "assistant", content: [], durationMs } }])[0].timing).toBeUndefined();
	});

	it("flags irreversibly damaged historical output without rendering replacement characters", () => {
		const entries = buildTrajectoryFromEntries([
			{
				type: "message",
				message: {
					role: "assistant",
					timestamp: 1_000,
					content: [{ type: "toolCall", id: "call-1", name: "powershell", arguments: { command: "Get-ChildItem" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					isError: true,
					timestamp: 1_050,
					content: [{ type: "text", text: "��� damaged line\r\nFullyQualifiedErrorId: Example\r\nCommand exited with code 1" }],
				},
			},
		]);

		const tool = entries.find((entry) => entry.kind === "tool");
		expect(tool).toMatchObject({ encodingLoss: true, isError: true });
		expect(tool?.detail).toContain("FullyQualifiedErrorId: Example");
		expect(tool?.detail).toContain("Command exited with code 1");
		expect(tool?.detail).not.toContain("�");
	});
});

describe("侧栏最后一步正文", () => {
	const tool = (over: Partial<TrajEntry>) => ({
		seq: 1, kind: "tool" as const, ts: 0, toolName: "bash", title: "bash", detail: JSON.stringify({ command: "npm run test" }, null, 2), ...over,
	});

	it("没有输出时用工具参数摘要,不重复工具名", () => {
		// 工具刚 start、还没 update:preview 为空,title 就是工具名 —— 以前会拼出「bash · bash」
		expect(toolStepPreview(tool({}))).toBe("npm run test");
		expect(toolStepPreview(tool({ toolName: "read", title: "read", detail: JSON.stringify({ path: "src/lib/trajectory.ts" }) }))).toBe("src/lib/trajectory.ts");
	});

	it("有真实输出时优先用输出的第一行", () => {
		expect(toolStepPreview(tool({ preview: "line one\nline two" }))).toBe("line one");
	});

	it("参数里没有可读字段时只留工具名(返回空串)", () => {
		expect(toolStepPreview(tool({ detail: JSON.stringify({ ok: true }) }))).toBe("");
		expect(toolStepPreview(tool({ detail: "" }))).toBe("");
	});

	it("输出拼接后的 detail 解析不了也不报错,宁可只留工具名", () => {
		// tool_execution_end 会把输出追加到 args JSON 后面,整个 detail 不再是合法 JSON
		expect(toolStepPreview(tool({ detail: `${JSON.stringify({ command: "ls" })}\n\n---\n\noutput` }))).toBe("");
	});

	it("有预计算摘要(argSummary)时不再解析 detail,超大 detail 也不吃 CPU", () => {
		// 侧栏每 3 秒对每个活跃会话取最后一步:detail 可能是几 MB 的拼接串
		const huge = `${JSON.stringify({ command: "npm run build" })}\n\n---\n\n${"x".repeat(2_000_000)}`;
		expect(toolStepPreview(tool({ detail: huge, argSummary: "npm run build" }))).toBe("npm run build");
	});

	it("账本记录的工具参数与输出都截断,内存不随输出长度无上限增长", () => {
		const ledger = new TrajLedger();
		const bigContent = "x".repeat(300_000);
		ledger.onEvent({ type: "tool_execution_start", toolCallId: "w1", toolName: "write", args: { path: "a.txt", content: bigContent } } as any, 1_000);
		const startEntry = ledger.entries[0] as { detail?: string; argSummary?: string };
		expect(startEntry.detail?.length).toBeLessThan(10_000);
		expect(startEntry.detail).toContain("a.txt");
		expect(startEntry.detail?.length).toBeLessThan(bigContent.length);
		expect(startEntry.argSummary).toBe("a.txt");

		ledger.onEvent({ type: "tool_execution_end", toolCallId: "w1", result: bigContent.repeat(3), isError: false } as any, 2_000);
		expect(ledger.entries[0].detail?.length).toBeLessThan(20_000);
	});
});
