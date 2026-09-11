import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addWorkspace,
	archiveSession,
	forgetSession,
	getAliases,
	getArchivedSessions,
	getRemovedWorkspaces,
	listAdded,
	registerCwds,
	removeWorkspace,
	setAlias,
} from "../src/lib/workspace-store";

describe("PiWeb workspace registry", () => {
	let tempDir = "";
	let previousAgentDir: string | undefined;

	beforeEach(async () => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-workspaces-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
	});

	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("serializes independent registry mutations without losing fields", async () => {
		const first = path.join(tempDir, "first");
		const second = path.join(tempDir, "second");
		const archived = path.join(tempDir, "session.jsonl");

		await Promise.all([
			addWorkspace(first),
			addWorkspace(second),
			setAlias(first, "First workspace"),
			archiveSession(archived),
		]);

		const aliasKey = (dir: string) => (process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir));

		expect(await listAdded()).toEqual([path.resolve(first), path.resolve(second)]);
		expect(await getAliases()).toEqual({ [aliasKey(first)]: "First workspace" });
		expect(await getArchivedSessions()).toEqual([path.resolve(archived)]);
	});

	it("normalizes alias keys case-insensitively on Windows", async () => {
		const workspace = path.join(tempDir, "CaseDir");
		await addWorkspace(workspace);
		await setAlias(workspace, "Original");

		// 同一目录的另一种大小写应更新同一个别名，而不是产生第二个键
		await setAlias(path.join(tempDir, "casedir"), "Renamed");
		const aliases = await getAliases();
		expect(Object.keys(aliases)).toHaveLength(1);
		expect(Object.values(aliases)).toEqual(["Renamed"]);

		// 大小写不同的路径也能清除别名
		await setAlias(path.join(tempDir, "CASEDIR"), "");
		expect(await getAliases()).toEqual({});
	});

	it("removes only the workspace registration and keeps its sessions archived", async () => {
		const workspace = path.join(tempDir, "workspace");
		const archived = path.join(tempDir, "session.jsonl");
		await addWorkspace(workspace);
		await setAlias(workspace, "Temporary");
		await archiveSession(archived);

		await removeWorkspace(workspace);

		expect(await listAdded()).toEqual([]);
		expect(await getAliases()).toEqual({});
		expect(await getRemovedWorkspaces()).toEqual([path.resolve(workspace)]);
		expect(await getArchivedSessions()).toEqual([path.resolve(archived)]);
		expect(await registerCwds([workspace])).toEqual([]);

		await addWorkspace(workspace);
		expect(await listAdded()).toEqual([path.resolve(workspace)]);
		expect(await getRemovedWorkspaces()).toEqual([]);
	});

	it("forgets stale archive metadata after a session is permanently deleted", async () => {
		const archived = path.join(tempDir, "session.jsonl");
		await archiveSession(archived);
		expect(await forgetSession(archived)).toEqual([]);
		expect(await getArchivedSessions()).toEqual([]);
	});

	it("does not overwrite a malformed workspace registry", async () => {
		const registryPath = path.join(tempDir, "web-workspaces.json");
		await fs.writeFile(registryPath, "{malformed", "utf8");

		await expect(listAdded()).rejects.toThrow();
		expect(await fs.readFile(registryPath, "utf8")).toBe("{malformed");
	});
});
