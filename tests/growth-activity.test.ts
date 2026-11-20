import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginGrowthRun, finishGrowthRun, enableGrowthActivity, resolveGrowthAttribution, completeGrowthRun } from "@/lib/growth-activity";
import { recycleFixture } from "./fixtures/recycle";

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(recycleFixture)); });
async function setup() { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-growth-activity-")); temporary.push(cwd); return cwd; }
describe("growth workspace attribution", () => {
	it("marks both overlapping sessions as shared and a subsequent isolated run as individual", async () => {
		const cwd = await setup(); beginGrowthRun(cwd, "a.jsonl"); beginGrowthRun(cwd, "b.jsonl");
		const first = finishGrowthRun(cwd, "a.jsonl"); const second = finishGrowthRun(cwd, "b.jsonl");
		expect(first).toMatchObject({ attribution: "shared", concurrentSessions: ["a.jsonl", "b.jsonl"] });
		expect(second.concurrentSessions).toEqual(["b.jsonl", "a.jsonl"]);
		await completeGrowthRun(cwd, first.runId); await completeGrowthRun(cwd, second.runId);
		beginGrowthRun(cwd, "c.jsonl"); const third = finishGrowthRun(cwd, "c.jsonl"); expect(third.attribution).toBeUndefined(); await completeGrowthRun(cwd, third.runId);
	});
	it("reads an overlapping live marker from another process scope and retains shared attribution", async () => {
		const cwd = await setup(); const gitDir = path.join(cwd, ".git"); const activity = path.join(gitDir, "piweb", "activity");
		await fs.mkdir(activity, { recursive: true }); enableGrowthActivity(cwd, gitDir); beginGrowthRun(cwd, "local.jsonl");
		await fs.writeFile(path.join(activity, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json"), JSON.stringify({ id: "external", session: "peer.jsonl", pid: process.pid,
			startedAt: Date.now() - 1000, heartbeatAt: Date.now() }));
		const ended = finishGrowthRun(cwd, "local.jsonl");
		expect(await resolveGrowthAttribution(cwd, ended)).toMatchObject({ attribution: "shared", concurrentSessions: ["local.jsonl", "peer.jsonl"] });
		await completeGrowthRun(cwd, ended.runId);
	});
	it("does not delete a peer whose heartbeat refreshed after the initial expiry check", async () => {
		const cwd = await setup(); const gitDir = path.join(cwd, ".git");
		await fs.mkdir(path.join(gitDir, "piweb"), { recursive: true });
		enableGrowthActivity(cwd, gitDir); beginGrowthRun(cwd, "local.jsonl");
		const ended = finishGrowthRun(cwd, "local.jsonl"); await resolveGrowthAttribution(cwd, ended);
		const peer = path.join(gitDir, "piweb", "activity", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json");
		await fs.writeFile(peer, "fresh peer"); await fs.utimes(peer, 1, 1);
		const originalStat = fs.stat.bind(fs); let refreshed = false;
		vi.spyOn(fs, "stat").mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
			const previous = await originalStat(...args);
			if (args[0] === peer && !refreshed) { refreshed = true; await fs.utimes(peer, new Date(), new Date()); }
			return previous;
		});
		await completeGrowthRun(cwd, ended.runId);
		expect(refreshed).toBe(true); expect(await fs.readFile(peer, "utf8")).toBe("fresh peer");
	});
	it("does not recreate a .git directory when a turn finishes after it was moved", async () => {
		const cwd = await setup();
		const gitDir = path.join(cwd, ".git");
		await fs.mkdir(path.join(gitDir, "piweb"), { recursive: true });
		enableGrowthActivity(cwd, gitDir);
		beginGrowthRun(cwd, "local.jsonl");
		const ended = finishGrowthRun(cwd, "local.jsonl");
		await resolveGrowthAttribution(cwd, ended);
		await fs.rename(gitDir, path.join(cwd, "retired-git"));
		await completeGrowthRun(cwd, ended.runId);
		await expect(fs.stat(gitDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
