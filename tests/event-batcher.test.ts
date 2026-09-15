/**
 * 流式事件批量器：token 速率再高也只每帧渲染一次。
 * 用注入的 schedule 精确控制冲刷时机，不依赖真实计时器。
 */
import { describe, expect, it } from "vitest";
import { createEventBatcher } from "../src/lib/event-batcher";

function harness(limit?: number) {
	const calls: number[][] = [];
	const timers: Array<() => void> = [];
	const batcher = createEventBatcher<number>({
		flush: (events) => calls.push(events),
		schedule: (run) => {
			timers.push(run);
			return () => {
				const index = timers.indexOf(run);
				if (index >= 0) timers.splice(index, 1);
			};
		},
		...(limit === undefined ? {} : { limit }),
	});
	return { batcher, calls, timers, tick: () => timers.shift()?.() };
}

describe("event batcher", () => {
	it("folds a whole burst into one flush and keeps the event order", () => {
		const { batcher, calls, timers, tick } = harness();
		batcher.push(1);
		batcher.push(2);
		batcher.push(3);
		// 只安排一次冲刷，且还没有渲染
		expect(timers).toHaveLength(1);
		expect(calls).toEqual([]);
		tick();
		expect(calls).toEqual([[1, 2, 3]]);
		expect(batcher.size()).toBe(0);
	});

	it("schedules again after a flush so later events still render", () => {
		const { batcher, calls, timers, tick } = harness();
		batcher.push(1);
		tick();
		batcher.push(2);
		expect(timers).toHaveLength(1);
		tick();
		expect(calls).toEqual([[1], [2]]);
	});

	it("flushes immediately when the buffer reaches the limit", () => {
		const { batcher, calls, timers } = harness(3);
		batcher.push(1);
		batcher.push(2);
		batcher.push(3);
		expect(calls).toEqual([[1, 2, 3]]);
		expect(timers).toHaveLength(0);
		batcher.push(4);
		expect(batcher.size()).toBe(1);
	});

	it("manual flush runs pending events and cancels the scheduled render", () => {
		const { batcher, calls, timers } = harness();
		batcher.push(1);
		batcher.flush();
		expect(calls).toEqual([[1]]);
		expect(timers).toHaveLength(0);
		batcher.flush();
		expect(calls).toHaveLength(1);
	});

	it("cancel drops buffered events (a snapshot supersedes them)", () => {
		const { batcher, calls, timers, tick } = harness();
		batcher.push(1);
		batcher.push(2);
		batcher.cancel();
		expect(batcher.size()).toBe(0);
		expect(timers).toHaveLength(0);
		tick();
		expect(calls).toEqual([]);
	});
});
