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

		expect(await listAdded()).toEqual([path.resolve(first), path.resolve(second)]);
		expect(await getAliases()).toEqual({ [path.resolve(first)]: "First workspace" });
		expect(await getArchivedSessions()).toEqual([path.resolve(archived)]);
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
});
