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

/**
 * 路径比较用的规范形式：展开真实路径 → 统一分隔符 → 去掉结尾斜杠 → Windows 下大小写不敏感。
 *
 * realpath 这一步是必须的：同一个目录可以有多种写法——Windows 的 8.3 短名（`C:\Users\RUNNER~1`）、
 * 含 `..` 的路径、junction / symlink。删技能、开关技能时 `resolveDiscoveredPath` 交出的是 **realpath 形式**，
 * 而 agentDir 是配置里的原样字符串，两边直接比字符串就会把"本来就在 agent 目录下"的全局技能
 * 判成 package 技能而拒绝删除（CI 的 Windows runner 上就是这样红的，真实用户只要路径里带短名也会中招）。
 */
async function toComparablePath(target: string): Promise<string> {
	let resolved: string;
	try {
		resolved = await fs.realpath(target);
	} catch {
		resolved = path.resolve(target); // 路径还不存在（如待创建的技能目录）：退化成普通规范化
	}
	const normalized = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

interface ScopeContext {
	/** 全部已展开成可比较形式 */
	agentDir: string;
	home: string;
	cwd?: string;
}

/** 每次调用只展开一次来源路径，避免逐个技能重复 realpath */
async function scopeContext(cwd?: string): Promise<ScopeContext> {
	return {
		agentDir: await toComparablePath(getAgentDir()),
		home: await toComparablePath(os.homedir()),
		cwd: cwd ? await toComparablePath(cwd) : undefined,
	};
}

/** 严格判断"在某个目录里面"：必须落在分隔符之后，避免 /ws 误匹配 /ws-other */
const within = (target: string, root: string) => target.startsWith(`${root}/`);

async function classifyScope(filePath: string, context: ScopeContext): Promise<SkillView["scope"]> {
	const norm = await toComparablePath(filePath);
	if (norm.includes("/node_modules/")) return "package";
	if (within(norm, context.agentDir) || within(norm, `${context.home}/.agents`) || within(norm, `${context.home}/.pi`))
		return "global";
	if (context.cwd && within(norm, context.cwd)) return "project";
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
		const context = await scopeContext(dir);
		for (const s of skills) {
			if (seen.has(s.filePath)) continue;
			seen.add(s.filePath);
			out.push({
				name: s.name,
				description: s.description,
				filePath: s.filePath,
				disabled: s.disableModelInvocation,
				scope: await classifyScope(s.filePath, context),
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
	const context = await scopeContext(cwd ?? process.cwd());
	const scope = await classifyScope(authorized, context);
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
	const context = await scopeContext(cwd ?? process.cwd());
	if ((await classifyScope(authorized, context)) === "package") {
		throw new Error("package-managed skill: disable it instead (it is reinstalled with the package)");
	}
	const skillDir = path.dirname(authorized);
	const normalizedSkillDir = await toComparablePath(skillDir);
	const workspace = cwd ?? process.cwd();
	const roots = [path.parse(skillDir).root, getAgentDir(), os.homedir(), workspace];
	for (const base of [getAgentDir(), os.homedir(), workspace]) {
		for (const relative of ["skills", "web-skills", ".git", ".agents", ".agents/skills", ".pi", ".pi/skills", ".pi/agent", ".pi/agent/skills"]) {
			roots.push(path.join(base, relative));
		}
	}
	const protectedRoots = await Promise.all(roots.map(toComparablePath));
	// A discovered root-level SKILL.md never authorizes deleting its collection or workspace.
	if (protectedRoots.some((root) => root === normalizedSkillDir || within(root, normalizedSkillDir))) {
		throw new Error("refusing to delete protected skill collection or workspace root");
	}
	await fs.rm(skillDir, { recursive: true, force: true });
	await reloadAllLoaders();
	const scope = await classifyScope(authorized, context);
	await reloadSessionsForCwd(scope === "project" ? cwd : undefined);
	return { removed: skillDir };
}
