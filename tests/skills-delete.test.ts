/**
 * deleteSkill 的核心约束：路径鉴权（必须来自发现列表）、package 技能拒绝删除。
 * listSkills 依赖 SDK 加载器与真实 agent 目录，不适合单测；这里只测纯删除分支，
 * 用 vi.mock 把 listSkills 换成受控列表。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

const fakeSkills = new Map<string, { name: string; filePath: string; description?: string; disableModelInvocation?: boolean; baseDir?: string }>();
/** agent 目录的"配置写法"可被单个用例改写（见下面的 junction 回归用例） */
const mockState = vi.hoisted(() => ({ agentDir: "" }));

/**
 * 建路径一律从**展开后**的临时目录起步：CI 的 Windows runner 上 os.tmpdir() 是 8.3 短名
 * （`C:\Users\RUNNER~1\...`），而 deleteSkill 返回的是它自己 realpath 之后的路径，两边不统一断言就对不上。
 *
 * 注意必须用**异步** realpath：Windows 上 fs.realpathSync 不展开 8.3 短名
 * （本机实测 realpathSync("C:\PROGRA~1") 原样返回，而 fs.promises.realpath 给出 "C:\Program Files"），
 * 产品代码用的是异步版，测试跟着用同一个 API 才不会假红。
 */
function realTmp(): Promise<string> {
	return fs.promises.realpath(os.tmpdir());
}

/** 产品返回的是 realpath 之后的位置；断言前用同一个 API 取一份期望值 */
function expanded(target: string): Promise<string> {
	return fs.promises.realpath(target);
}

/** 删目录链接：Windows 的 junction 是目录（rmdir），POSIX 的 symlink 要 unlink */
function removeDirLink(link: string): void {
	try {
		fs.unlinkSync(link);
	} catch {
		try {
			fs.rmdirSync(link);
		} catch {
			/* 已经不存在 */
		}
	}
}

