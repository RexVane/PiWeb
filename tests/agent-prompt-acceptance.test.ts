import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, dispose: () => {} }),
}));
import { execute, parseLastEventId, sseEventId } from "../src/lib/agent-manager";

type Managed = Parameters<typeof execute>[0];
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function fixture(prompt: (...args: any[]) => Promise<void>, extra: Record<string, unknown> = {}) {
	// 假会话也要带工具 API：applyToolPolicy 会读 getAllTools / getActiveToolNames 并写回激活集，
	// 缺了就会抛「session.getAllTools is not a function」或误判「cannot disable all tools」
	const tools = [{ name: "read" }, { name: "bash" }, { name: "edit" }];
	const session = {
		prompt: vi.fn(prompt),
		isStreaming: false,
		isIdle: true,
		getAllTools: () => tools,
		getActiveToolNames: () => tools.map((tool) => tool.name),
		setActiveToolsByName: vi.fn(),
		...extra,
	};
	const m = {
		session, creating: null, disposed: false, promptSubmitting: false, runActive: false,
		resourceReloading: false, resourceReloadPending: false, cwd: "test", sessionPath: "test",
		seq: 0, buffer: [], subscribers: new Set(), lastActive: 0,
		// 真实会话在 ensureSession 里一定初始化这几项；applyToolPolicy 会读它们，
		// 缺了就抛 TypeError，execute 会把「改工具」误报成 ok:false
		requestedTools: new Set<string>(),
		ledger: { entries: [] as unknown[], statsVersion: 0, onEvent: () => {}, drainDirty: () => [] },
		messageIds: new WeakMap(),
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
		const { m, session } = fixture(async (_text, opts) => { order.push("prompt"); opts.preflightResult(true); }, {
			abort: vi.fn(async () => { order.push("abort"); session.isStreaming = false; session.isIdle = true; }),
			navigateTree: vi.fn(async (entryId: string) => { order.push(`navigate:${entryId}`); return { cancelled: false }; }),
		});
		session.isStreaming = true;
		session.isIdle = false;
		const result = await execute(m, { cmd: "editAndResend", entryId: "entry-1", text: "改过的内容" });
		expect(result).toEqual({ ok: true, data: { accepted: true } });
		// 必须"先停下、再回到该消息、再重新提问"，否则服务端会拒绝并发操作
		expect(order).toEqual(["abort", "navigate:entry-1", "prompt"]);
		expect(session.prompt).toHaveBeenCalledWith("改过的内容", expect.objectContaining({ source: "rpc" }));
		expect(m.promptSubmitting).toBe(false);
	});

	it("editAndResend skips the abort when nothing is running", async () => {
		const abort = vi.fn(async () => {});
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		const { m, session } = fixture(async (_text, opts) => { opts.preflightResult(true); }, { abort, navigateTree });
		expect(await execute(m, { cmd: "editAndResend", entryId: "entry-2", text: "新内容" })).toEqual({ ok: true, data: { accepted: true } });
		expect(abort).not.toHaveBeenCalled();
		expect(navigateTree).toHaveBeenCalledWith("entry-2");
		expect(session.prompt).toHaveBeenCalledWith("新内容", expect.objectContaining({ source: "rpc" }));
	});

	it("editAndResend keeps the images of the message being edited", async () => {
		// 回归：客户端只发改过的文字，服务端原先直接 submitPrompt(text)，带图的消息一编辑图就没了
		const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
		const entries: Record<string, unknown> = {
			"entry-img": { type: "message", id: "entry-img", message: { role: "user", content: [{ type: "text", text: "看图" }, image] } },
			"entry-plain": { type: "message", id: "entry-plain", message: { role: "user", content: [{ type: "text", text: "没图" }] } },
		};
		const { m, session } = fixture(async (_text, opts) => { opts.preflightResult(true); }, {
			navigateTree: vi.fn(async () => ({ cancelled: false })),
			sessionManager: { getEntry: (id: string) => entries[id] },
		});
		expect(await execute(m, { cmd: "editAndResend", entryId: "entry-img", text: "改过的看图" })).toEqual({ ok: true, data: { accepted: true } });
		expect(session.prompt).toHaveBeenLastCalledWith("改过的看图", expect.objectContaining({ images: [image] }));
		expect(await execute(m, { cmd: "editAndResend", entryId: "entry-plain", text: "还是没图" })).toEqual({ ok: true, data: { accepted: true } });
		expect(session.prompt.mock.calls.at(-1)?.[1]).not.toHaveProperty("images");
	});

	it("editAndResend returns once the new prompt is accepted, so steering works during the re-answer", async () => {
		// 回归：旧实现 await 整轮 prompt，这期间 promptSubmitting 一直为真，插话/排队全被拒
		const running = deferred();
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		const steer = vi.fn(async () => {});
		const { m, session } = fixture(async (_text, opts) => {
			opts.preflightResult(true);
			session.isStreaming = true;
			session.isIdle = false;
			await running.promise;
		}, { navigateTree, steer });
		expect(await execute(m, { cmd: "editAndResend", entryId: "entry-4", text: "改口" })).toEqual({ ok: true, data: { accepted: true } });
		expect(m.promptSubmitting).toBe(false);
		expect(await execute(m, { cmd: "steer", text: "再补一句" })).toEqual({ ok: true });
		expect(steer).toHaveBeenCalledWith("再补一句", undefined);
		running.resolve();
	});

	it("setToolPreset on a cold session only records the choice instead of starting the agent", async () => {
		const { m } = fixture(async () => {});
		(m as any).session = null;
		(m as any).toolPreset = "readonly";
		expect(await execute(m, { cmd: "setToolPreset", preset: "full" })).toEqual({ ok: true });
		expect((m as any).toolPreset).toBe("full");
		expect((m as any).session).toBeNull();
		expect((m as any).creating).toBeNull();
		const published = m.buffer.map((frame) => JSON.parse(frame.json));
		expect(published).toContainEqual(expect.objectContaining({ type: "tools", toolPreset: "full" }));
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

	it("only resumes SSE from an event id issued by the same managed session", () => {
		const { m } = fixture(async () => {});
		(m as any).epoch = "abc123";
		expect(sseEventId(m, 42)).toBe("abc123.42");
		expect(parseLastEventId(m, "abc123.42")).toBe(42);
		// 服务重启 / 会话被回收重开后 epoch 变了：旧 id 不能续到新一轮的同号事件上
		expect(parseLastEventId(m, "zzz999.42")).toBeUndefined();
		// 旧格式（纯数字）同样当没有，回退快照
		expect(parseLastEventId(m, "42")).toBeUndefined();
		expect(parseLastEventId(m, null)).toBeUndefined();
	});

	it("blocks reload while accepting or reloading resources", async () => {
		const { m } = fixture(async () => {});
		// 提交中 / 正在重载资源都属于危险的中途状态，reload 仍然要拦。
		for (const field of ["promptSubmitting", "resourceReloading"] as const) {
			m[field] = true;
			expect(await execute(m, { cmd: "reload" } as any)).toMatchObject({ ok: false });
			m[field] = false;
		}
	});

	it("allows tool changes while the agent is running so they apply to the next turn", async () => {
		// 用户要求工具启用能立即生效（含模型运行过程中）：SDK 的 setActiveToolsByName 不做 busy
		// 检查、改完重建系统提示词，下一轮生效，所以 PiWeb 不再自行拦一层。
		const { m } = fixture(async () => {});
		for (const field of ["promptSubmitting", "runActive", "resourceReloading"] as const) {
			m[field] = true;
			for (const command of [{ cmd: "setActiveTools", names: ["read"] }, { cmd: "setToolPreset", preset: "full" }] as const) {
				expect(await execute(m, command as any)).toMatchObject({ ok: true });
			}
			m[field] = false;
		}
	});
});
