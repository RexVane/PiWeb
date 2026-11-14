import { afterEach, beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ entries: vi.fn(), forget: vi.fn() }));
vi.mock("../src/lib/workspace-store", () => ({ getArchivedEntries: deps.entries, forgetSession: deps.forget }));

type State = { timer?: ReturnType<typeof setTimeout>; repeat?: ReturnType<typeof setInterval>; running?: Promise<void> };
const retentionGlobal = globalThis as typeof globalThis & { __piWebArchivedRetention?: State };
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); vi.resetAllMocks(); });
afterEach(async () => {
	const state = retentionGlobal.__piWebArchivedRetention;
	clearTimeout(state?.timer); clearInterval(state?.repeat);
	await state?.running;
	delete retentionGlobal.__piWebArchivedRetention;
	vi.useRealTimers();
});

it("creates one process-wide scheduler across module reloads and does not overlap a pending sweep", async () => {
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => { finish = resolve; });
	let active = 0, maxActive = 0;
	deps.entries.mockImplementation(async () => {
		active += 1; maxActive = Math.max(maxActive, active);
		try { await gate; return []; } finally { active -= 1; }
	});
	const first = await import("../src/lib/session-retention");
	first.startArchivedSessionRetention({ delayMs: 1, intervalMs: 1, log: () => {} });
	try {
		await vi.advanceTimersByTimeAsync(1);
		expect(deps.entries).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10);
		expect(deps.entries).toHaveBeenCalledTimes(1);
		const timers = vi.getTimerCount();
		vi.resetModules();
		const second = await import("../src/lib/session-retention");
		second.startArchivedSessionRetention({ delayMs: 1, intervalMs: 1, log: () => {} });
		expect(vi.getTimerCount()).toBe(timers);
		finish();
		await retentionGlobal.__piWebArchivedRetention?.running;
		await vi.advanceTimersByTimeAsync(2);
		expect(deps.entries.mock.calls.length).toBeGreaterThan(1);
		expect(maxActive).toBe(1);
	} finally { finish(); }
});
