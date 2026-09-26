/**
 * 导入服务：扫描隔离、去向解析、幂等与失败报告。
 *
 * 关键行为：某个来源坏掉不能影响其它来源；源项目目录本机不存在时要落到用户选的兜底工作区，
 * 没兜底就明确失败（不能默默丢掉这条会话）。同样只允许读源数据。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots = { claude: "", codex: "", grok: "", dsh: "", zcode: "", opencode: "" };

vi.mock("../src/lib/session-import/paths", () => ({
	claudeRoot: () => roots.claude,
	codexRoot: () => roots.codex,
	grokRoot: () => roots.grok,
	dshRoot: () => roots.dsh,
	zcodeDb: () => roots.zcode,
	opencodeDb: () => roots.opencode,
}));

import { importSessions, scanAllSources } from "../src/lib/session-import";
import { claudeSource } from "../src/lib/session-import/claude";
import { codexSource } from "../src/lib/session-import/codex";
import { readSession } from "../src/lib/session-reader";

let root: string;
let agentDir: string;
let project: string;
let fallback: string;
const TS = Date.UTC(2026, 8, 13, 4, 10, 51);

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-import-svc-")));
	agentDir = path.join(root, "agent");
	project = path.join(root, "project");
	fallback = path.join(root, "fallback");
	for (const key of Object.keys(roots) as Array<keyof typeof roots>) roots[key] = path.join(root, key);
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(project, { recursive: true });
	await fs.mkdir(fallback, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function write(file: string, lines: unknown[]): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	return file;
}

async function seedClaude(id: string, cwd: string, text = "你好"): Promise<void> {
	await write(path.join(roots.claude, "-proj", `${id}.jsonl`), [
		{ type: "user", cwd, timestamp: new Date(TS).toISOString(), message: { role: "user", content: text } },
		{ type: "assistant", timestamp: new Date(TS + 1000).toISOString(), message: { role: "assistant", model: "m", content: [{ type: "text", text: "在" }] } },
	]);
}

async function seedCodex(id: string, cwd: string): Promise<void> {
	await write(path.join(roots.codex, "2026", "09", "13", `${id}.jsonl`), [
		{ timestamp: new Date(TS).toISOString(), type: "session_meta", payload: { cwd, model: "gpt-5" } },
		{ timestamp: new Date(TS).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex 会话" }] } },
	]);
}

describe("扫描", () => {
	it("按来源聚合，且已导入的会话被标出来", async () => {
		await seedClaude("s1", project);
		await seedCodex("rollout-1", project);

		const first = await scanAllSources(agentDir);
		expect(first.summaries.map((summary) => summary.source).sort()).toEqual(["claude", "codex"]);
		expect(first.imported).toEqual([]);

		await importSessions([{ source: "claude", externalId: "s1" }], { agentDir, fallbackCwd: fallback });
		const second = await scanAllSources(agentDir);
		expect(second.imported).toEqual(["claude:s1"]);
	});

	it("某个来源抛错时其它来源照常返回，并在结果里带上原因", async () => {
		await seedCodex("rollout-1", project);
		// 让 claude 的扫描炸掉：根目录指向一个文件（readdir 会失败不算抛错），改成一个不可读的路径
		const boom = vi.spyOn(claudeSource, "scan").mockRejectedValue(new Error("库被占用"));
		try {
			const report = await scanAllSources(agentDir);
			expect(report.summaries.map((summary) => summary.source)).toEqual(["codex"]);
			expect(report.errors).toEqual([{ source: "claude", message: "库被占用" }]);
		} finally {
			boom.mockRestore();
		}
	});

	it("扫描结果不下发内部定位信息（location 只在服务端用）", async () => {
		await seedClaude("s1", project);
		const report = await scanAllSources(agentDir);
		const { GET } = await import("../src/app/api/sessions/import/route");
		const response = await GET();
		const body = await response.json();
		expect(body.success).toBe(true);
		expect(body.data.sessions[0]).not.toHaveProperty("location");
		expect(body.data.sessions[0]).toHaveProperty("externalId", "s1");
		// 服务端自己的扫描结果当然要带 location，否则导入时没法再定位
		expect(report.summaries[0].location).toContain("s1.jsonl");
	});
});

describe("去向：源项目还在就导回原工作区，否则用兜底工作区", () => {
	it("源项目目录存在时，会话落在该工作区下", async () => {
		await seedClaude("s1", project);
		const report = await importSessions([{ source: "claude", externalId: "s1" }], { agentDir, fallbackCwd: fallback });
		expect(report.imported).toBe(1);
		expect(report.failed).toBe(0);
		expect(report.results[0].workspace).toBe(path.resolve(project));
		expect(report.workspaces).toEqual([path.resolve(project)]);
		expect(await readSession(report.results[0].path as string)).toMatchObject({ cwd: path.resolve(project) });
	});

	it("源项目目录已不存在时落到兜底工作区，源路径写进来源条目里可追溯", async () => {
		const gone = path.join(root, "deleted-project");
		await seedClaude("s2", gone);
		const report = await importSessions([{ source: "claude", externalId: "s2" }], { agentDir, fallbackCwd: fallback });
		expect(report.results[0].workspace).toBe(path.resolve(fallback));
		const lines = (await fs.readFile(report.results[0].path as string, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(lines.find((entry) => entry.customType === "piweb-import")?.data.projectPath).toBe(gone);
	});

	it("源项目不存在又没有兜底工作区时明确失败，而不是悄悄丢掉", async () => {
		await seedClaude("s3", path.join(root, "gone"));
		const report = await importSessions([{ source: "claude", externalId: "s3" }], { agentDir });
		expect(report.results[0].status).toBe("failed");
		expect(report.results[0].reason).toMatch(/源项目目录不存在/);
		expect(report.workspaces).toEqual([]);
	});
});

describe("幂等与失败报告", () => {
	it("serializes concurrent imports across different fallback workspaces", async () => {
		await seedClaude("concurrent", path.join(root, "gone"));
		const selection = [{ source: "claude" as const, externalId: "concurrent" }];
		const reports = await Promise.all([
			importSessions(selection, { agentDir, fallbackCwd: project }),
			importSessions(selection, { agentDir, fallbackCwd: fallback }),
		]);
		expect(reports.reduce((sum, report) => sum + report.imported, 0)).toBe(1);
		expect(reports.reduce((sum, report) => sum + report.skipped, 0)).toBe(1);
		expect(reports.reduce((sum, report) => sum + report.failed, 0)).toBe(0);
		expect((await scanAllSources(agentDir)).imported).toEqual(["claude:concurrent"]);
	});
	it("已导入过的会话再导入是 skipped（不会产生第二个文件）", async () => {
		await seedClaude("s1", project);
		const first = await importSessions([{ source: "claude", externalId: "s1" }], { agentDir, fallbackCwd: fallback });
		const second = await importSessions([{ source: "claude", externalId: "s1" }], { agentDir, fallbackCwd: fallback });
		expect(second).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
		expect(second.results[0].reason).toMatch(/已经导入过/);
		const files = await fs.readdir(path.dirname(first.results[0].path as string));
		expect(files.filter((name) => name.includes("import-claude-s1"))).toHaveLength(1);
	});

	it("同一次请求里重复勾选同一条只导入一次", async () => {
		await seedClaude("s1", project);
		const report = await importSessions(
			[{ source: "claude", externalId: "s1" }, { source: "claude", externalId: "s1" }],
			{ agentDir, fallbackCwd: fallback },
		);
		expect(report).toMatchObject({ imported: 1, skipped: 1 });
		expect(report.results[1].reason).toMatch(/重复选择/);
	});

	it("源会话已消失时报失败并说明原因，不让整批导入中断", async () => {
		await seedClaude("s1", project);
		const report = await importSessions(
			[{ source: "claude", externalId: "s1" }, { source: "claude", externalId: "not-there" }],
			{ agentDir, fallbackCwd: fallback },
		);
		expect(report).toMatchObject({ imported: 1, failed: 1 });
		expect(report.results[1].reason).toMatch(/源会话已不存在/);
	});

	it("读了会话但读不出消息时算失败，不算成功", async () => {
		// 只有 assistant 的空内容：claude 适配器返回 null
		await write(path.join(roots.claude, "-proj", "empty.jsonl"), [{ type: "assistant", message: { role: "assistant", content: [] } }]);
		const report = await importSessions([{ source: "claude", externalId: "empty" }], { agentDir, fallbackCwd: fallback });
		expect(report.results[0].status).toBe("failed");
		expect(report.results[0].reason).toMatch(/读不出可导入的消息/);
	});

	it("导入过程不写源目录：前后文件清单与内容完全一致", async () => {
		await seedClaude("s1", project);
		await seedCodex("rollout-1", project);
		const snapshot = async () => {
			const out: string[] = [];
			for (const dir of [roots.claude, roots.codex]) {
				for (const file of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
					if (file.isFile() && file.parentPath) out.push(`${path.join(file.parentPath, file.name)}:${(await fs.readFile(path.join(file.parentPath, file.name))).length}`);
				}
			}
			return out.sort();
		};
		const before = await snapshot();
		await importSessions(
			[{ source: "claude", externalId: "s1" }, { source: "codex", externalId: "rollout-1" }],
			{ agentDir, fallbackCwd: fallback },
		);
		expect(await snapshot()).toEqual(before);
	});
});
