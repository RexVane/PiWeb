import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recycleFixture } from "./fixtures/recycle";

const state = vi.hoisted(() => ({ agentDir: "", skills: [] as Array<{ name: string; filePath: string; baseDir: string }> }));
vi.mock("@/lib/pi", () => ({
	getAgentDir: () => state.agentDir,
	getResourceLoader: () => ({ getSkills: () => ({ skills: state.skills }) }),
	resourceLoaderReady: async () => undefined, reloadAllLoaders: async () => [],
}));
vi.mock("@/lib/agent-manager", () => ({ reloadSessionsForCwd: async () => 0 }));
vi.mock("@/lib/recoverable-remove", () => ({ recoverableRemove: async (removed: string) => {
	const backup = `${removed}.recovered`;
	await fs.rename(removed, backup); return { removed, backup };
} }));
import { deleteSkill, previewDeleteSkill, readSkillFile } from "@/lib/skills-service";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(recycleFixture)); state.skills = []; });
async function setup() {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-link-removal-")));
	temporary.push(dir); state.agentDir = path.join(dir, "agent");
	await fs.mkdir(path.join(state.agentDir, "skills"), { recursive: true });
	const external = path.join(dir, "external"); await fs.mkdir(external);
	await fs.writeFile(path.join(external, "SKILL.md"), "---\nname: linked\n---\nbody");
	await fs.writeFile(path.join(external, "keep.txt"), "external data");
	return { dir, external, root: path.join(state.agentDir, "skills") };
}
const discover = (filePath: string) => state.skills.push({ name: "linked", filePath, baseDir: path.dirname(filePath) });

describe("skill deletion follows declarations rather than link targets", () => {
	it("treats a linked skills root as a link instead of deleting its target files", async () => {
		const { dir, root, external } = await setup();
		await fs.rename(root, `${root}.original`); await fs.symlink(external, root, "junction");
		const skill = path.join(root, "SKILL.md"); discover(skill);
		expect(await previewDeleteSkill(skill, dir)).toEqual({ removed: root, link: true });
		await deleteSkill(skill, dir, root);
		expect(await fs.readFile(path.join(external, "keep.txt"), "utf8")).toBe("external data");
	});
	it("retains a link shared by another skill, including differently cased Windows declarations", async () => {
		const { dir, root, external } = await setup(); const link = path.join(root, "linked");
		await fs.mkdir(path.join(external, "second")); await fs.writeFile(path.join(external, "second", "SKILL.md"), "second body");
		await fs.symlink(external, link, "junction"); const first = path.join(link, "SKILL.md"); discover(first);
		const second = path.join(link, "second", "SKILL.md"); discover(process.platform === "win32" ? second.toUpperCase() : second);
		await expect(previewDeleteSkill(first, dir)).rejects.toThrow("other skills");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	});
	it("removes only a directory junction and preserves its external target", async () => {
		const { dir, root, external } = await setup(); const link = path.join(root, "linked");
		await fs.symlink(external, link, "junction"); const skill = path.join(link, "SKILL.md"); discover(skill);
		expect(await previewDeleteSkill(skill, dir)).toEqual({ removed: link, link: true });
		await deleteSkill(skill, dir, link);
		expect(await fs.readFile(path.join(external, "keep.txt"), "utf8")).toBe("external data");
		expect((await fs.lstat(`${link}.recovered`)).isSymbolicLink()).toBe(true);
	});
	it("rejects external standalone files instead of deleting their parents", async () => {
		const { dir, external } = await setup(); const skill = path.join(external, "SKILL.md"); discover(skill);
		await expect(deleteSkill(skill, dir)).rejects.toThrow("External skill");
		expect(await fs.readFile(path.join(external, "keep.txt"), "utf8")).toBe("external data");
	});
	it("refuses a changed removal preview", async () => {
		const { dir, root } = await setup(); const skill = path.join(root, "flat.md"); await fs.writeFile(skill, "body"); discover(skill);
		await expect(deleteSkill(skill, dir, path.join(root, "other.md"))).rejects.toThrow("path changed");
		expect(await fs.readFile(skill, "utf8")).toBe("body");
	});
	it("rejects a file over the bounded preview limit before reading its content", async () => {
		const { dir, root } = await setup(); const skill = path.join(root, "large.md"); await fs.writeFile(skill, Buffer.alloc(1024 * 1024 + 1)); discover(skill);
		await expect(readSkillFile(skill, dir)).rejects.toThrow("1MB limit");
	});
});
