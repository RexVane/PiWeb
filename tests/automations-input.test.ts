import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManageAutomationTool } from "../src/lib/automations/agent-tool";

vi.mock("../src/lib/automations/runner", async (original) => {
	const real = await original<typeof import("../src/lib/automations/runner")>();
	return { ...real, ensureAutomationSchedulerStarted: () => {} };
});
import { POST } from "../src/app/api/automations/route";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-automation-input-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await fs.rm(root, { recursive: true, force: true });
});

describe("automation API and tool validation", () => {
	it.each([null, [], { action: "create", name: 5, prompt: "Check", schedule: { kind: "daily", time: "09:00" } }])("rejects malformed API request %j with HTTP 400", async (body) => {
		const response = await POST(new Request("http://localhost/api/automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
		expect(response.status).toBe(400);
	});

	it("uses the same strict schedule validator in the chat tool and supports each result shape", async () => {
		const onMutated = vi.fn();
		const tool = createManageAutomationTool({ defaultCwd: root, storePath: path.join(root, "tasks.json"), onMutated });
		const call = (params: Parameters<typeof tool.execute>[1]) => tool.execute("test", params, undefined, undefined, {} as never);
		await expect(call({ action: "create", name: "No unit", prompt: "Check", schedule: { kind: "interval", every: 1 } })).rejects.toThrow("unit");
		const created = await call({ action: "create", name: "Valid", prompt: "Check", schedule: { kind: "daily", time: "09:00" } });
		// The store canonicalizes the workspace (realpath), so compare the canonical spelling:
		// Windows temp dirs can be addressed through an 8.3 short name.
		expect(created.details).toMatchObject({ action: "create", task: { cwd: await fs.realpath(root) } });
		const id = (created.details as { task: { id: string } }).task.id;
		expect((await call({ action: "list" })).details).toMatchObject({ action: "list", count: 1 });
		expect((await call({ action: "update", id, enabled: false })).details).toMatchObject({ action: "update", task: { enabled: false } });
		expect((await call({ action: "delete", id })).details).toMatchObject({ action: "delete", deleted: true });
		expect(onMutated).toHaveBeenCalledTimes(3);
	});
});
