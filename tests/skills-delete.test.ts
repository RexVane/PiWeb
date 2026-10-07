/**
 * 技能来源与删除：路径鉴权（必须来自发现列表）、来源按 pi 给的 sourceInfo 判定、
 * 只删 pi 技能目录里面的条目（目录技能删目录、单文件技能只删文件、符号链接只删链接）。
 * listSkills 依赖 SDK 加载器与真实 agent 目录，这里用 vi.mock 换成受控的技能列表。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ agentDir: "", skills: [] as unknown[] }));

vi.mock("@/lib/pi", () => ({
	getAgentDir: () => state.agentDir,
	getResourceLoader: () => ({ getSkills: () => ({ skills: state.skills }) }),
	reloadAllLoaders: vi.fn(async () => undefined),
	resourceLoaderReady: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-manager", () => ({ reloadSessionsForCwd: vi.fn(async () => undefined) }));

import { deleteSkill, listSkills } from "@/lib/skills-service";

type Source = { scope: "user" | "project" | "temporary"; origin: "top-level" | "package" };
const USER: Source = { scope: "user", origin: "top-level" };
const PROJECT: Source = { scope: "project", origin: "top-level" };
const PACKAGE: Source = { scope: "user", origin: "package" };

let base: string;
let workspace: string;
let skillsRoot: string;

beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-skills-"));
	state.agentDir = path.join(base, "agent");
	state.skills = [];
	workspace = path.join(base, "work");
	skillsRoot = path.join(state.agentDir, "skills");
	fs.mkdirSync(workspace, { recursive: true });
});
afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

/** 写一个技能文件，并像 pi 一样登记进发现列表（带 sourceInfo） */
function addSkill(file: string, source: Source = USER): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (!fs.existsSync(file)) fs.writeFileSync(file, "---\ndescription: test\n---\nbody\n");
	const name = path.basename(file) === "SKILL.md" ? path.basename(path.dirname(file)) : path.basename(file, ".md");
	state.skills.push({ name, description: "test", filePath: file, baseDir: path.dirname(file), disableModelInvocation: false, sourceInfo: { path: file, source: "local", ...source } });
	return file;
}

describe("skill scope", () => {
	it("follows pi's source info instead of guessing from the path, and says which skills can be deleted here", async () => {
		addSkill(path.join(skillsRoot, "mine", "SKILL.md"), USER);
		addSkill(path.join(base, "elsewhere", "listed", "SKILL.md"), USER);
		addSkill(path.join(workspace, ".pi", "skills", "local", "SKILL.md"), PROJECT);
		addSkill(path.join(state.agentDir, "git", "github.com", "o", "r", "skills", "from-git", "SKILL.md"), PACKAGE);
		addSkill(path.join(base, "tmp", "injected.md"), { scope: "temporary", origin: "top-level" });
		const view = Object.fromEntries((await listSkills(workspace)).map((skill) => [skill.name, `${skill.scope}${skill.deletable ? " deletable" : ""}`]));
		expect(view).toEqual({
			mine: "global deletable",
			listed: "global",
			local: "project deletable",
			"from-git": "package",
			injected: "package",
		});
	});
});

