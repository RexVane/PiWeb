import { describe, expect, it } from "vitest";
import { buildGrowthRounds } from "../src/lib/growth-rounds";
import type { GrowthStep } from "../src/lib/types";

const stats = { added: 0, modified: 0, deleted: 0, renamed: 0, add: 0, del: 0 };
const step = (seq: number, kind: GrowthStep["kind"], parent: string, tree: string): GrowthStep => ({
	seq, kind, parent, tree, session: "session.jsonl", label: "", ts: seq, changes: [], stats,
});

describe("buildGrowthRounds", () => {
	it("groups tool snapshots into turns and keeps an active turn live", () => {
		const steps = [
			{ ...step(1, "baseline", "empty", "a"), initial: true },
			step(2, "tool", "a", "b"),
			step(3, "tool", "b", "c"),
			step(4, "turn", "c", "c"),
			step(5, "turn", "c", "c"),
			step(6, "tool", "c", "d"),
		];
		const rounds = buildGrowthRounds(steps, [1.5, 4.5, 5.5]);
		expect(rounds.map((round) => round.steps.map((item) => item.seq))).toEqual([[2, 3, 4], [5], [6]]);
		expect(rounds.map((round) => [round.fromTree, round.toTree])).toEqual([["a", "c"], ["c", "c"], ["c", "d"]]);
	});

	it("treats external and manual changes as separate navigation records", () => {
		const rounds = buildGrowthRounds([
			{ ...step(1, "manual", "empty", "a"), initial: true },
			step(2, "external", "a", "b"),
			step(3, "manual", "b", "c"),
			step(4, "tool", "c", "d"),
		]);
		expect(rounds.map((round) => round.id)).toEqual([1, 2, 3]);
	});

	it("recovers missing turn markers from user message timestamps", () => {
		const rounds = buildGrowthRounds([
			{ ...step(1, "baseline", "empty", "a"), initial: true },
			step(2, "tool", "a", "b"),
			step(3, "tool", "b", "c"),
			step(4, "turn", "c", "c"),
			step(5, "tool", "c", "d"),
			step(6, "turn", "d", "d"),
			step(7, "tool", "d", "e"),
			step(8, "tool", "e", "f"),
		], [1.5, 2.5, 4.5, 6.5]);
		expect(rounds.map((round) => round.steps.map((item) => item.seq))).toEqual([[2], [3, 4], [5, 6], [7, 8]]);
	});

	it("keeps quiet rounds and flags history before tracking began", () => {
		const rounds = buildGrowthRounds([
			{ ...step(1, "baseline", "empty", "a"), initial: true, ts: 2.5 },
			{ ...step(2, "tool", "a", "b"), ts: 3.5 },
			{ ...step(3, "turn", "b", "b"), ts: 3.8 },
			{ ...step(4, "turn", "b", "b"), ts: 4.5 },
		], [1, 2, 3, 4]);
		expect(rounds).toHaveLength(4);
		expect(rounds.map((round) => round.recorded)).toEqual([false, false, true, true]);
		expect(rounds.map((round) => [round.fromTree, round.toTree])).toEqual([[null, null], [null, null], ["a", "b"], ["b", "b"]]);
	});

	it("does not present a first tool snapshot without a baseline as real additions", () => {
		const rounds = buildGrowthRounds([
			{ ...step(1, "tool", "empty", "a"), initial: true },
			step(2, "turn", "a", "a"),
			step(3, "tool", "a", "b"),
		], [0.5, 2.5]);
		expect(rounds.map((round) => round.recorded)).toEqual([false, true]);
		expect(rounds[1]).toMatchObject({ fromTree: "a", toTree: "b" });
	});
});