vi.mock("@/lib/pi", () => ({
	// 真实 listSkills 走 resourceLoader.getSkills()；这里用受控技能列表替换加载器
	// 故意返回"配置原样"的路径（不做展开）：产品侧的 toComparablePath 负责展开
	getAgentDir: () => mockState.agentDir || path.join(os.tmpdir(), "piweb-test-agent"),
	getResourceLoader: () => ({ getSkills: () => ({ skills: [...fakeSkills.values()] }) }),
	reloadAllLoaders: vi.fn(async () => undefined),
	resourceLoaderReady: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-manager", () => ({ reloadSessionsForCwd: vi.fn(async () => undefined) }));

import { deleteSkill } from "@/lib/skills-service";

function makeSkillDir(scope: "project" | "package"): string {
	const base = mkdtempSync(path.join(os.tmpdir(), `piweb-skill-${scope}-`));
	const dir = path.join(base, "my-skill");
	mkdirSync(dir);
	writeFileSync(path.join(dir, "SKILL.md"), "---\nname: my-skill\n---\nbody\n");
	return path.join(dir, "SKILL.md");
}

afterEach(() => {
	fakeSkills.clear();
	mockState.agentDir = "";
});

describe("deleteSkill", () => {
	it.each(["", "skills", "web-skills", ".git", ".agents", ".agents/skills", ".pi", ".pi/skills"])("protects workspace and collection root %s", async (relative) => {
		const root = mkdtempSync(path.join(os.tmpdir(), "piweb-skill-root-"));
		const dir = path.join(root, relative);
		mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, "SKILL.md");
		writeFileSync(filePath, "---\nname: root\n---\n");
		writeFileSync(path.join(root, "keep.txt"), "keep");
		fakeSkills.set("root", { name: "root", filePath });
		try {
			await expect(deleteSkill(filePath, root)).rejects.toThrow(/protected.*root/);
			expect(fs.existsSync(filePath)).toBe(true);
			expect(fs.readFileSync(path.join(root, "keep.txt"), "utf8")).toBe("keep");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it.each(["", "skills", "web-skills"])("protects global agent collection root %s", async (relative) => {
		const root = mkdtempSync(path.join(os.tmpdir(), "piweb-skill-agent-root-"));
		mockState.agentDir = root;
		const dir = path.join(root, relative);
		mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, "SKILL.md");
		writeFileSync(filePath, "---\nname: root\n---\n");
		fakeSkills.set("root", { name: "root", filePath });
		try {
			await expect(deleteSkill(filePath)).rejects.toThrow(/protected.*root/);
			expect(fs.existsSync(filePath)).toBe(true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("refuses package skills even inside the active workspace", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "piweb-skill-local-pkg-"));
		const dir = path.join(root, "node_modules", "pkg", "skill");
		mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, "SKILL.md");
		writeFileSync(filePath, "---\nname: pkg\n---\n");
		fakeSkills.set("pkg", { name: "pkg", filePath });
		try {
			await expect(deleteSkill(filePath, root)).rejects.toThrow(/package-managed/);
			expect(fs.existsSync(filePath)).toBe(true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("removes the skill directory for a global skill (under the agent dir)", async () => {
		// classifyScope 只认 ~/.pi/agent 等真实目录；测试里模拟 agent 目录在其下建技能
		const agentDir = path.join(os.tmpdir(), "piweb-test-agent");
		const dir = path.join(agentDir, "skills", "my-skill");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "SKILL.md"), "---\nname: my-skill\n---\nbody\n");
		const filePath = path.join(dir, "SKILL.md");
		fakeSkills.set("my-skill", { name: "my-skill", filePath });
		try {
			const expected = await expanded(dir); // 删之前先取展开形式，产品返回的就是这个
			await expect(deleteSkill(filePath, undefined)).resolves.toEqual({ removed: expected });
			expect(fs.existsSync(dir)).toBe(false);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("removes the skill directory for a project skill", async () => {
		const cwd = mkdtempSync(path.join(os.tmpdir(), "piweb-skill-cwd-"));
		const filePath = makeSkillDir("project");
		// classifyScope: 不在 agent 目录下的绝对路径 + cwd 前缀不匹配时落 package；放进 cwd 下即 project
		const dir = path.join(cwd, "my-skill");
		rmSync(path.dirname(filePath), { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "SKILL.md"), "---\nname: my-skill\n---\nbody\n");
		const projectFile = path.join(dir, "SKILL.md");
		fakeSkills.set("my-skill", { name: "my-skill", filePath: projectFile });
		const expected = await expanded(dir);
		await expect(deleteSkill(projectFile, cwd)).resolves.toEqual({ removed: expected });
		expect(fs.existsSync(dir)).toBe(false);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("refuses to delete a package skill (node_modules)", async () => {
		const base = mkdtempSync(path.join(os.tmpdir(), "piweb-skill-pkg-"));
		const dir = path.join(base, "node_modules", "some-pkg", "my-skill");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "SKILL.md"), "---\nname: my-skill\n---\nbody\n");
		const filePath = path.join(dir, "SKILL.md");
		fakeSkills.set("my-skill", { name: "my-skill", filePath });
		await expect(deleteSkill(filePath, undefined)).rejects.toThrow(/package-managed skill/);
		expect(fs.existsSync(filePath)).toBe(true);
		rmSync(base, { recursive: true, force: true });
	});

	it("rejects paths outside the discovered skill list", async () => {
		const filePath = makeSkillDir("project");
		await expect(deleteSkill(filePath, undefined)).rejects.toThrow();
		rmSync(path.dirname(path.dirname(filePath)), { recursive: true, force: true });
	});

	/**
	 * 回归：配置里的 agent 目录与"发现到的技能路径"是同一个目录的两种写法时，不能被判成 package 技能。
	 *
	 * 删技能时 resolveDiscoveredPath 交出的是 realpath 形式，而 agentDir 是配置里的原样字符串，
	 * 两边直接比字符串就会漏掉。CI 的 Windows runner 上 os.tmpdir() 是 8.3 短名
	 * （C:\Users\RUNNER~1\...，展开后是 C:\Users\runneradmin\...）就是这么红的；真实用户路径里
	 * 带短名或 junction 时同样会中招。
	 *
	 * 这里用 junction 复现同一类差异——**只有 realpath 能识破 junction，path.resolve 不能**，
	 * 所以这条用例同时挡住了"用归一化代替展开"这种假修复。
	 */
	it("agent 目录是同目录的另一种写法（junction / 8.3 短名）时，全局技能仍然可以删", async () => {
		const tmp = await realTmp();
		const realDir = path.join(tmp, "piweb-agent-real");
		const linkDir = path.join(tmp, "piweb-agent-link");
		const skillDir = path.join(realDir, "skills", "my-skill");
		fs.rmSync(realDir, { recursive: true, force: true });
		removeDirLink(linkDir); // 上一次留下的链接（若有）
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---\nbody\n");
		fs.symlinkSync(realDir, linkDir, "junction");
		const filePath = path.join(skillDir, "SKILL.md");
		fakeSkills.set("my-skill", { name: "my-skill", filePath });
		mockState.agentDir = linkDir;
		try {
			const expected = await expanded(skillDir);
			await expect(deleteSkill(filePath, undefined)).resolves.toEqual({ removed: expected });
			expect(fs.existsSync(skillDir)).toBe(false);
		} finally {
			removeDirLink(linkDir); // 只删链接本身，不动目标
			fs.rmSync(realDir, { recursive: true, force: true });
		}
	});
});
