/**
 * 上下文分项（上下文圆环弹窗的 13 类分段）：
 * - 冷会话（只浏览、不冷启动 agent）也要有 Memory / Skills / Auto-Compact Buffer，不能整块归零；
 * - 会话启动后推 context_breakdown，System Prompt 与工具定义补上，不用刷新页面。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextBreakdown, WebEvent } from "../src/lib/types";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));

let root: string;
let cwd: string;
let manager: typeof import("../src/lib/agent-manager");
const managed: ReturnType<typeof import("../src/lib/agent-manager")["getManaged"]>[] = [];

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-context-breakdown-"));
	cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(path.join(cwd, ".pi", "skills", "demo"), { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", compaction: { enabled: true, reserveTokens: 16384 } }));
	await fs.writeFile(path.join(cwd, "AGENTS.md"), `# Project rules\n\n${"Keep answers short and cite files. ".repeat(40)}\n`);
	await fs.writeFile(path.join(cwd, ".pi", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill used to check that the skills section is counted in the context breakdown.\n---\n\nDo the demo thing.\n");
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in context breakdown test"); }));
	vi.resetModules();
	manager = await import("../src/lib/agent-manager");
	const pi = await import("../src/lib/pi");
	await pi.resourceLoaderReady(cwd);
}, 90_000);

afterAll(async () => {
	for (const m of managed) manager.disposeSession(m);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await fs.rm(root, { recursive: true, force: true });
});

describe("上下文分项", () => {
	it("冷热会话使用同一份持久用量和耗时，独立 usage 与压缩调用都计入累计", async () => {
		const { SessionManager } = await import("../src/lib/pi");
		const sm = SessionManager.create(cwd);
		const usage = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
		const userId = sm.appendMessage({ role: "user", content: "hello", timestamp: 1000 });
		sm.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "test", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], timestamp: 1100, stopReason: "toolUse", durationMs: 250, usage: usage(100, 50, 900) });
		sm.appendMessage({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "result" }], timestamp: 5000, durationMs: 50, isError: false });
		sm.appendUsage("summary", "anthropic", "test", usage(90, 10));
		sm.appendCompaction("summary", userId, 1050, undefined, false, usage(120, 20));
		const m = manager.getManaged(sm.getSessionFile()!);
		managed.push(m);
		const cold = (await manager.buildSnapshot(m)).stats!;
		expect(cold).toMatchObject({ llmMs: 250, toolMs: 50, llmTimedSteps: 1, toolTimedCalls: 1, ttftSteps: 0, decodeMs: 0,
			tokens: { input: 310, output: 80, cacheRead: 900, cacheWrite: 0, total: 1290 } });
		await manager.ensureSession(m);
		expect((await manager.buildSnapshot(m)).stats).toEqual(cold);
	}, 60_000);

	it("冷会话已有系统投影时按保存的分段统计，不拿磁盘资源或全部工具估算充数", async () => {
		const { SessionManager } = await import("../src/lib/pi");
		const sm = SessionManager.create(cwd);
		const tool = { name: "read", description: "Read", parameters: { type: "object" } };
		sm.appendMessage({ role: "system", content: "core", sections: { project_context: "memory", skills: "skill", rules: "rules" }, toolsAdded: [tool], timestamp: 1000 } as any);
		sm.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "test", content: [], timestamp: 1100, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		const m = manager.getManaged(sm.getSessionFile()!);
		managed.push(m);
		const breakdown = (await manager.buildSnapshot(m)).contextBreakdown!;
		expect(breakdown.characters).toEqual({ systemPrompt: 9, memory: 6, skills: 5, systemTools: JSON.stringify(tool).length, customTools: 0, compacted: 0 });
		expect(breakdown.cold).toBeUndefined();
	}, 60_000);
	it("冷会话照算 Memory / Skills / Buffer，标 cold；启动后推送带 System Prompt 与工具的新分项", async () => {
		const { sessionPath } = await manager.createNewSession(cwd);
		const m = manager.getManaged(sessionPath);
		managed.push(m);

		const cold = (await manager.buildSnapshot(m)).contextBreakdown!;
		expect(cold.cold).toBe(true);
		expect(cold.memory).toBeGreaterThan(100);
		expect(cold.skills).toBeGreaterThan(20);
		expect(cold.autoCompactBuffer).toBe(16384);
		expect(cold.systemPrompt).toBe(0);
		expect(cold.systemTools).toBe(0);

		const events: WebEvent[] = [];
		expect(manager.subscribe(m, (_seq, json) => events.push(JSON.parse(json)), m.seq)).toBe(true);
		await manager.ensureSession(m);
		await vi.waitFor(() => expect(events.some((event) => event.type === "context_breakdown")).toBe(true));
		const pushed = events.filter((event): event is Extract<WebEvent, { type: "context_breakdown" }> => event.type === "context_breakdown");
		// 启动时 publishTools + publishResources 同一轮触发，只推一次
		expect(pushed).toHaveLength(1);
		const warm: ContextBreakdown = pushed[0].breakdown;
		expect(warm.cold).toBeUndefined();
		expect(warm.systemPrompt).toBeGreaterThan(100);
		expect(warm.systemTools).toBeGreaterThan(100);
		expect(warm.memory).toBe(cold.memory);
		expect(warm.skills).toBeGreaterThan(20);
		// 冷会话的技能段用同一个格式化函数估算，和启动后从实际 prompt 里切出来的差不多
		expect(Math.abs(warm.skills - cold.skills)).toBeLessThan(Math.max(10, warm.skills * 0.2));
		expect(warm.autoCompactBuffer).toBe(16384);

		expect((await manager.buildSnapshot(m)).contextBreakdown).toMatchObject({ systemPrompt: warm.systemPrompt, systemTools: warm.systemTools });
	}, 60_000);
});
