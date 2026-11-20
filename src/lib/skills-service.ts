/**
 * skills-service：技能发现（个人 / 项目 / pi 包）+ SKILL.md frontmatter 开关。
 *
 * 作用域与来源**照抄 pi**：作用域取 SDK 的 `SourceInfo.scope`（user / project / temporary），
 * 来源取 `SourceInfo.origin`（top-level / package）。两者正交 —— 包里的技能同样可能是个人级或项目级，
 * 所以不能压成「全局 / 项目 / 扩展包」三选一。只有 SDK 没给 metadata 时才退回按路径判断。
 * 开关实现：外科手术式改写 `disable-model-invocation`，其余 YAML 原样保留，然后 reload 加载器。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentDir, getResourceLoader, reloadAllLoaders, resourceLoaderReady } from "./pi";
import { reloadSessionsForCwd } from "./agent-manager";
import { resolveDiscoveredPath } from "./path-security";
import { APP_ROOT } from "./app-root";
import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import type { SkillOrigin, SkillScope, SkillView } from "./types";
import { toggleSkillFrontmatterDisabled } from "./skill-frontmatter";
import { randomUUID } from "node:crypto";
import { replaceFileAtomically } from "./atomic-file";
import { withSettingsWriteLock, withExternalSettingsLock } from "./settings-write-lock";
import { moveToTrash } from "./recycle-bin";
import { assertNoRemovalMounts } from "./removal-boundary";

export const MAX_SKILL_BYTES = 1024 * 1024;

async function readSkillBounded(file: string): Promise<string> {
	const handle = await fs.open(file, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error("Skill file exceeds the 1MB limit");
		const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
		let total = 0;
		while (total < buffer.length) {
			const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
			if (!bytesRead) break;
			total += bytesRead;
		}
		if (total > MAX_SKILL_BYTES) throw new Error("Skill file exceeds the 1MB limit");
		return buffer.subarray(0, total).toString("utf8");
	} finally { await handle.close(); }
}

export type { SkillView };

/** 对外返回的技能：共享字段 + SDK 原始来源信息（界面不直接用，留给排障与删除分支） */
export type SkillEntry = SkillView & { sourceInfo?: SourceInfo };


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

async function isManagedPackagePath(target: string, context: ScopeContext): Promise<boolean> {
	if (target.includes("/node_modules/")) return true;
	const roots = [`${context.agentDir}/git`, `${context.agentDir}/npm`, `${context.agentDir}/npm/node_modules`];
	if (context.cwd) roots.push(`${context.cwd}/.pi/git`, `${context.cwd}/.pi/npm`, `${context.cwd}/.pi/npm/node_modules`, `${context.cwd}/node_modules`);
	// The cache itself may be a junction. Comparing only the canonical skill
	// with the declared cache path would let an alias remove its package.
	const canonicalRoots = await Promise.all(roots.map(toComparablePath));
	return [...roots, ...canonicalRoots].some((root) => within(target, root));
}

interface Placement {
	scope: SkillScope;
	origin: SkillOrigin;
}

/**
 * 判定技能的作用域与来源。
 *
 * 唯一权威是 SDK 给的 `sourceInfo`（pi 自己算的）；只有缺 metadata 时才按路径回退。
 * 回退顺序必须「最具体的根优先」：agentDir → cwd → ~/.agents。
 * 反例：工作区恰好就是 home 时，先判 cwd 会把 `~/.pi/agent/skills` 说成项目技能。
 */
