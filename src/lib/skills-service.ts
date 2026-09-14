/**
 * skills-service：技能发现（全局/项目/pi 包）+ SKILL.md frontmatter 开关。
 * 开关实现：外科手术式改写 `disable-model-invocation`，其余 YAML 原样保留，然后 reload 加载器。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentDir, getResourceLoader, reloadAllLoaders, resourceLoaderReady } from "./pi";
import { reloadSessionsForCwd } from "./agent-manager";
import { resolveDiscoveredPath } from "./path-security";

export interface SkillView {
	name: string;
	description: string;
	filePath: string;
	disabled: boolean;
	scope: "global" | "project" | "package";
	baseDir: string;
}

function classifyScope(filePath: string, cwd?: string): SkillView["scope"] {
	const norm = filePath.replace(/\\/g, "/").toLowerCase();
	const agentDir = getAgentDir().replace(/\\/g, "/").toLowerCase();
	const home = os.homedir().replace(/\\/g, "/").toLowerCase();
	if (norm.startsWith(`${agentDir}/`) || norm.startsWith(`${home}/.agents/`) || norm.startsWith(`${home}/.pi/`))
		return "global";
	if (cwd && norm.startsWith(path.resolve(cwd).replace(/\\/g, "/").toLowerCase())) return "project";
	if (norm.includes("/node_modules/")) return "package";
	return "package";
}

export async function listSkills(cwd?: string): Promise<SkillView[]> {
	const seen = new Set<string>();
	const out: SkillView[] = [];
	const targets: string[] = cwd ? [path.resolve(cwd)] : [process.cwd()];
	for (const dir of targets) {
		await resourceLoaderReady(dir);
		const loader = getResourceLoader(dir);
		const { skills } = loader.getSkills();
		for (const s of skills) {
			if (seen.has(s.filePath)) continue;
			seen.add(s.filePath);
			out.push({
				name: s.name,
				description: s.description,
				filePath: s.filePath,
				disabled: s.disableModelInvocation,
				scope: classifyScope(s.filePath, dir),
				baseDir: s.baseDir,
			});
		}
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/** 在 SKILL.md 的 YAML frontmatter 中精确改写一个布尔键，保留其余行 */
function toggleFrontmatterKey(content: string, key: string, value: boolean): string {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return content;
	const lines = m[1].split(/\r?\n/);
	const pattern = new RegExp(`^\\s*${key}\\s*:`);
	let replaced = false;
	const next = lines.map((line) => {
		if (pattern.test(line)) {
			replaced = true;
			return value ? `${key}: true` : `${key}: false`;
		}
		return line;
	});
	if (!replaced) {
		if (value) next.push(`${key}: true`);
	}
	if (!replaced && !value) return content; // 本来就没有且要关 → 无需改动
	const body = content.slice(m[0].length);
	return `---\n${next.join("\n")}\n---${body}`;
}

export async function setSkillDisabled(filePath: string, disabled: boolean, cwd?: string): Promise<{ changed: boolean }> {
	const skills = await listSkills(cwd);
	const authorized = await resolveDiscoveredPath(filePath, skills.map((skill) => skill.filePath));
	const content = await fs.readFile(authorized, "utf8");
	const next = toggleFrontmatterKey(content, "disable-model-invocation", disabled);
	if (next === content) return { changed: false };
	await fs.writeFile(authorized, next, "utf8");
	// 就地重载加载器并让活跃会话重建系统提示（技能列表在系统提示里）；全局技能影响所有目录
	await reloadAllLoaders();
	const scope = classifyScope(authorized, cwd);
	await reloadSessionsForCwd(scope === "project" ? cwd : undefined);
	return { changed: true };
}

export async function readSkillFile(filePath: string, cwd?: string): Promise<string> {
	const skills = await listSkills(cwd);
	const authorized = await resolveDiscoveredPath(filePath, skills.map((skill) => skill.filePath));
	return fs.readFile(authorized, "utf8");
}

/** 删除技能（SKILL.md 所在目录）。包技能（node_modules 内）随包安装，删除会被还原 → 拒绝并用禁用管理。 */
export async function deleteSkill(filePath: string, cwd?: string): Promise<{ removed: string }> {
	const skills = await listSkills(cwd);
	const authorized = await resolveDiscoveredPath(filePath, skills.map((skill) => skill.filePath));
	if (classifyScope(authorized, cwd) === "package") {
		throw new Error("package-managed skill: disable it instead (it is reinstalled with the package)");
	}
	const skillDir = path.dirname(authorized);
	// 只删技能目录本身，不能误删父目录（全局技能目录 ~/.pi/agent/skills、项目 .agents/skills 等）
	const agentDir = getAgentDir().replace(/\\/g, "/");
	const normalizedSkillDir = skillDir.replace(/\\/g, "/");
	const knownRoots = [`${agentDir}/skills`, `${agentDir}/web-skills`];
	if (!knownRoots.some((root) => normalizedSkillDir.toLowerCase() === root.toLowerCase())) {
		// 非已知根：项目内技能目录，至少确认 SKILL.md 直接位于其下且目录名非空
		if (path.basename(skillDir) === "") throw new Error("refusing to delete workspace root");
	}
	await fs.rm(skillDir, { recursive: true, force: true });
	await reloadAllLoaders();
	const scope = classifyScope(authorized, cwd);
	await reloadSessionsForCwd(scope === "project" ? cwd : undefined);
	return { removed: skillDir };
}
