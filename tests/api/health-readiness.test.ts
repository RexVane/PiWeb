/**
 * M4：liveness `/api/health` 响应保持原样；新增受认证保护的 `/api/health/readiness`。
 * 认证由 `src/proxy.ts` 只放行精确 `/api/health` 保证（这里直接调用 handler，测的是检查逻辑）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as liveness } from "../../src/app/api/health/route";
import { GET as readiness } from "../../src/app/api/health/readiness/route";
import { getAutomationSchedulerStatus, startAutomationScheduler } from "../../src/lib/automations/runner";
import { recycleTemporaryDirectory } from "../../src/lib/recycle-temporary";

const ENV_KEYS = ["PI_CODING_AGENT_DIR"] as const;
let previous: Record<string, string | undefined>;
let root: string;
let agentDir: string;

beforeEach(async () => {
	previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-readiness-"));
	agentDir = path.join(root, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
	await recycleTemporaryDirectory(root).catch(() => undefined);
});

describe("liveness stays unchanged", () => {
	it("keeps the exact static response and no-store header", async () => {
		const response = liveness();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ success: true, data: { ok: true, service: "piweb" } });
	});
});

describe("readiness", () => {
	it("reports the data directory, model configuration and scheduler state", async () => {
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "settings.json"), "{}");
		const response = await readiness();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await response.json() as { success: boolean; data: { ok: boolean; ready: boolean; checks: Record<string, { ok: boolean; detail?: string; running?: boolean }> } };
		expect(body.success).toBe(true);
		expect(body.data.ok).toBe(true);
		expect(body.data.ready).toBe(true);
		expect(body.data.checks.dataDir.ok).toBe(true);
		expect(body.data.checks.modelConfig.ok).toBe(true);
		// 调度器没启动只算 warning，不把实例判成未就绪（不影响网页核心功能）。
		expect(body.data.checks.scheduler.running).toBe(false);
		expect(body.data.checks.scheduler.ok).toBe(false);
	});

	it("reports a running automation scheduler", async () => {
		await fs.mkdir(agentDir, { recursive: true });
		const stop = startAutomationScheduler({ intervalMs: 60_000 });
		try {
			expect(getAutomationSchedulerStatus().running).toBe(true);
			const body = await (await readiness()).json() as { data: { checks: { scheduler: { ok: boolean; running?: boolean } } } };
			expect(body.data.checks.scheduler).toMatchObject({ ok: true, running: true });
		} finally {
			stop();
		}
	});

	it("returns 503 with a readable reason when settings.json is corrupt", async () => {
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "settings.json"), "{ this is not json");
		const response = await readiness();
		expect(response.status).toBe(503);
		const body = await response.json() as { success: boolean; error: string; data: { ready: boolean } };
		expect(body.success).toBe(false);
		expect(body.data.ready).toBe(false);
		expect(body.error).toContain("settings.json");
	});

	it("returns 503 with a readable reason when the data directory is not writable", async () => {
		// 把一个普通文件当成 agent 目录的父级：mkdir 会 ENOTDIR，真实写探针失败。
		const blocked = path.join(root, "blocked");
		await fs.writeFile(blocked, "not a directory");
		process.env.PI_CODING_AGENT_DIR = path.join(blocked, "agent");
		const response = await readiness();
		expect(response.status).toBe(503);
		const body = await response.json() as { success: boolean; error: string; data: { checks: { dataDir: { ok: boolean; detail?: string } } } };
		expect(body.success).toBe(false);
		expect(body.data.checks.dataDir.ok).toBe(false);
		expect(body.error).toContain("数据目录不可写");
	});
});