async function resolvePlacement(filePath: string, context: ScopeContext, sourceInfo?: SourceInfo): Promise<Placement> {
	if (sourceInfo) {
		return { scope: sourceInfo.scope, origin: sourceInfo.origin === "package" ? "package" : "top-level" };
	}
	const norm = await toComparablePath(filePath);
	// 先跟随软链接再判受管包位置：技能根里的别名可能指向 node_modules
	if (within(norm, context.agentDir)) {
		const packaged = within(norm, `${context.agentDir}/git`) || within(norm, `${context.agentDir}/npm`) || norm.includes("/node_modules/");
		return { scope: "user", origin: packaged ? "package" : "top-level" };
	}
	if (context.cwd && within(norm, context.cwd)) {
		const packaged = within(norm, `${context.cwd}/.pi/git`) || within(norm, `${context.cwd}/.pi/npm`) || norm.includes("/node_modules/");
		return { scope: "project", origin: packaged ? "package" : "top-level" };
	}
	if (within(norm, `${context.home}/.agents`)) return { scope: "user", origin: "top-level" };
	if (norm.includes("/node_modules/")) return { scope: "user", origin: "package" };
	// 认不出来就按项目级算：宁可显示「只在这个工作区可用」，也不要把别处的项目技能冒充成个人级
	return { scope: "project", origin: "top-level" };
}

/** 来源目录的可读写法：工作区内给相对路径，home 下给 `~`，其余原样返回 */
function formatSourceRoot(rawDir: string, cwd?: string): string {
	const toSlash = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
	const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
	const dir = toSlash(rawDir);
	const dirKey = fold(dir);
	if (cwd) {
		const root = toSlash(path.resolve(cwd));
		const rootKey = fold(root);
		if (dirKey === rootKey) return ".";
		if (dirKey.startsWith(`${rootKey}/`)) return `.${dir.slice(root.length)}`;
	}
	const home = toSlash(os.homedir());
	const homeKey = fold(home);
	if (dirKey === homeKey) return "~";
	if (dirKey.startsWith(`${homeKey}/`)) return `~${dir.slice(home.length)}`;
	return dir;
}

/** 来源根：包用包根，顶层用 SDK 记录的 baseDir，缺失时退到技能目录 */
function sourceRootOf(s: { filePath: string; baseDir: string; sourceInfo?: SourceInfo }): string {
	return s.sourceInfo?.baseDir || s.baseDir || path.dirname(s.filePath);
}

function sourceLabelOf(s: { filePath: string; baseDir: string; sourceInfo?: SourceInfo }, cwd?: string): string {
	const info = s.sourceInfo;
	if (info?.origin === "package" && info.source) return info.source.replace(/^npm:/, "");
	return formatSourceRoot(sourceRootOf(s), cwd);
}

