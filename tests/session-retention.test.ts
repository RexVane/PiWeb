/**
 * 归档会话保留期：超过 30 天没有活动就自动删除。
 * 只动「在归档列表里」的会话；没归档的、正在使用的都不碰。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepArchivedSessions } from "../src/lib/session-retention";
import { getWorkspaceRegistry } from "../src/lib/workspace-store";

const DAY = 24 * 60 * 60 * 1000;
let agentDir: string;
const prior = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
	agentDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-retention-")));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await fs.mkdir(path.join(agentDir, "sessions", "--ws--"), { recursive: true });
});

afterEach(async () => {
	if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prior;
	await fs.rm(agentDir, { recursive: true, force: true });
});

/** 造一个会话文件，并把 mtime 设成 daysAgo 天前 */
async function session(name: string, daysAgo: number): Promise<string> {
	const file = path.join(agentDir, "sessions", "--ws--", `${name}.jsonl`);
	await fs.writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: "/ws" })}\n`, "utf8");
	const when = new Date(Date.now() - daysAgo * DAY);
	await fs.utimes(file, when, when);
	return file;
}

async function archive(...paths: string[]) {
	await fs.writeFile(path.join(agentDir, "web-workspaces.json"), JSON.stringify({ schema: 1, workspaces: [], aliases: {}, archivedSessions: paths, removedWorkspaces: [] }), "utf8");
}

const exists = async (file: string) => !!(await fs.stat(file).catch(() => null));

describe("archived session retention", () => {
	it("deletes archived sessions idle past the retention window and keeps fresh ones", async () => {
		const stale = await session("stale", 40);
		const fresh = await session("fresh", 2);
		await archive(stale, fresh);

		const report = await sweepArchivedSessions({ log: () => {} });

		expect(report.deleted.map((entry) => path.basename(entry.path))).toEqual(["stale.jsonl"]);
		expect(report.deleted[0].idleDays).toBeGreaterThanOrEqual(39);
		expect(await exists(stale)).toBe(false);
		expect(await exists(fresh)).toBe(true);
		const registry = await getWorkspaceRegistry();
		expect(registry.archivedSessions).toEqual([fresh]);
	});

	it("never touches sessions that were not archived, however old", async () => {
		const old = await session("not-archived", 90);
		await archive();
		const report = await sweepArchivedSessions({ log: () => {} });
		expect(report.deleted).toEqual([]);
		expect(await exists(old)).toBe(true);
	});

	it("skips sessions that are currently in use", async () => {
		const busy = await session("busy", 60);
		await archive(busy);
		const report = await sweepArchivedSessions({ isActive: (p) => p === busy, log: () => {} });
		expect(report.deleted).toEqual([]);
		expect(report.skippedActive).toEqual([busy]);
		expect(await exists(busy)).toBe(true);
		expect((await getWorkspaceRegistry()).archivedSessions).toEqual([busy]);
	});

	it("clears dangling archive entries whose file is already gone", async () => {
		const gone = path.join(agentDir, "sessions", "--ws--", "gone.jsonl");
		await archive(gone);
		const report = await sweepArchivedSessions({ log: () => {} });
		expect(report.missing).toEqual([gone]);
		expect((await getWorkspaceRegistry()).archivedSessions).toEqual([]);
	});

	it("dry run reports without deleting anything", async () => {
		const stale = await session("stale", 45);
		await archive(stale);
		const report = await sweepArchivedSessions({ dryRun: true, log: () => {} });
		expect(report.deleted).toHaveLength(1);
		expect(await exists(stale)).toBe(true);
		expect((await getWorkspaceRegistry()).archivedSessions).toEqual([stale]);
	});

	it("honours a custom retention window", async () => {
		const week = await session("week", 8);
		await archive(week);
		expect((await sweepArchivedSessions({ retentionDays: 30, log: () => {} })).deleted).toEqual([]);
		expect((await sweepArchivedSessions({ retentionDays: 7, log: () => {} })).deleted).toHaveLength(1);
	});
});
