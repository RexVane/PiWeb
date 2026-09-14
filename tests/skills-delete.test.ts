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

vi.mock("@/lib/pi", () => ({
	// 真实 listSkills 走 resourceLoader.getSkills()；这里用受控技能列表替换加载器
	getAgentDir: () => path.join(os.tmpdir(), "piweb-test-agent"),
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
});

describe("deleteSkill", () => {
	it("removes the skill directory for a global skill (under the agent dir)", async () => {
		// classifyScope 只认 ~/.pi/agent 等真实目录；测试里模拟 agent 目录在其下建技能
		const agentDir = path.join(os.tmpdir(), "piweb-test-agent");
		const dir = path.join(agentDir, "skills", "my-skill");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "SKILL.md"), "---\nname: my-skill\n---\nbody\n");
		const filePath = path.join(dir, "SKILL.md");
		fakeSkills.set("my-skill", { name: "my-skill", filePath });
		try {
			await expect(deleteSkill(filePath, undefined)).resolves.toEqual({ removed: dir });
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
		await expect(deleteSkill(projectFile, cwd)).resolves.toEqual({ removed: dir });
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
		const filePath = makeSkillDir("global");
		await expect(deleteSkill(filePath, undefined)).rejects.toThrow();
		rmSync(path.dirname(path.dirname(filePath)), { recursive: true, force: true });
	});
});
