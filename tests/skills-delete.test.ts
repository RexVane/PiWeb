import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recycleGeneratedFixture } from "./fixtures/system-trash";

const state = vi.hoisted(() => ({
	agentDir: "", skills: [] as Array<{ name: string; filePath: string; baseDir: string }>,
	trash: vi.fn(async (_removed: string, _options: unknown) => ({ removed: _removed })),
	reload: vi.fn(async () => []), sessions: vi.fn(async () => 0),
}));
vi.mock("@/lib/pi", () => ({
	getAgentDir: () => state.agentDir,
	getResourceLoader: () => ({ getSkills: () => ({ skills: state.skills }) }),
	reloadAllLoaders: state.reload, resourceLoaderReady: async () => {},
}));
vi.mock("@/lib/agent-manager", () => ({ reloadSessionsForCwd: state.sessions }));
vi.mock("@/lib/recycle-bin", () => ({ moveToTrash: state.trash }));
import { deleteSkill, previewDeleteSkill } from "@/lib/skills-service";

let group: string, directory: string, cwd: string, trash: string;
beforeAll(async () => { group = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-skill-trash-tests-"))); });
afterAll(async () => { await recycleGeneratedFixture(group); });
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(group, "case-"));
	state.agentDir = path.join(directory, "agent"); cwd = path.join(directory, "project"); trash = path.join(directory, "test-system-trash");
	for (const root of [path.join(state.agentDir, "skills"), cwd, trash]) await fs.mkdir(root, { recursive: true });
	state.skills = []; state.reload.mockClear(); state.sessions.mockClear();
	state.trash.mockReset().mockImplementation(async (removed) => {
		await fs.rename(removed, path.join(trash, `${randomUUID()}-${path.basename(removed)}`));
		return { removed };
	});
});
const discover = (filePath: string, name = "my-skill") => state.skills.push({ name, filePath, baseDir: path.dirname(filePath) });
async function skill(root: string, name = "my-skill"): Promise<string> {
	const file = path.join(root, name, "SKILL.md"); await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `---\nname: ${name}\n---\nbody\n`); discover(file, name); return file;
}
async function createLink(target: string, alias: string): Promise<boolean> {
	try { await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir"); return true; }
	catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) return false; throw error; }
}

describe("confirmed skill deletion uses only the system Trash", () => {
	it("recycles a global skill's own directory and does not create a backup", async () => {
		const file = await skill(path.join(state.agentDir, "skills"));
		const expected = await fs.realpath(path.dirname(file));
		await expect(deleteSkill(file)).resolves.toEqual({ removed: expected });
		expect(state.trash).toHaveBeenCalledWith(expected, expect.objectContaining({ expectedCanonical: expected, expectedLink: false }));
		await expect(fs.stat(path.dirname(file))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(state.agentDir, "backups"))).rejects.toMatchObject({ code: "ENOENT" });
		const recycled = (await fs.readdir(trash))[0];
		expect(await fs.readFile(path.join(trash, recycled, "SKILL.md"), "utf8")).toContain("body");
	});

	it("recycles a flat Markdown skill but retains its root and siblings", async () => {
		const root = path.join(state.agentDir, "skills"); const other = await skill(root, "other");
		const flat = path.join(root, "flat.md"); await fs.writeFile(flat, "---\nname: flat\n---\nbody"); discover(flat, "flat");
		await expect(deleteSkill(flat)).resolves.toEqual({ removed: await fs.realpath(root).then((real) => path.join(real, "flat.md")) });
		expect(await fs.readFile(other, "utf8")).toContain("other");
	});

	it("only recycles SKILL.md when it is directly in a protected skill root", async () => {
		const root = path.join(state.agentDir, "skills"), file = path.join(root, "SKILL.md");
		await fs.writeFile(file, "root skill"); await fs.writeFile(path.join(root, "notes.txt"), "keep me"); discover(file);
		await deleteSkill(file);
		expect(state.trash).toHaveBeenCalledWith(file, expect.any(Object));
		expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("keep me");
	});

	it("retains the shared directory when another discovered skill is nested inside", async () => {
		const outer = await skill(path.join(state.agentDir, "skills"), "outer");
		const inner = await skill(path.dirname(outer), "inner");
		await deleteSkill(outer);
		expect(state.trash).toHaveBeenCalledWith(outer, expect.any(Object));
		expect(await fs.readFile(inner, "utf8")).toContain("inner");
	});

	it("recycles only the selected project skill and refreshes that workspace", async () => {
		const file = await skill(path.join(cwd, ".pi", "skills"));
		const expected = await fs.realpath(path.dirname(file));
		await expect(deleteSkill(file, cwd, expected)).resolves.toEqual({ removed: expected });
		expect(state.sessions).toHaveBeenCalledWith(cwd);
	});

	it("refuses package-managed skills without touching any package files", async () => {
		const file = await skill(path.join(directory, "node_modules", "package", "skills"));
		await expect(deleteSkill(file, cwd)).rejects.toThrow("package-managed skill");
		expect(await fs.readFile(file, "utf8")).toContain("body");
		expect(state.trash).not.toHaveBeenCalled();
	});

	it("rejects a file outside the discovered list", async () => {
		const file = path.join(directory, "private.md"); await fs.writeFile(file, "keep");
		await expect(deleteSkill(file, cwd)).rejects.toThrow();
		expect(await fs.readFile(file, "utf8")).toBe("keep");
		expect(state.trash).not.toHaveBeenCalled();
	});

	it("accepts a canonical skill path when the agent directory uses a junction or another spelling", async () => {
		const actual = state.agentDir, alias = path.join(directory, "agent-alias");
		const file = await skill(path.join(actual, "skills"));
		if (!await createLink(actual, alias)) return;
		state.agentDir = alias;
		const expected = await fs.realpath(path.dirname(file));
		await expect(deleteSkill(file)).resolves.toEqual({ removed: expected });
	});

	it("does not recycle a changed removal preview", async () => {
		const file = await skill(path.join(state.agentDir, "skills"));
		const plan = await previewDeleteSkill(file);
		await expect(deleteSkill(file, undefined, `${plan.removed}-other`)).rejects.toThrow("path changed");
		expect(state.trash).not.toHaveBeenCalled();
	});

	it("retains the skill and does not refresh when system Trash is unavailable", async () => {
		const file = await skill(path.join(state.agentDir, "skills"));
		state.trash.mockRejectedValueOnce(Object.assign(new Error("no system Trash"), { code: "TRASH_UNAVAILABLE" }));
		await expect(deleteSkill(file)).rejects.toMatchObject({ code: "TRASH_UNAVAILABLE" });
		expect(await fs.readFile(file, "utf8")).toContain("body");
		expect(state.reload).not.toHaveBeenCalled(); expect(state.sessions).not.toHaveBeenCalled();
	});

	it("reports a refresh warning after recycling without inventing a backup path", async () => {
		const file = await skill(path.join(state.agentDir, "skills"));
		state.reload.mockRejectedValueOnce(new Error("reload failed"));
		const result = await deleteSkill(file);
		expect(result).toMatchObject({ removed: path.dirname(file), warning: expect.stringContaining("系统回收站") });
		expect(result).not.toHaveProperty("backup");
	});
});
