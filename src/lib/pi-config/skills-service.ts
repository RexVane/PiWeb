/**
 * skills-service：技能发现（全局/项目/pi 包）+ SKILL.md frontmatter 开关。
 * 开关实现：外科手术式改写 `disable-model-invocation`，其余 YAML 原样保留，然后 reload 加载器。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getResourceLoader, reloadAllLoaders, resourceLoaderReady } from "../pi";
import { reloadSessionsForCwd } from "../agent/agent-manager";
import { BoundaryError, isPathInside, matchDiscoveredPath, resolveDiscoveredPath, samePath } from "../security/path-security";

export interface SkillView {
	name: string;
	description: string;
	filePath: string;
	disabled: boolean;
	scope: "global" | "project" | "package";
	/** 能否在网页上删除：只有 pi 默认技能目录里面的非包技能可以（见 deleteSkill） */
	deletable: boolean;
	baseDir: string;
}

/**
 * 来源以 pi 给每个技能的 sourceInfo 为准，不按路径前缀猜（Windows 短名、junction、符号链接都会猜错，
 * pi 的 git 包也不在 node_modules 里）：包里来的（npm / git / 本地包）是 package，顶层资源按 scope 分全局 / 项目；
 * 临时来源（命令行、扩展临时注入）不归 PiWeb 管，和包技能一样只能禁用。
 */
function scopeOf(info: Skill["sourceInfo"] | undefined): SkillView["scope"] {
	if (info?.origin !== "top-level") return "package";
	if (info.scope === "user") return "global";
	if (info.scope === "project") return "project";
	return "package";
}

/** pi 默认扫描的技能目录：~/.pi/agent/skills、~/.agents/skills、项目 .pi/skills，以及工作区一路向上的 .agents/skills */
function skillCollectionRoots(workspace: string): string[] {
	const roots = [path.join(getAgentDir(), "skills"), path.join(os.homedir(), ".agents", "skills"), path.join(workspace, ".pi", "skills")];
	for (let dir = workspace; ; dir = path.dirname(dir)) {
		roots.push(path.join(dir, ".agents", "skills"));
		if (path.dirname(dir) === dir) break;
	}
	return roots;
}

const realOr = (target: string) => fs.realpath(target).catch(() => target);

/** 集合根的原样写法与展开写法（Windows 短名、junction、符号链接） */
async function collectionRootForms(workspace: string): Promise<string[]> {
	const roots = skillCollectionRoots(workspace);
	return [...roots, ...(await Promise.all(roots.map(realOr)))];
}

/**
 * 删除这个技能要删的条目：pi 的技能有两种形态——带 SKILL.md 的目录（整个目录就是这个技能）和技能目录里单独的 .md 文件，
 * 前者是目录，后者只是这个文件。条目必须落在 pi 默认技能目录**里面**，否则返回 null（不可删）：
 * SKILL.md 直接放在这些目录根上时删目录等于删掉整个集合；settings 里另配的路径可能是用户自己的源码目录。
 * 条目最后一段不展开：技能目录是符号链接时按链接所在的位置算，删的也只是链接。
 */
async function removableEntry(filePath: string, rootForms: string[]): Promise<string | null> {
	const entry = path.basename(filePath) === "SKILL.md" ? path.dirname(filePath) : filePath;
	const forms = [entry, path.join(await realOr(path.dirname(entry)), path.basename(entry))];
	return forms.some((form) => rootForms.some((root) => isPathInside(root, form) && !samePath(root, form))) ? entry : null;
}

export async function listSkills(cwd?: string): Promise<SkillView[]> {
	const seen = new Set<string>();
	const out: SkillView[] = [];
	const targets: string[] = cwd ? [path.resolve(cwd)] : [process.cwd()];
	for (const dir of targets) {
		await resourceLoaderReady(dir);
		const loader = getResourceLoader(dir);
		const { skills } = loader.getSkills();
		const roots = await collectionRootForms(dir);
		for (const s of skills) {
			if (seen.has(s.filePath)) continue;
			seen.add(s.filePath);
			const scope = scopeOf(s.sourceInfo);
			out.push({
				name: s.name,
				description: s.description,
				filePath: s.filePath,
				disabled: s.disableModelInvocation,
				scope,
				deletable: scope !== "package" && (await removableEntry(s.filePath, roots)) !== null,
				baseDir: s.baseDir,
			});
		}
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/** 请求的路径必须是 pi 发现的某个技能：交回该技能（路径保持 pi 列出的写法）与技能文件的真实路径 */
async function authorizeSkill(filePath: string, cwd?: string): Promise<{ skill: SkillView; realPath: string }> {
	const skills = await listSkills(cwd);
	const { realPath, discovered } = await matchDiscoveredPath(filePath, skills.map((skill) => skill.filePath));
	return { skill: skills.find((skill) => skill.filePath === discovered)!, realPath };
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
	const { skill, realPath } = await authorizeSkill(filePath, cwd);
	const content = await fs.readFile(realPath, "utf8");
	const next = toggleFrontmatterKey(content, "disable-model-invocation", disabled);
	if (next === content) return { changed: false };
	await fs.writeFile(realPath, next, "utf8");
	// 就地重载加载器并让活跃会话重建系统提示（技能列表在系统提示里）；全局技能影响所有目录
	await reloadAllLoaders();
	await reloadSessionsForCwd(skill.scope === "project" ? cwd : undefined);
	return { changed: true };
}

export async function readSkillFile(filePath: string, cwd?: string): Promise<string> {
	const skills = await listSkills(cwd);
	const authorized = await resolveDiscoveredPath(filePath, skills.map((skill) => skill.filePath));
	return fs.readFile(authorized, "utf8");
}

/**
 * 删除技能：目录技能删目录，单文件技能只删文件，符号链接只删链接（见 removableEntry）。
 * 包技能随包安装，删除会被还原 → 拒绝并用禁用管理；不在 pi 默认技能目录里面的拒绝，请用户手动处理。
 */
export async function deleteSkill(filePath: string, cwd?: string): Promise<{ removed: string }> {
	const { skill } = await authorizeSkill(filePath, cwd);
	if (skill.scope === "package") {
		throw new BoundaryError("package-managed skill: disable it instead (it is reinstalled with the package)");
	}
	const entry = await removableEntry(skill.filePath, await collectionRootForms(cwd ? path.resolve(cwd) : process.cwd()));
	if (!entry) {
		throw new BoundaryError("only skills inside pi's skills folders can be deleted here; this one is a whole skills folder or comes from a path set in settings, remove it by hand");
	}
	await fs.rm(entry, { recursive: true, force: true });
	await reloadAllLoaders();
	await reloadSessionsForCwd(skill.scope === "project" ? cwd : undefined);
	return { removed: entry };
}
