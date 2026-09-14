import type { GrowthStep } from "./types";

export interface GrowthRound {
	/** 真实用户轮次；不会因没有文件改动而跳号。 */
	id: number;
	startedAt: number;
	first: GrowthStep | null;
	/** 此轮结束时可用的最后一张快照；无改动轮沿用前一张。 */
	last: GrowthStep | null;
	steps: GrowthStep[];
	/** 相邻两轮终点的 tree；第一轮从 prompt 前的基线开始。 */
	fromTree: string | null;
	toTree: string | null;
	/** 旧会话可能在启用生长账本前已发生，不能假装它是零改动。 */
	recorded: boolean;
}

/** 兼容没有消息时间戳的调用者：按账本里的 turn 标记分组。 */
function ledgerRounds(steps: GrowthStep[]): GrowthRound[] {
	const rounds: GrowthRound[] = [];
	let current: GrowthStep[] = [];
	const flush = () => {
		if (!current.length) return;
		const first = current[0];
		const last = current[current.length - 1];
		rounds.push({ id: rounds.length + 1, startedAt: first.ts, first, last, steps: current, fromTree: first.parent, toTree: last.tree, recorded: true });
		current = [];
	};
	for (const [index, step] of steps.entries()) {
		if (index === 0 && step.initial) continue;
		if (step.kind === "baseline") {
			flush();
			continue;
		}
		if (step.kind === "external" || step.kind === "manual") flush();
		current.push(step);
		if (step.kind === "turn" || step.kind === "external" || step.kind === "manual") flush();
	}
	flush();
	return rounds;
}

/** 轮数以持久会话的用户消息为准；快照只负责证明这一轮的前后树与差异。 */
export function buildGrowthRounds(steps: GrowthStep[], turnStarts?: number[]): GrowthRound[] {
	if (turnStarts === undefined) return ledgerRounds(steps);
	if (!turnStarts.length) return [];
	const starts: number[] = [];
	for (const value of turnStarts) {
		const previous = starts[starts.length - 1];
		starts.push(Number.isFinite(value) ? Math.max(value, previous === undefined ? value : previous + 0.001) : (previous ?? 0) + 0.001);
	}
	const ordered = [...steps].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
	const rounds: GrowthRound[] = [];
	let cursor = 0;
	let before: GrowthStep | null = null;
	let previousEnd: GrowthStep | null = null;
	for (let index = 0; index < starts.length; index += 1) {
		const start = starts[index];
		const end = starts[index + 1] ?? Infinity;
		while (cursor < ordered.length && ordered[cursor].ts < start) before = ordered[cursor++];
		const atStart = before;
		const current: GrowthStep[] = [];
		while (cursor < ordered.length && ordered[cursor].ts < end) {
			const step = ordered[cursor++];
			if (step.kind !== "baseline") current.push(step);
			before = step;
		}
		const first = current[0] ?? null;
		const last: GrowthStep | null = current[current.length - 1] ?? (atStart && (!previousEnd || atStart.ts > previousEnd.ts) ? atStart : previousEnd);
		const fromTree = previousEnd?.tree ?? atStart?.tree ?? first?.parent ?? null;
		rounds.push({
			id: index + 1,
			startedAt: start,
			first,
			last,
			steps: current,
			fromTree,
			toTree: last?.tree ?? null,
			recorded: current.length > 0 && fromTree !== null && !first?.initial,
		});
		previousEnd = last;
	}
	return rounds;
}
