import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	addWorkspace,
	archiveSession,
	forgetSession,
	getAliases,
	getArchivedSessions,
	getGrowthInitConsent,
	getRemovedWorkspaces,
	getWorkspaceRegistry,
	listAdded,
	registerCwds,
	removeWorkspace,
	setAlias,
	setGrowthInitConsent,
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
		const caseOnly = path.join(tempDir, process.platform === "win32" ? "casedir" : "CaseDir");
		await setAlias(caseOnly, "Renamed");
		const aliases = await getAliases();
		expect(Object.keys(aliases)).toHaveLength(1);
		expect(Object.values(aliases)).toEqual(["Renamed"]);

		// 大小写不同的路径也能清除别名
		await setAlias(path.join(tempDir, process.platform === "win32" ? "CASEDIR" : "CaseDir"), "");
		expect(await getAliases()).toEqual({});
	});

	it("treats a CLI symlink cwd and its real directory as one workspace through rename, removal and re-add", async () => {
		const real = path.join(tempDir, "real");
		const link = path.join(tempDir, "cli-link");
		const other = path.join(tempDir, "other");
		await fs.mkdir(real);
		await fs.mkdir(other);
		await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
		const canonical = await fs.realpath(real);
		const canonicalOther = await fs.realpath(other);
		const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;

		await addWorkspace(other);
		await addWorkspace(link);
		await setAlias(link, "CLI project");
		expect(await registerCwds([real, link])).toEqual([canonicalOther, canonical]);
		expect(await getAliases()).toEqual({ [key]: "CLI project" });
		await setAlias(real, "Renamed project");
		expect(await getAliases()).toEqual({ [key]: "Renamed project" });
		await setGrowthInitConsent(link, false);
		expect(await getGrowthInitConsent(real)).toBe(false);

		await removeWorkspace(link);
		expect(await registerCwds([real, link])).toEqual([canonicalOther]);
		expect(await getRemovedWorkspaces()).toEqual([canonical]);
		expect(await getAliases()).toEqual({});
		await addWorkspace(real);
		expect(await listAdded()).toEqual([canonicalOther, canonical]);
		expect(await getRemovedWorkspaces()).toEqual([]);
	});

	it("reads a legacy symlink registry without duplicates or losing its alias and first-seen order", async () => {
		const real = path.join(tempDir, "real");
		const link = path.join(tempDir, "cli-link");
		const first = path.join(tempDir, "first");
		const last = path.join(tempDir, "last");
		await fs.mkdir(real);
		await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
		const canonical = await fs.realpath(real);
		const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
		const target = path.join(tempDir, "web-workspaces.json");
		const original = JSON.stringify({ workspaces: [first, link, real, last], aliases: { [link]: "Legacy name" } });
		await fs.writeFile(target, original);
		expect(await getWorkspaceRegistry()).toMatchObject({
			workspaces: [first, canonical, last], aliases: { [key]: "Legacy name" },
		});
		expect(await registerCwds([real, link])).toEqual([first, canonical, last]);
		// Polling only normalizes the returned snapshot; migration must not rewrite user data.
		expect(await fs.readFile(target, "utf8")).toBe(original);
		await setAlias(real, "Updated name");
		expect(await getAliases()).toEqual({ [key]: "Updated name" });
		expect(await listAdded()).toEqual([first, canonical, last]);
	});

	it("honors a legacy symlink removal marker until the workspace is explicitly re-added", async () => {
		const real = path.join(tempDir, "real");
		const link = path.join(tempDir, "cli-link");
		await fs.mkdir(real);
		await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
		const canonical = await fs.realpath(real);
		const target = path.join(tempDir, "web-workspaces.json");
		const original = JSON.stringify({ workspaces: [], removedWorkspaces: [link] });
		await fs.writeFile(target, original);
		expect(await registerCwds([real, link])).toEqual([]);
		expect(await getRemovedWorkspaces()).toEqual([canonical]);
		expect(await fs.readFile(target, "utf8")).toBe(original);
		expect(await addWorkspace(link)).toEqual({ workspaces: [canonical], removedWorkspaces: [] });
	});

	it("serves repeated polls from the in-memory snapshot without rewriting or taking the lock", async () => {
		const workspace = path.join(tempDir, "polled");
		await addWorkspace(workspace);
		const target = path.join(tempDir, "web-workspaces.json");
		const before = await fs.stat(target);
		for (let i = 0; i < 3; i += 1) {
			expect(await registerCwds([workspace])).toContain(path.resolve(workspace));
		}
		const after = await fs.stat(target);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(after.ctimeMs).toBe(before.ctimeMs);
		// 读路径不再创建锁目录：只读家目录 / 杀软 / 残留锁都不该让会话列表 500
		expect((await fs.readdir(tempDir)).filter((name) => name.endsWith(".lock"))).toEqual([]);
		expect(await listAdded()).toContain(path.resolve(workspace));

		// 真有新 cwd 时仍然走原来的加锁写入
		const fresh = path.join(tempDir, "fresh");
		expect(await registerCwds([fresh])).toContain(path.resolve(fresh));
		expect(await listAdded()).toEqual([path.resolve(workspace), path.resolve(fresh)]);
	});

	it("picks up an external rewrite instead of serving a stale snapshot", async () => {
		await addWorkspace(path.join(tempDir, "one"));
		expect(await listAdded()).toHaveLength(1);
		// 模拟另一个进程（或终端 pi）改写注册表：内容变化必须立刻可见
		await fs.writeFile(path.join(tempDir, "web-workspaces.json"), JSON.stringify({
			workspaces: [path.resolve(tempDir, "two"), path.resolve(tempDir, "three")],
		}));
		expect(await listAdded()).toEqual([path.resolve(tempDir, "two"), path.resolve(tempDir, "three")]);
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

	it("records when a session was archived and drops it on unarchive", async () => {
		const archived = path.join(tempDir, "Session.jsonl");
		const key = process.platform === "win32" ? path.resolve(archived).toLowerCase() : path.resolve(archived);
		const registryPath = path.join(tempDir, "web-workspaces.json");
		const stored = async () => JSON.parse(await fs.readFile(registryPath, "utf8")).archivedAt ?? {};
		const before = Date.now();
		await archiveSession(archived);
		const first = (await stored())[key];
		expect(first).toBeGreaterThanOrEqual(before);
		// 重复归档不改时间：保留期不会因为多点一次而重新起算
		await archiveSession(archived);
		expect((await stored())[key]).toBe(first);
		await forgetSession(archived);
		expect(await stored()).toEqual({});
	});

	it("keeps the previous registry intact when atomic replacement fails", async () => {
		const first = path.join(tempDir, "first");
		await addWorkspace(first);
		const registryPath = path.join(tempDir, "web-workspaces.json");
		const original = await fs.readFile(registryPath, "utf8");
		const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("replacement denied"), { code: "EACCES" }));
		try {
			await expect(addWorkspace(path.join(tempDir, "second"))).rejects.toThrow("replacement denied");
		} finally {
			rename.mockRestore();
		}
		expect(await fs.readFile(registryPath, "utf8")).toBe(original);
		expect((await fs.readdir(tempDir)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
	});

	it("reads the latest registry after another process releases its lock", async () => {
		const registryPath = path.join(tempDir, "web-workspaces.json");
		await fs.writeFile(registryPath, JSON.stringify({ workspaces: [], aliases: {} }));
		const external = path.join(tempDir, "external");
		const local = path.join(tempDir, "local");
		const script = `import fs from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const lockfile = require("proper-lockfile");
const file = process.argv[1];
const release = await lockfile.lock(file, { realpath: false });
process.once("message", async () => {
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  data.workspaces.push(process.argv[2]);
  await fs.writeFile(file, JSON.stringify(data));
  await release();
  process.disconnect();
});
process.send("locked");`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script, registryPath, external], {
			cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
		});
		const exited = once(child, "exit");
		let pending: Promise<unknown> | undefined;
		try {
			await once(child, "message");
			let completed = false;
			pending = addWorkspace(local).finally(() => { completed = true; });
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(completed).toBe(false);
			child.send("release");
			await pending;
			expect((await exited)[0]).toBe(0);
			expect(await listAdded()).toEqual([external, local]);
		} finally {
			if (child.exitCode === null) child.kill();
			await exited;
			await pending?.catch(() => undefined);
		}
	}, 15_000);

	it("does not overwrite a malformed workspace registry", async () => {
		const registryPath = path.join(tempDir, "web-workspaces.json");
		await fs.writeFile(registryPath, "{malformed", "utf8");

		await expect(listAdded()).rejects.toThrow();
		await expect(addWorkspace(path.join(tempDir, "new-workspace"))).rejects.toThrow();
		expect(await fs.readFile(registryPath, "utf8")).toBe("{malformed");
	});
});
