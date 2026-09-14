import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAvailable } from "../src/lib/growth-service";
import { createGrowthTracker, isMutatingTool, labelForTool } from "../src/lib/growth-tracker";
import type { WebEvent } from "../src/lib/types";

const waitFor = async (pred: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 50));
	}
};

describe("growth-tracker", () => {
	it("classifies tools and labels them", () => {
		expect(isMutatingTool("read")).toBe(false);
		expect(isMutatingTool("Bash")).toBe(true);
		expect(isMutatingTool("my_extension_tool")).toBe(true);
		// The label strips the workspace prefix; use paths of the host platform so the
		// expectation does not depend on Windows-specific path handling.
		const workspace = process.platform === "win32" ? "D:/p" : "/p";
		const written = process.platform === "win32" ? "D:\\p\\src\\a.ts" : "/p/src/a.ts";
		expect(labelForTool(workspace, "bash", { command: "  mkdir -p src \n echo hi" })).toBe("bash · mkdir -p src");
		expect(labelForTool(workspace, "write", { path: written })).toBe("write · src/a.ts");
		expect(labelForTool(workspace, "edit", { path: "../x.ts" })).toBe("edit · ../x.ts");
		expect(labelForTool(workspace, "bash", { command: "x".repeat(80) })).toHaveLength("bash · ".length + 60);
	});

	describe("with real git", () => {
		let tempDir = "";
		let previousAgentDir: string | undefined;
		beforeEach(async () => {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-tracker-"));
			process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent");
		});
		afterEach(async () => {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		});

		it("prepares a baseline before agent_start and records tool changes without duplicating it", async () => {
			if (!(await isAvailable())) return;
			const cwd = path.join(tempDir, "work");
			await fs.mkdir(cwd, { recursive: true });
			await fs.writeFile(path.join(cwd, "a.txt"), "a\n");
			const events: WebEvent[] = [];
			const tracker = createGrowthTracker({ cwd, sessionPath: path.join(tempDir, "s.jsonl"), publish: (e) => events.push(e) });
			try {
				await tracker.prepare();
				tracker.onEvent({ type: "agent_start" } as never);
				await waitFor(() => events.some((e) => e.type === "growth"));
				const baseline = events.find((e) => e.type === "growth");
				expect(baseline && baseline.type === "growth" && baseline.step.kind).toBe("baseline");
				expect(events.filter((e) => e.type === "growth")).toHaveLength(1);

				tracker.onEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "printf b > b.txt" } } as never);
				await fs.mkdir(path.join(cwd, "generated"));
				await fs.writeFile(path.join(cwd, "b.txt"), "b\n");
				if (process.platform === "win32") {
					await waitFor(() => events.some((e) => e.type === "growth_pending" && e.paths.includes("generated/")));
					expect(events.some((e) => e.type === "growth_pending" && e.paths.includes("b.txt"))).toBe(true);
				}
				tracker.onEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false } as never);
				await waitFor(() => events.filter((e) => e.type === "growth").length >= 2);
				const step = events.filter((e) => e.type === "growth")[1];
				expect(step.type === "growth" && step.step).toMatchObject({ kind: "tool", label: "bash · printf b > b.txt", toolCallId: "t1", changes: [{ status: "A", path: "b.txt" }] });

				// 本轮记过工具快照：回合结束补一条终点步（前端按它切分回合）
				tracker.onEvent({ type: "agent_end" } as never);
				await waitFor(() => events.filter((e) => e.type === "growth").length >= 3);
				const turn = events.filter((e) => e.type === "growth")[2];
				expect(turn.type === "growth" && turn.step).toMatchObject({ kind: "turn", changes: [], parent: step.type === "growth" ? step.step.tree : "" });
				// 纯聊天回合也留下终点，重开会话后仍能还原真实轮数与零改动。
				tracker.onEvent({ type: "agent_start" } as never);
				tracker.onEvent({ type: "agent_end" } as never);
				await waitFor(() => events.filter((e) => e.type === "growth").length >= 4);
				const quietTurn = events.filter((e) => e.type === "growth")[3];
				expect(quietTurn.type === "growth" && quietTurn.step).toMatchObject({ kind: "turn", changes: [], tree: turn.type === "growth" ? turn.step.tree : "" });
				expect(events.filter((e) => e.type === "error")).toHaveLength(0);
				tracker.onEvent({ type: "agent_end", willRetry: true } as never);
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(events.filter((e) => e.type === "growth")).toHaveLength(4);

				// 手动快照同样走链（没有变化 → null）
				expect(await tracker.snapshotNow()).toBeNull();
			} finally {
				tracker.dispose();
			}
		}, 20_000);

		it("retries a failed baseline and clears the visible error after recovery", async () => {
			if (!(await isAvailable())) return;
			const cwd = path.join(tempDir, "not-created-yet");
			const events: WebEvent[] = [];
			const tracker = createGrowthTracker({ cwd, sessionPath: path.join(tempDir, "recover.jsonl"), publish: (event) => events.push(event) });
			try {
				await tracker.prepare();
				expect(events.some((event) => event.type === "growth_error" && event.message)).toBe(true);
				expect(tracker.getError()).toMatch(/workspace directory not found/);
				await fs.mkdir(cwd, { recursive: true });
				await fs.writeFile(path.join(cwd, "a.txt"), "ready\n");
				await tracker.prepare();
				expect(events.some((event) => event.type === "growth_error" && event.message === null)).toBe(true);
				expect(tracker.getError()).toBeNull();
				expect(events.some((event) => event.type === "growth" && event.step.kind === "baseline")).toBe(true);
			} finally {
				tracker.dispose();
			}
		}, 20_000);
	});
});
