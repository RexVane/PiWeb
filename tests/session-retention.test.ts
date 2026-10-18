/**
 * 归档会话保留期：从归档起算满 30 天就自动删除（归档后又用过的从最后一次活动起算）。
 * 只动「在归档列表里」的会话；没归档的、正在使用的都不碰。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepArchivedSessions } from "../src/lib/session-retention";
import { archiveSession, getWorkspaceRegistry } from "../src/lib/workspace-store";

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

const registryPath = () => path.join(agentDir, "web-workspaces.json");
const keyOf = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file));

/** 写归档列表；archivedDaysAgo 给出各会话的归档时间（不给就是这个字段出现之前的旧注册表） */
async function archive(paths: string[], archivedDaysAgo?: Record<string, number>) {
	const archivedAt = archivedDaysAgo
		? Object.fromEntries(Object.entries(archivedDaysAgo).map(([file, days]) => [keyOf(file), Date.now() - days * DAY]))
		: undefined;
	await fs.writeFile(registryPath(), JSON.stringify({ schema: 1, workspaces: [], aliases: {}, archivedSessions: paths, archivedAt, removedWorkspaces: [] }), "utf8");
}

const storedArchivedAt = async (): Promise<Record<string, number>> => JSON.parse(await fs.readFile(registryPath(), "utf8")).archivedAt ?? {};

const exists = async (file: string) => !!(await fs.stat(file).catch(() => null));

describe("archived session retention", () => {
	it("deletes sessions archived past the retention window and keeps recently archived ones", async () => {
		const stale = await session("stale", 40);
		const fresh = await session("fresh", 40);
		await archive([stale, fresh], { [stale]: 40, [fresh]: 2 });

		const report = await sweepArchivedSessions({ log: () => {} });

		expect(report.deleted.map((entry) => path.basename(entry.path))).toEqual(["stale.jsonl"]);
		expect(report.deleted[0].idleDays).toBeGreaterThanOrEqual(39);
		expect(await exists(stale)).toBe(false);
		expect(await exists(fresh)).toBe(true);
		const registry = await getWorkspaceRegistry();
		expect(registry.archivedSessions).toEqual([fresh]);
		expect(Object.keys(await storedArchivedAt())).toEqual([keyOf(fresh)]);
	});

	it("starts the clock at archive time, not at the session's last activity", async () => {
		// 回归：以前只看 mtime，把一个 90 天没动的旧会话刚归档，下一轮清理就把它删了
		const old = await session("old", 90);
		await archiveSession(old);

		const report = await sweepArchivedSessions({ log: () => {} });

		expect(report.deleted).toEqual([]);
		expect(await exists(old)).toBe(true);
		expect((await getWorkspaceRegistry()).archivedSessions).toEqual([old]);
	});

	it("treats entries archived before timestamps existed as archived now and records that", async () => {
		const legacy = await session("legacy", 60);
		await archive([legacy]);
		const before = Date.now();

		const report = await sweepArchivedSessions({ log: () => {} });

		expect(report.deleted).toEqual([]);
		expect(await exists(legacy)).toBe(true);
		expect((await storedArchivedAt())[keyOf(legacy)]).toBeGreaterThanOrEqual(before);
	});

	it("restarts the window when an archived session is used again", async () => {
		const reused = await session("reused", 3);
		await archive([reused], { [reused]: 45 });
		const report = await sweepArchivedSessions({ log: () => {} });
		expect(report.deleted).toEqual([]);
		expect(await exists(reused)).toBe(true);
	});

	it("never touches sessions that were not archived, however old", async () => {
		const old = await session("not-archived", 90);
		await archive([]);
		const report = await sweepArchivedSessions({ log: () => {} });
		expect(report.deleted).toEqual([]);
		expect(await exists(old)).toBe(true);
	});

	it("skips sessions that are currently in use", async () => {
		const busy = await session("busy", 60);
		await archive([busy], { [busy]: 60 });
		const report = await sweepArchivedSessions({ isActive: (p) => p === busy, log: () => {} });
		expect(report.deleted).toEqual([]);
		expect(report.skippedActive).toEqual([busy]);
		expect(await exists(busy)).toBe(true);
		expect((await getWorkspaceRegistry()).archivedSessions).toEqual([busy]);
	});

	it("clears dangling archive entries whose file is already gone", async () => {
		const gone = path.join(agentDir, "sessions", "--ws--", "gone.jsonl");
		await archive([gone], { [gone]: 1 });
		const report = await sweepArchivedSessions({ log: () => {} });
		expect(report.missing).toEqual([gone]);
		expect((await getWorkspaceRegistry()).archivedSessions).toEqual([]);
		expect(await storedArchivedAt()).toEqual({});
	});

	it("dry run reports without deleting or recording anything", async () => {
		const stale = await session("stale", 45);
		const legacy = await session("legacy", 45);
		await archive([stale, legacy], { [stale]: 45 });
		const before = await fs.readFile(registryPath(), "utf8");
		const report = await sweepArchivedSessions({ dryRun: true, log: () => {} });
		expect(report.deleted.map((entry) => path.basename(entry.path))).toEqual(["stale.jsonl"]);
		expect(await exists(stale)).toBe(true);
		expect(await fs.readFile(registryPath(), "utf8")).toBe(before);
	});

	it("honours a custom retention window", async () => {
		const week = await session("week", 8);
		await archive([week], { [week]: 8 });
		expect((await sweepArchivedSessions({ retentionDays: 30, log: () => {} })).deleted).toEqual([]);
		expect((await sweepArchivedSessions({ retentionDays: 7, log: () => {} })).deleted).toHaveLength(1);
	});
});
