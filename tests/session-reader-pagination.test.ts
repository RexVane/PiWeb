import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D4：listSessions 可选分页（不传参数 = 原全量行为，不设默认上限）。
 * K3：会话扫描只把 ENOENT 当“没有会话”，其它 readdir 错误要记录并向上抛。
 */
let tempDir = "";
let agentDir = "";
let previousAgentDir: string | undefined;

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;

/** 在 agent 目录里放一个会话；minute 决定 modified 顺序（越大越新） */
async function putSession(name: string, minute: number, text = `session ${name}`): Promise<string> {
	const dir = path.join(agentDir, "sessions", "workspace");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, name);
	const at = new Date(Date.UTC(2026, 0, 1, 0, minute, 0)).toISOString();
	await fs.writeFile(file, [
		line({ type: "session", version: 3, id: `s-${name}`, timestamp: at, cwd: "D:\\Proj" }),
		line({ type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: text, timestamp: Date.parse(at) } }),
	].join(""));
	return file;
}

beforeEach(async () => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-session-pagination-")));
	agentDir = path.join(tempDir, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	vi.resetModules();
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("listSessions pagination (D4)", () => {
	it("returns the full sorted list when no options are given (no default cap)", async () => {
		for (let minute = 1; minute <= 6; minute += 1) await putSession(`s${minute}.jsonl`, minute);
		const { listSessions } = await import("../src/lib/session-reader");
		const all = await listSessions();
		// 默认行为：全量，且按 modified 倒序
		expect(all).toHaveLength(6);
		expect(all.map((session) => path.basename(session.path))).toEqual(["s6.jsonl", "s5.jsonl", "s4.jsonl", "s3.jsonl", "s2.jsonl", "s1.jsonl"]);
		expect(await listSessions(undefined, {})).toEqual(all);
	});

	it("returns only the requested window and never mutates the default list", async () => {
		for (let minute = 1; minute <= 6; minute += 1) await putSession(`s${minute}.jsonl`, minute);
		const { listSessions } = await import("../src/lib/session-reader");
		const all = await listSessions();
		const first = await listSessions(undefined, { limit: 2 });
		const second = await listSessions(undefined, { limit: 2, offset: 2 });
		const third = await listSessions(undefined, { offset: 4, limit: 2 });
		expect(first.map((session) => path.basename(session.path))).toEqual(["s6.jsonl", "s5.jsonl"]);
		expect(second.map((session) => path.basename(session.path))).toEqual(["s4.jsonl", "s3.jsonl"]);
		expect(third.map((session) => path.basename(session.path))).toEqual(["s2.jsonl", "s1.jsonl"]);
		// 拼起来的页 == 全量，且全量本身没被裁掉
		expect([...first, ...second, ...third]).toEqual(all);
		expect(await listSessions(undefined, { offset: 100, limit: 2 })).toEqual([]);
		expect(await listSessions(undefined, { limit: 0 })).toEqual([]);
	});

	it("applies pagination after search filtering", async () => {
		await putSession("a.jsonl", 1, "alpha report");
		await putSession("b.jsonl", 2, "beta report");
		await putSession("c.jsonl", 3, "gamma notes");
		await putSession("d.jsonl", 4, "delta report");
		const { listSessions } = await import("../src/lib/session-reader");
		const hits = await listSessions("report", { limit: 2 });
		expect(hits.map((session) => path.basename(session.path))).toEqual(["d.jsonl", "b.jsonl"]);
		expect((await listSessions("report", { limit: 2, offset: 2 })).map((session) => path.basename(session.path))).toEqual(["a.jsonl"]);
	});

	it("breaks modified-time ties by path so paging is stable", async () => {
		await putSession("z.jsonl", 3);
		await putSession("a.jsonl", 3);
		await putSession("m.jsonl", 1);
		const { listSessions } = await import("../src/lib/session-reader");
		const all = await listSessions();
		expect(all.map((session) => path.basename(session.path))).toEqual(["a.jsonl", "z.jsonl", "m.jsonl"]);
		expect(await listSessions(undefined, { limit: 1, offset: 1 })).toEqual([all[1]]);
		expect(await listSessions(undefined, { limit: 1, offset: 1 })).toEqual([all[1]]);
	});

	it("falls back to the full list for invalid pagination values instead of failing", async () => {
		for (let minute = 1; minute <= 3; minute += 1) await putSession(`s${minute}.jsonl`, minute);
		const { listSessions } = await import("../src/lib/session-reader");
		const all = await listSessions();
		for (const options of [{ limit: Number.NaN }, { limit: -1 }, { limit: 1.5 }, { limit: 2, offset: -3 }, { limit: 2, offset: Number.NaN }]) {
			expect(await listSessions(undefined, options)).toEqual(all);
		}
	});
});

describe("session scan failure handling (K3)", () => {
	it("treats a missing session store as an empty list", async () => {
		const { listSessions } = await import("../src/lib/session-reader");
		await fs.mkdir(agentDir, { recursive: true });
		expect(await listSessions()).toEqual([]);
	});

	it("reports and rethrows a non-ENOENT readdir failure instead of pretending there are no sessions", async () => {
		await putSession("a.jsonl", 1);
		const { listSessions } = await import("../src/lib/session-reader");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(fs, "readdir").mockImplementation((async () => {
			throw Object.assign(new Error("EACCES: permission denied, scandir 'sessions'"), { code: "EACCES" });
		}) as unknown as typeof fs.readdir);
		await expect(listSessions()).rejects.toThrow("EACCES");
		expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("读取会话目录失败");
	});

	it("skips a session subdirectory that vanished between listing and reading", async () => {
		await putSession("kept.jsonl", 1);
		const vanished = path.join(agentDir, "sessions", "vanished");
		await fs.mkdir(vanished, { recursive: true });
		await fs.writeFile(path.join(vanished, "gone.jsonl"), line({ type: "session", cwd: "D:\\Proj" }));
		const realReaddir = fs.readdir.bind(fs) as typeof fs.readdir;
		vi.spyOn(fs, "readdir").mockImplementation((async (target: Parameters<typeof fs.readdir>[0], options?: Parameters<typeof fs.readdir>[1]) => {
			if (String(target).includes("vanished")) throw Object.assign(new Error("ENOENT: no such directory"), { code: "ENOENT" });
			return options === undefined ? realReaddir(target) : realReaddir(target, options);
		}) as typeof fs.readdir);
		const { listSessions } = await import("../src/lib/session-reader");
		const list = await listSessions();
		expect(list.map((session) => path.basename(session.path))).toEqual(["kept.jsonl"]);
	});
});
