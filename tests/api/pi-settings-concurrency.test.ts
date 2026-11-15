/**
 * J6：10 并发 PUT /api/pi-settings 曾返回大量 500 EACCES。
 * 修复后：Windows 锁冲突在锁内退避重试，最终失败映射 409 + Retry-After；不允许 5xx。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ apply: vi.fn(), applyProxy: vi.fn(), root: { value: "" } }));
vi.mock("@/lib/agent-manager", () => ({ applySettingsToSessions: deps.apply }));
vi.mock("@/lib/runtime-proxy", () => ({ applyRuntimeProxy: deps.applyProxy }));
// 只隔离 pi 的目录与重载：settings.json 的真实读写仍然走 pi-settings + jsonc 存储
vi.mock("@/lib/pi", () => ({
	getAgentDir: () => deps.root.value,
	reloadSettingsManagers: async () => {},
	resolveProjectTrust: () => ({ trusted: true }),
}));

import { PUT } from "@/app/api/pi-settings/route";

const roots: string[] = [];

beforeEach(async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-settings-concurrency-"));
	roots.push(root);
	deps.root.value = root;
	await fs.writeFile(path.join(root, "settings.json"), "{}\n");
	deps.apply.mockReset();
	deps.applyProxy.mockReset();
	deps.applyProxy.mockReturnValue({ proxy: null, source: "none", supported: true, activeInProcess: true });
});

afterEach(async () => {
	deps.root.value = "";
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function put(index: number): Promise<Response> {
	return PUT(new Request("http://local/api/pi-settings", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ steeringMode: index % 2 === 0 ? "all" : "one-at-a-time" }),
	}));
}

it("keeps 10 concurrent settings writes out of the 5xx class and leaves valid JSON", async () => {
	const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => put(index)));
	const statuses = responses.map((response) => response.status);
	expect(statuses.every((status) => status < 500), JSON.stringify(statuses)).toBe(true);
	expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
	// 锁冲突必须是可重试的 409，并带 Retry-After
	for (const response of responses.filter((item) => item.status === 409)) {
		expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
		const body = await response.json();
		expect(body).toMatchObject({ success: false, errorCode: "SETTINGS_BUSY" });
	}
	const stored = JSON.parse(await fs.readFile(path.join(deps.root.value, "settings.json"), "utf8")) as { steeringMode?: string };
	expect(["all", "one-at-a-time"]).toContain(stored.steeringMode);
}, 60_000);
