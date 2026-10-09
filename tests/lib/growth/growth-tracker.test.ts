import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAvailable } from "../../../src/lib/growth/growth-service";
import { createGrowthTracker } from "../../../src/lib/growth/growth-tracker";
import type { GrowthRound, WebEvent } from "../../../src/lib/types";

const waitFor = async (pred: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 50));
	}
};

const roundsOf = (events: WebEvent[]): GrowthRound[] => events.flatMap((e) => (e.type === "growth" ? [e.round] : []));

describe("growth-tracker (real git)", () => {
	let tempDir = "";
	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-tracker-"));
	});
	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("commits the user's edits before a prompt and exactly one commit per round", async () => {
		if (!(await isAvailable())) return;
		const cwd = path.join(tempDir, "work");
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(path.join(cwd, "a.txt"), "a\n");
		const events: WebEvent[] = [];
		const entries: Array<{ type: string; id: string; message: { role: string; content?: unknown; stopReason?: string } }> = [
			{ type: "message", id: "old", message: { role: "user", content: "上一次会话的提问" } },
		];
		const tracker = createGrowthTracker({ cwd, sessionPath: path.join(tempDir, "s.jsonl"), publish: (e) => events.push(e), entries: () => entries });
		try {
			// 工作区第一次：基线
			await tracker.prepare();
			expect(roundsOf(events).map((r) => r.kind)).toEqual(["baseline"]);
			// 两轮之间用户自己改了文件：发 prompt 前单独记一笔
			await fs.writeFile(path.join(cwd, "a.txt"), "a edited\n");
			await tracker.prepare();
			expect(roundsOf(events).map((r) => r.kind)).toEqual(["baseline", "user"]);
			// 没改动：不再记
			await tracker.prepare();
			expect(roundsOf(events)).toHaveLength(2);

			// pi 的一轮：agent_start → (重试的第二次 agent_start 不重开一轮) → agent_settled
			tracker.onEvent({ type: "agent_start" } as never);
			entries.push({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "把 b 加上\n细节略" }] } });
			tracker.onEvent({ type: "agent_start" } as never);
			await fs.writeFile(path.join(cwd, "b.txt"), "b\n");
			entries.push({ type: "message", id: "u2", message: { role: "user", content: "追加：顺便写个 c" } });
			entries.push({ type: "message", id: "r1", message: { role: "assistant", stopReason: "stop" } });
			tracker.onEvent({ type: "agent_settled" } as never);
			await waitFor(() => roundsOf(events).length >= 3);
			expect(roundsOf(events)[2]).toMatchObject({
				kind: "round",
				title: "把 b 加上",
				promptIds: ["u1", "u2"],
				status: "done",
				changes: [{ status: "A", path: "b.txt", add: 1, del: 0 }],
			});

			// 纯聊天、被中止的一轮也提交（空 commit），轮号与对话一一对应
			tracker.onEvent({ type: "agent_start" } as never);
			entries.push({ type: "message", id: "u3", message: { role: "user", content: "只是问问" } });
			entries.push({ type: "message", id: "r2", message: { role: "assistant", stopReason: "aborted" } });
			tracker.onEvent({ type: "agent_settled" } as never);
			await waitFor(() => roundsOf(events).length >= 4);
			const quiet = roundsOf(events)[3];
			expect(quiet).toMatchObject({ kind: "round", title: "只是问问", promptIds: ["u3"], status: "aborted", changes: [], tree: roundsOf(events)[2].tree });

			// 没有 agent_start 的 settle（比如手动压缩）不算一轮
			tracker.onEvent({ type: "agent_settled" } as never);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(roundsOf(events)).toHaveLength(4);
			expect(events.filter((e) => e.type === "growth_error" && e.message)).toHaveLength(0);

			// 立即记录同样走链（没有变化 → null）
			expect(await tracker.recordNow()).toBeNull();
		} finally {
			tracker.dispose();
		}
	}, 30_000);

	it("retries a failed baseline and clears the visible error after recovery", async () => {
		if (!(await isAvailable())) return;
		const cwd = path.join(tempDir, "not-created-yet");
		const events: WebEvent[] = [];
		const tracker = createGrowthTracker({ cwd, sessionPath: path.join(tempDir, "recover.jsonl"), publish: (event) => events.push(event), entries: () => [] });
		try {
			await tracker.prepare();
			expect(events.some((event) => event.type === "growth_error" && event.message)).toBe(true);
			expect(tracker.getError()).toMatch(/workspace directory not found/);
			await fs.mkdir(cwd, { recursive: true });
			await fs.writeFile(path.join(cwd, "a.txt"), "ready\n");
			await tracker.prepare();
			expect(events.some((event) => event.type === "growth_error" && event.message === null)).toBe(true);
			expect(tracker.getError()).toBeNull();
			expect(roundsOf(events).map((r) => r.kind)).toEqual(["baseline"]);
		} finally {
			tracker.dispose();
		}
	}, 20_000);
});
