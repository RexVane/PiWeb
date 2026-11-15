/**
 * 归档会话长期保留：经过多久都可以读取、恢复；归档时长只用于显示。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSession, forgetSession, getWorkspaceRegistry } from "../src/lib/workspace-store";
import { recycleFixture } from "./lib/sandbox/fixtures";

const DAY = 24 * 60 * 60 * 1000;
let agentDir: string;
const keyOf = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);

beforeEach(async () => {
	agentDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-archive-preservation-")));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.spyOn(os, "homedir").mockReturnValue(path.join(agentDir, "unrelated-home"));
	await fs.mkdir(path.join(agentDir, "sessions", "--ws--"), { recursive: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await recycleFixture(agentDir);
});

async function session(name: string): Promise<string> {
	const file = path.join(agentDir, "sessions", "--ws--", `${name}.jsonl`);
	await fs.writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: "/ws" })}\n`);
	return file;
}

describe("archived session preservation", () => {
	it("keeps old archives and legacy records intact through repeated reads after a year", async () => {
		const old = await session("old");
		const legacy = await session("legacy");
		const archivedAt = Date.now() - 90 * DAY;
		for (const file of [old, legacy]) await fs.utimes(file, new Date(archivedAt), new Date(archivedAt));
		const registry = path.join(agentDir, "web-workspaces.json");
		const original = JSON.stringify({ workspaces: [], archivedSessions: [old, legacy], archivedAt: { [keyOf(old)]: archivedAt } });
		await fs.writeFile(registry, original);
		const content = await fs.readFile(old, "utf8");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 365 * DAY);
		for (let count = 0; count < 3; count++) {
			const snapshot = await getWorkspaceRegistry();
			expect(snapshot.archivedSessions).toEqual([old, legacy]);
			expect(snapshot.archivedAt).toEqual({ [keyOf(old)]: archivedAt });
		}
		expect(await fs.readFile(old, "utf8")).toBe(content);
		expect(await fs.readFile(legacy, "utf8")).toContain('"id":"legacy"');
		expect(await fs.readFile(registry, "utf8")).toBe(original);
		await forgetSession(old);
		expect((await getWorkspaceRegistry()).archivedSessions).toEqual([legacy]);
		expect(await fs.readFile(old, "utf8")).toBe(content);
	});

	it("resets the displayed archive age after restoration, rearchiving or a later file update", async () => {
		const file = await session("restored");
		const content = await fs.readFile(file, "utf8");
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + DAY);
		await archiveSession(file);
		const first = (await getWorkspaceRegistry()).archivedAt[keyOf(file)];
		await forgetSession(file);
		expect((await getWorkspaceRegistry()).archivedAt).toEqual({});
		clock.mockReturnValue(first + DAY);
		await archiveSession(file);
		expect((await getWorkspaceRegistry()).archivedAt[keyOf(file)]).toBe(first + DAY);
		const updatedAt = first + 2 * DAY;
		await fs.utimes(file, new Date(updatedAt), new Date(updatedAt));
		// Filesystem mtime can have sub-millisecond fractions (ext4); the registry stores the
		// sampled time in ms, so compare the rounded value instead of the raw float.
		expect(Math.round((await getWorkspaceRegistry()).archivedAt[keyOf(file)])).toBe(updatedAt);
		expect(await fs.readFile(file, "utf8")).toBe(content);
	});
});