describe("deleteSkill", () => {
	it("removes a global skill's folder and keeps the skills folder", async () => {
		const file = addSkill(path.join(skillsRoot, "my-skill", "SKILL.md"));
		await expect(deleteSkill(file, workspace)).resolves.toEqual({ removed: path.dirname(file) });
		expect(fs.existsSync(path.dirname(file))).toBe(false);
		expect(fs.existsSync(skillsRoot)).toBe(true);
	});

	it("removes a project skill's folder", async () => {
		const file = addSkill(path.join(workspace, ".pi", "skills", "my-skill", "SKILL.md"), PROJECT);
		await expect(deleteSkill(file, workspace)).resolves.toEqual({ removed: path.dirname(file) });
		expect(fs.existsSync(path.dirname(file))).toBe(false);
		expect(fs.existsSync(path.join(workspace, ".pi", "skills"))).toBe(true);
	});

	it("deletes only the file of a single-file skill, never the folder it sits in", async () => {
		const solo = addSkill(path.join(skillsRoot, "solo.md"));
		const sibling = addSkill(path.join(skillsRoot, "other", "SKILL.md"));
		await expect(deleteSkill(solo, workspace)).resolves.toEqual({ removed: solo });
		expect(fs.existsSync(solo)).toBe(false);
		expect(fs.existsSync(sibling)).toBe(true);

		// .agents/skills 下子目录里的单个 .md 也各是一个技能
		const group = path.join(workspace, ".agents", "skills", "group");
		const first = addSkill(path.join(group, "first.md"), PROJECT);
		const second = addSkill(path.join(group, "second.md"), PROJECT);
		await expect(deleteSkill(first, workspace)).resolves.toEqual({ removed: first });
		expect(fs.existsSync(second)).toBe(true);
	});

	it("refuses a SKILL.md that makes a whole skills folder one skill", async () => {
		const sibling = addSkill(path.join(skillsRoot, "other", "SKILL.md"));
		const rootSkill = addSkill(path.join(skillsRoot, "SKILL.md"));
		await expect(deleteSkill(rootSkill, workspace)).rejects.toThrow(/skills folders/);
		expect(fs.existsSync(rootSkill)).toBe(true);
		expect(fs.existsSync(sibling)).toBe(true);
	});

	it("refuses skills loaded from paths set in settings, which may be the user's own folders", async () => {
		const own = addSkill(path.join(base, "code", "my-tool", "SKILL.md"), USER);
		const notes = addSkill(path.join(workspace, "notes", "guide.md"), PROJECT);
		const whole = addSkill(path.join(workspace, "SKILL.md"), PROJECT);
		for (const file of [own, notes, whole]) {
			await expect(deleteSkill(file, workspace)).rejects.toThrow(/skills folders/);
			expect(fs.existsSync(file)).toBe(true);
		}
	});

	it("removes only the link when the skill folder is a symbolic link", async () => {
		const source = path.join(base, "src", "linked");
		fs.mkdirSync(source, { recursive: true });
		fs.writeFileSync(path.join(source, "SKILL.md"), "---\ndescription: test\n---\nbody\n");
		fs.writeFileSync(path.join(source, "helper.sh"), "echo hi\n");
		fs.mkdirSync(skillsRoot, { recursive: true });
		const link = path.join(skillsRoot, "linked");
		fs.symlinkSync(source, link, "junction");
		const file = addSkill(path.join(link, "SKILL.md"));
		await expect(deleteSkill(file, workspace)).resolves.toEqual({ removed: link });
		expect(fs.existsSync(link)).toBe(false);
		expect(fs.readdirSync(source).sort()).toEqual(["SKILL.md", "helper.sh"]);
	});

	it("refuses package skills, including ones pi installed from git", async () => {
		const fromNpm = addSkill(path.join(state.agentDir, "npm", "node_modules", "pkg", "skills", "a", "SKILL.md"), PACKAGE);
		const fromGit = addSkill(path.join(state.agentDir, "git", "github.com", "o", "r", "skills", "b", "SKILL.md"), PACKAGE);
		for (const file of [fromNpm, fromGit]) {
			await expect(deleteSkill(file, workspace)).rejects.toThrow(/package-managed skill/);
			expect(fs.existsSync(file)).toBe(true);
		}
	});

	it("rejects paths outside the discovered skill list", async () => {
		const stray = path.join(skillsRoot, "stray", "SKILL.md");
		fs.mkdirSync(path.dirname(stray), { recursive: true });
		fs.writeFileSync(stray, "---\ndescription: test\n---\n");
		await expect(deleteSkill(stray, workspace)).rejects.toThrow(/discovered Pi configuration/);
		expect(fs.existsSync(stray)).toBe(true);
	});
});
