/**
 * 没有 OS 沙箱后端的机器：受限档位的冷快照不能列出 bash（会话启动后热路径本来就会把它剔掉）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { recycleFixture } from "./lib/sandbox/fixtures";

vi.mock("../src/lib/growth-tracker", () => ({
	GROWTH_TRACKER_VERSION: 1,
	createGrowthTracker: () => ({ version: 1, prepare: async () => {}, onEvent: () => {}, getError: () => null, dispose: () => {} }),
}));
vi.mock("../src/lib/sandbox/manager", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/sandbox/manager")>()),
	sandboxSupported: () => false,
	probeSandboxSupport: async () => false,
}));

let root: string;
let cwd: string;
let manager: typeof import("../src/lib/agent-manager");

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-cold-tools-"));
	cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.resetModules();
	manager = await import("../src/lib/agent-manager");
}, 90_000);

afterAll(async () => {
	vi.unstubAllEnvs();
	await recycleFixture(root);
});

it.each(["readonly", "workspace"] as const)("omits bash from a cold %s snapshot when no sandbox backend exists", async (preset) => {
	const { sessionPath } = await manager.createNewSession(cwd);
	const m = manager.getManaged(sessionPath);
	try {
		expect(await manager.execute(m, { cmd: "setToolPreset", preset })).toMatchObject({ ok: true });
		const cold = await manager.buildSnapshot(m);
		expect(m.session).toBeNull();
		expect(cold.tools.active).toContain("read");
		expect(cold.tools.active).not.toContain("bash");
		expect(await manager.execute(m, { cmd: "setToolPreset", preset: "full" })).toMatchObject({ ok: true });
		expect((await manager.buildSnapshot(m)).tools.active).toContain("bash");
	} finally {
		await manager.disposeSession(m);
	}
}, 60_000);
