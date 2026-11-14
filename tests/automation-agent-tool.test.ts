import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManageAutomationTool, MANAGE_AUTOMATION_TOOL } from "@/lib/automations/agent-tool";
import { listAutomations } from "@/lib/automations/store";

const tempDirs: string[] = [];

async function makeFixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-auto-tool-"));
	tempDirs.push(dir);
	const workspaceDir = path.join(dir, "workspace");
	await fs.mkdir(workspaceDir, { recursive: true });
	return { storePath: path.join(dir, "web-automations.json"), workspaceDir };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("manage_automation tool", () => {
	it("lists, creates, updates, and deletes scheduled automations", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const onMutated = vi.fn();
		const tool = createManageAutomationTool({ defaultCwd: workspaceDir, storePath, onMutated });

		expect(tool.name).toBe(MANAGE_AUTOMATION_TOOL);

		const initial = await tool.execute("c1", { action: "list" }, undefined, undefined, undefined as never);
		expect(initial.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("No automation tasks configured.") });

		const created = await tool.execute(
			"c2",
			{
				action: "create",
				name: "Daily Status Digest",
				prompt: "Check git status and test summary",
				schedule: { kind: "daily", time: "09:30" },
				toolPreset: "readonly",
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(created.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Daily Status Digest") });
		expect(onMutated).toHaveBeenCalledTimes(1);

		const snap = await listAutomations(storePath);
		expect(snap.tasks).toHaveLength(1);
		const taskId = snap.tasks[0].id;
		expect(snap.tasks[0].cwd).toBe(await fs.realpath(workspaceDir).catch(() => workspaceDir));

		const updated = await tool.execute(
			"c3",
			{ action: "update", id: taskId, enabled: false },
			undefined,
			undefined,
			undefined as never,
		);
		expect(updated.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("enabled=false") });
		expect(onMutated).toHaveBeenCalledTimes(2);

		await tool.execute("c4", { action: "delete", id: taskId }, undefined, undefined, undefined as never);
		expect((await listAutomations(storePath)).tasks).toHaveLength(0);
		expect(onMutated).toHaveBeenCalledTimes(3);
	});

	it("validates required create fields clearly", async () => {
		const { storePath, workspaceDir } = await makeFixture();
		const tool = createManageAutomationTool({ defaultCwd: workspaceDir, storePath });

		await expect(
			tool.execute("bad1", { action: "create", name: "No prompt", schedule: { kind: "daily", time: "08:00" } }, undefined, undefined, undefined as never),
		).rejects.toThrow("prompt");

		await expect(
			tool.execute("bad2", { action: "delete" }, undefined, undefined, undefined as never),
		).rejects.toThrow("id");
	});
});