export async function listSkills(cwd?: string): Promise<SkillEntry[]> {
	const seen = new Set<string>();
	const out: SkillEntry[] = [];
	const targets: string[] = cwd ? [path.resolve(cwd)] : [APP_ROOT];
	for (const dir of targets) {
		await resourceLoaderReady(dir);
		const loader = getResourceLoader(dir);
		const { skills } = loader.getSkills();
		const context = await scopeContext(dir);
		for (const s of skills) {
			if (seen.has(s.filePath)) continue;
			seen.add(s.filePath);
			const placement = await resolvePlacement(s.filePath, context, s.sourceInfo);
			out.push({
				name: s.name,
				description: s.description,
				filePath: s.filePath,
				disabled: s.disableModelInvocation,
				scope: placement.scope,
				origin: placement.origin,
				sourceLabel: sourceLabelOf(s, dir),
				baseDir: s.baseDir,
				...(s.sourceInfo ? { sourceInfo: s.sourceInfo } : {}),
			});
		}
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

export async function setSkillDisabled(filePath: string, disabled: boolean, cwd?: string): Promise<{ changed: boolean; warning?: string }> {
	const skills = await listSkills(cwd);
	const authorized = await resolveDiscoveredPath(filePath, skills.map((skill) => skill.filePath));
	const changed = await withSettingsWriteLock(authorized, () => withExternalSettingsLock(authorized, async () => {
		const content = await readSkillBounded(authorized);
		const next = toggleSkillFrontmatterDisabled(content, disabled);
		if (next === content) return false;
		const temporary = `${authorized}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, next, { encoding: "utf8", flag: "wx", mode: (await fs.stat(authorized)).mode });
			if (await readSkillBounded(authorized) !== content) throw new Error("Skill changed while updating; refresh and try again");
			await replaceFileAtomically(temporary, authorized);
		} finally { await fs.unlink(temporary).catch(() => undefined); }
		return true;
	}));
	if (!changed) return { changed: false };
	// 就地重载加载器并让活跃会话重建系统提示（技能列表在系统提示里）；全局技能影响所有目录
	try { await reloadAllLoaders(); } catch { return { changed: true, warning: "技能更改已保存，加载器刷新失败，请重载会话。" }; }
	const context = await scopeContext(cwd);
	const canonical = await toComparablePath(authorized);
	const source = (await Promise.all(skills.map(async (skill) => ({ skill, canonical: await toComparablePath(skill.filePath) })))).find((entry) => entry.canonical === canonical)?.skill.sourceInfo;
	const { scope } = await resolvePlacement(authorized, context, source);
	try { await reloadSessionsForCwd(scope === "project" ? cwd : undefined); } catch { return { changed: true, warning: "技能更改已保存，会话刷新失败，请重载会话。" }; }
	return { changed: true };
}

export async function readSkillFile(filePath: string, cwd?: string): Promise<string> {
	const skills = await listSkills(cwd);
	const authorized = await resolveDiscoveredPath(filePath, skills.map((skill) => skill.filePath));
	return readSkillBounded(authorized);
}

/** 技能根与用户目录本身：哪怕 SKILL.md 直接放在里面，也只能删文件，绝不能删目录 */
async function protectedDirs(context: ScopeContext): Promise<Set<string>> {
	const dirs = [
		context.agentDir,
		`${context.agentDir}/skills`,
		`${context.agentDir}/web-skills`,
		context.home,
		`${context.home}/.pi`,
		`${context.home}/.agents`,
		`${context.home}/.agents/skills`,
	];
	if (context.cwd) dirs.push(context.cwd, `${context.cwd}/.pi`, `${context.cwd}/.pi/skills`, `${context.cwd}/.agents`, `${context.cwd}/.agents/skills`);
	return new Set(await Promise.all(dirs.map(toComparablePath)));
}

/**
 * 删除技能。包技能（node_modules 内）随包安装，删除会被还原 → 拒绝并用禁用管理。
 *
 * 只有「<名字>/SKILL.md」这种技能才连目录一起删。SDK 也认技能根下直接放的平铺 `foo.md`，
 * 它的 dirname 就是技能根本身（~/.pi/agent/skills、项目 .pi/skills…），按目录删会把整个技能根
 * 连同其它技能一起删掉 —— 所以平铺技能、以及目录不归它独占的情况，一律只删这一个文件。
 */
export interface SkillDeletePreview { removed: string; link: boolean }

async function skillDeletionPlan(filePath: string, cwd?: string): Promise<SkillDeletePreview & { scope: SkillScope; expectedCanonical?: string; managedRoot: string }> {
	const skills = await listSkills(cwd);
	const authorized = await resolveDiscoveredPath(filePath, skills.map((skill) => skill.filePath));
	const context = await scopeContext(cwd ?? APP_ROOT);
	const comparableFile = await toComparablePath(authorized);
	const discovered = await Promise.all(skills.map(async (skill) => ({ skill, canonical: await toComparablePath(skill.filePath) })));
	const matches = discovered.filter(({ canonical }) => canonical === comparableFile);
	const placement = await resolvePlacement(authorized, context, matches[0]?.skill.sourceInfo);
	// SDK describes where a reference was declared. A top-level alias still cannot
	// authorize removing the installed package that owns its canonical target.
	if (await isManagedPackagePath(comparableFile, context) || placement.origin === "package"
		|| matches.some(({ skill }) => skill.origin === "package" || skill.sourceInfo?.origin === "package")) {
		throw new Error("package-managed skill: disable it instead (it is reinstalled with the package)");
	}
	const rawRoots = [path.join(getAgentDir(), "skills"), path.join(getAgentDir(), "web-skills"), path.join(os.homedir(), ".agents", "skills"),
		path.join(cwd ?? APP_ROOT, ".pi", "skills"), path.join(cwd ?? APP_ROOT, ".agents", "skills")];
	const roots = await Promise.all(rawRoots.map(async (root) => ({ raw: path.resolve(root), canonical: await toComparablePath(root), parentCanonical: await toComparablePath(path.dirname(root)) })));
	const declared = matches.find(({ skill }) => path.resolve(skill.filePath) === path.resolve(filePath))?.skill.filePath ?? matches[0]?.skill.filePath;
	if (!declared) throw new Error("Skill is no longer configured");
	let raw = path.resolve(declared);
	let root = roots.find(({ raw: candidate }) => {
		const relative = path.relative(candidate, raw);
		return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	});
	if (!root) {
		root = roots.find(({ canonical }) => within(comparableFile, canonical));
		if (root) raw = path.join(root.raw, path.relative(root.canonical, authorized));
	}
	if (!root) throw new Error("External skill files must be removed from their configured source; their original files were retained");
	await assertNoRemovalMounts(raw, root.raw);
	const segments = path.relative(root.raw, raw).split(path.sep);
	let candidate = root.raw;
	for (const segment of ["", ...segments]) {
		if (segment) candidate = path.join(candidate, segment);
		if ((await fs.lstat(candidate)).isSymbolicLink()) {
			const lexicalKey = (value: string) => { const normalized = path.resolve(value).replace(/\\/g, "/"); return process.platform === "win32" ? normalized.toLowerCase() : normalized; };
			if (skills.some((skill) => lexicalKey(skill.filePath) !== lexicalKey(declared) && within(lexicalKey(skill.filePath), lexicalKey(candidate)))) {
				throw new Error("This link contains other skills; remove the source configuration instead");
			}
			const parent = await fs.realpath(path.dirname(candidate));
			const comparableParent = await toComparablePath(parent);
			const expectedParent = candidate === root.raw ? root.parentCanonical : root.canonical;
			if (comparableParent !== expectedParent && !within(comparableParent, expectedParent)) throw new Error("Skill link moved outside its managed root; original files were retained");
			const removed = path.join(parent, path.basename(candidate));
			return { removed, link: true, scope: placement.scope, managedRoot: root.raw };
		}
	}
	if (!within(comparableFile, root.canonical)) throw new Error("Skill target moved outside its managed root; original files were retained");
	const skillDir = path.dirname(authorized);
	const comparableDir = await toComparablePath(skillDir);
	const protectedRoots = await protectedDirs(context);
	const others = discovered.map(({ canonical }) => canonical);
	const ownsDir = path.basename(authorized) === "SKILL.md"
		&& path.dirname(skillDir) !== skillDir
		&& !protectedRoots.has(comparableDir)
		&& !others.some((other) => other !== comparableFile && within(other, comparableDir));
	const removed = ownsDir ? skillDir : authorized;
	return { removed, link: false, scope: placement.scope, expectedCanonical: removed, managedRoot: root.raw };
}

export async function previewDeleteSkill(filePath: string, cwd?: string): Promise<SkillDeletePreview> {
	const { removed, link } = await skillDeletionPlan(filePath, cwd);
	return { removed, link };
}

export async function deleteSkill(filePath: string, cwd?: string, expectedPath?: string): Promise<{ removed: string; warning?: string }> {
	const plan = await skillDeletionPlan(filePath, cwd);
	if (expectedPath && path.resolve(expectedPath) !== path.resolve(plan.removed)) throw new Error("Skill removal path changed; review it again");
	const result = await moveToTrash(plan.removed, { expectedCanonical: plan.expectedCanonical, expectedLink: plan.link, managedRoot: plan.managedRoot });
	try {
		await reloadAllLoaders();
		await reloadSessionsForCwd(plan.scope === "project" ? cwd ?? APP_ROOT : undefined);
	} catch { return { removed: result.removed, warning: "技能已移到系统回收站，资源刷新失败，请重载会话。" }; }
	return { removed: result.removed };
}
