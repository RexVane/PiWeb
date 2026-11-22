/**
 * 停止的两条出口：
 *   1. 工具不响应中止、停止超时之后，删除 / 归档仍然能把会话回收掉（否则只能重启服务）；
 *   2. 会话还在冷启动时点停止，等在后面的那次提交不会再发出去。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, dispose: () => {} }),
}));

import { disposeSessionPath, execute } from "../src/lib/agent-manager";

type Managed = Parameters<typeof execute>[0];
const pool = (globalThis as unknown as { __piWebSessions: Map<string, Managed> }).__piWebSessions;

function fakeSession(overrides: Record<string, unknown> = {}) {
	return {
		isIdle: true,
		isStreaming: false,
		modelRuntime: {},
		agent: { abort: vi.fn(), steeringQueue: { messages: [] }, followUpQueue: { messages: [] } },
		extensionRunner: { hasHandlers: () => false, getCommand: () => undefined },
		abort: vi.fn(async () => {}),
		abortBash: vi.fn(),
		clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
		dispose: vi.fn(),
		prompt: vi.fn(async () => {}),
		getAllTools: () => [],
		getToolDefinition: () => undefined,
		...overrides,
	};
}

function managed(sessionPath: string, extra: Record<string, unknown> = {}): Managed {
	const m = {
		session: null, creating: null, disposed: false, promptSubmitting: false, runActive: false,
		resourceReloading: false, resourceReloadPending: false, cwd: "/workspace", sessionPath,
		seq: 0, buffer: [], subscribers: new Set(), lastActive: 0, ui: null, growth: null, ...extra,
	} as unknown as Managed;
	pool.set(sessionPath, m);
	return m;
}

afterEach(() => {
	for (const key of [...pool.keys()]) if (key.startsWith("/stop-recovery/")) pool.delete(key);
});

describe("stop recovery", () => {
	it("still disposes a session whose run never acknowledges the stop", async () => {
		const session = fakeSession({ isIdle: false, isStreaming: true, abort: vi.fn(() => new Promise<void>(() => {})) });
		const m = managed("/stop-recovery/stuck.jsonl", { session, runActive: true });
		const started = Date.now();
		await disposeSessionPath(m.sessionPath);
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(pool.has(m.sessionPath)).toBe(false);
		expect(m.disposed).toBe(true);
		expect(session.dispose).toHaveBeenCalled();
	}, 25_000);

	it("keeps refusing new prompts after a failed stop", async () => {
		const session = fakeSession({ isIdle: false, isStreaming: true, abort: vi.fn(() => new Promise<void>(() => {})) });
		const m = managed("/stop-recovery/refuse.jsonl", { session, runActive: true });
		expect(await execute(m, { cmd: "abort" })).toMatchObject({ ok: false });
		expect(await execute(m, { cmd: "prompt", text: "again" })).toMatchObject({ ok: false, error: "session is busy accepting another command" });
		expect(session.prompt).not.toHaveBeenCalled();
	}, 25_000);

	it("drops the pending prompt when stop arrives while the session is still starting", async () => {
		const session = fakeSession();
		let ready!: (value: unknown) => void;
		const m = managed("/stop-recovery/starting.jsonl", { creating: new Promise((resolve) => { ready = resolve; }) });
		const prompt = execute(m, { cmd: "prompt", text: "hello" });
		const stop = execute(m, { cmd: "abort" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		(m as unknown as { session: unknown; creating: unknown }).session = session;
		(m as unknown as { session: unknown; creating: unknown }).creating = null;
		ready(session);
		expect(await prompt).toMatchObject({ ok: false });
		expect(await stop).toMatchObject({ ok: true });
		expect(session.prompt).not.toHaveBeenCalled();
		// 下一次提交照常受理
		expect(await execute(m, { cmd: "prompt", text: "next" })).toMatchObject({ ok: true });
		expect(session.prompt).toHaveBeenCalledTimes(1);
	}, 25_000);

	it.each([
		{ cmd: "sendQueueNow" } as const,
		{ cmd: "editAndResend", entryId: "entry-1", text: "edited" } as const,
	])("drops a pending $cmd when stop arrives while the session is still starting", async (command) => {
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		const session = fakeSession({ navigateTree });
		let ready!: (value: unknown) => void;
		const m = managed(`/stop-recovery/starting-${command.cmd}.jsonl`, { creating: new Promise((resolve) => { ready = resolve; }) });
		const pending = execute(m, command);
		const stop = execute(m, { cmd: "abort" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		(m as unknown as { session: unknown; creating: unknown }).session = session;
		(m as unknown as { session: unknown; creating: unknown }).creating = null;
		ready(session);
		expect(await pending).toMatchObject({ ok: false });
		expect(await stop).toMatchObject({ ok: true });
		expect(session.prompt).not.toHaveBeenCalled();
		expect(navigateTree).not.toHaveBeenCalled();
	}, 25_000);
});
