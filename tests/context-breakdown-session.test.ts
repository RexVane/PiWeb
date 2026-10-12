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
