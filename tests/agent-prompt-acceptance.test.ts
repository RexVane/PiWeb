import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, dispose: () => {} }),
}));
import { execute } from "../src/lib/agent-manager";

type Managed = Parameters<typeof execute>[0];
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function fixture(prompt: (...args: any[]) => Promise<void>, extra: Record<string, unknown> = {}) {
	const session = { prompt: vi.fn(prompt), isStreaming: false, isIdle: true, ...extra };
	const m = {
		session, creating: null, disposed: false, promptSubmitting: false, runActive: false,
		resourceReloading: false, resourceReloadPending: false, cwd: "test", sessionPath: "test",
		seq: 0, buffer: [], subscribers: new Set(), lastActive: 0,
		growth: { version: 1, prepare: vi.fn(async () => {}), onEvent: () => {} },
	} as unknown as Managed;
	return { m, session };
}

afterEach(() => vi.restoreAllMocks());

describe("prompt acceptance boundary", () => {
	it("returns acceptance before run completion and reports a later rejection through SSE", async () => {
		const running = deferred();
		const { m, session } = fixture(async (_text, opts) => {
			opts.preflightResult(true);
			session.isStreaming = true;
			session.isIdle = false;
			await running.promise;
		});
		const result = await execute(m, { cmd: "prompt", text: "hello" });
		expect(result).toEqual({ ok: true, data: { accepted: true } });
		expect(m.promptSubmitting).toBe(false);
		running.reject(new Error("late run failure"));
		await vi.waitFor(() => expect(m.buffer.some((frame) => JSON.parse(frame.json).message === "late run failure")).toBe(true));
	});

	it("rejects preflight with its real error and allows a retry", async () => {
		const { m } = fixture(async (_text, opts) => {
			opts.preflightResult(false);
			throw new Error("missing credentials");
		});
		expect(await execute(m, { cmd: "prompt", text: "hello" })).toEqual({ ok: false, error: "missing credentials" });
		expect(m.promptSubmitting).toBe(false);
		expect(await execute(m, { cmd: "prompt", text: "try again" })).toMatchObject({ ok: false, error: "missing credentials" });
	});

	it("does not convert concurrent ordinary submits into steering messages", async () => {
		const gate = deferred();
		const { m, session } = fixture(async (_text, opts) => {
			await gate.promise;
			opts.preflightResult(true);
			session.isStreaming = true;
			session.isIdle = false;
		});
		const first = execute(m, { cmd: "prompt", text: "first" });
		expect(await execute(m, { cmd: "prompt", text: "duplicate" })).toMatchObject({ ok: false });
		gate.resolve();
		expect(await first).toMatchObject({ ok: true });
		expect(await execute(m, { cmd: "prompt", text: "stale ordinary submit" })).toMatchObject({ ok: false });
		expect(session.prompt).toHaveBeenCalledTimes(1);
	});

	it("passes explicit steer/followUp through preflight while busy", async () => {
		const { m, session } = fixture(async (_text, opts) => { opts.preflightResult(true); });
		session.isStreaming = true;
		session.isIdle = false;
		for (const behavior of ["steer", "followUp"] as const) {
			expect(await execute(m, { cmd: "prompt", text: behavior, behavior })).toMatchObject({ ok: true });
			expect(session.prompt).toHaveBeenLastCalledWith(behavior, expect.objectContaining({ streamingBehavior: behavior }));
		}
		expect(m.growth!.prepare).not.toHaveBeenCalled();
	});

	it("editAndResend stops the running turn first, then navigates and re-prompts", async () => {
		const order: string[] = [];
		const { m, session } = fixture(async () => { order.push("prompt"); }, {
			abort: vi.fn(async () => { order.push("abort"); session.isStreaming = false; session.isIdle = true; }),
			navigateTree: vi.fn(async (entryId: string) => { order.push(`navigate:${entryId}`); return { cancelled: false }; }),
		});
		session.isStreaming = true;
		session.isIdle = false;
		const result = await execute(m, { cmd: "editAndResend", entryId: "entry-1", text: "改过的内容" });
		expect(result).toEqual({ ok: true });
		// 必须"先停下、再回到该消息、再重新提问"，否则服务端会拒绝并发操作
		expect(order).toEqual(["abort", "navigate:entry-1", "prompt"]);
		expect(session.prompt).toHaveBeenCalledWith("改过的内容");
		expect(m.promptSubmitting).toBe(false);
	});

	it("editAndResend skips the abort when nothing is running", async () => {
		const abort = vi.fn(async () => {});
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		const { m, session } = fixture(async () => {}, { abort, navigateTree });
		expect(await execute(m, { cmd: "editAndResend", entryId: "entry-2", text: "新内容" })).toEqual({ ok: true });
		expect(abort).not.toHaveBeenCalled();
		expect(navigateTree).toHaveBeenCalledWith("entry-2");
		expect(session.prompt).toHaveBeenCalledWith("新内容");
	});

	it("editAndResend rejects a missing entry or empty text without touching the session", async () => {
		const abort = vi.fn(async () => {});
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		const { m, session } = fixture(async () => {}, { abort, navigateTree });
		expect(await execute(m, { cmd: "editAndResend", text: "只有文本" })).toMatchObject({ ok: false, error: "missing entryId" });
		expect(await execute(m, { cmd: "editAndResend", entryId: "entry-3", text: "   " })).toMatchObject({ ok: false, error: "empty prompt" });
		expect(abort).not.toHaveBeenCalled();
		expect(navigateTree).not.toHaveBeenCalled();
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("blocks tool changes and reload while accepting or awaiting settled", async () => {
		const { m } = fixture(async () => {});
		for (const field of ["promptSubmitting", "runActive", "resourceReloading"] as const) {
			m[field] = true;
			for (const command of [{ cmd: "setActiveTools", names: ["read"] }, { cmd: "setToolPreset", preset: "full" }, { cmd: "reload" }] as const) {
				expect(await execute(m, command as any)).toMatchObject({ ok: false });
			}
			m[field] = false;
		}
	});
});
