/**
 * prompt-sources：已发现提示词与技能来源的只读路径授权与有界读取。
 *
 * 覆盖：系统提示词覆盖文件（SYSTEM.md）、追加提示词（APPEND_SYSTEM.md）、项目记忆（AGENTS.md）、
 * 技能提示词（SKILL.md）、提示模板（prompts/*.md），以及管理页打开的已禁用模板。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getPackageManager, getResourceLoader, refreshResourceLoaderIfStale } from "./pi";
import { BoundaryError, isPathInside, resolveDiscoveredPath, samePath } from "./path-security";
import { FileSizeLimitError, readFileBounded } from "./read-file-bounded";

export const MAX_PROMPT_SOURCE_BYTES = 1024 * 1024;

/** 仅收集受信任来源白名单与技能根路径；不对外暴露清单。 */
async function discoverPromptAllowlist(cwd: string): Promise<{ allowed: string[]; skillPaths: string[] }> {
	const resolvedCwd = path.resolve(cwd);
	await refreshResourceLoaderIfStale(resolvedCwd);
	const loader = getResourceLoader(resolvedCwd);
	const allowed: string[] = [];
	const skillPaths: string[] = [];

	const systemSource = loader.getSystemPromptSource();
	if (systemSource?.path) allowed.push(systemSource.path);
	for (const source of loader.getAppendSystemPromptSources()) {
		if (source.path) allowed.push(source.path);
	}
	for (const file of loader.getAgentsFiles().agentsFiles) {
		if (file.path) allowed.push(file.path);
	}
	for (const skill of loader.getSkills().skills) {
		if (!skill.filePath) continue;
		allowed.push(skill.filePath);
		skillPaths.push(skill.filePath);
	}
	for (const template of loader.getPrompts().prompts) {
		if (template.filePath) allowed.push(template.filePath);
	}
	return { allowed, skillPaths };
}

/** 来源正文及其附件共用发现边界；链接限于该技能目录或当前工作区，realpath 后再次验边界。 */
export async function resolvePromptSourcePath(filePath: string, cwd: string, sourcePath?: string): Promise<string> {
	const { allowed, skillPaths } = await discoverPromptAllowlist(cwd);
	const requestedSource = sourcePath ?? filePath;
	if (typeof requestedSource === "string" && path.isAbsolute(requestedSource) && requestedSource.length <= 4096
		&& !allowed.some((candidate) => samePath(candidate, requestedSource))) {
		// A template opened from its management page may be disabled. It remains
		// an explicitly discovered file, not a license to read its parent directory.
		const { prompts } = await getPackageManager(path.resolve(cwd)).resolve(async () => "skip");
		allowed.push(...prompts.map((resource) => resource.path));
	}
	if (sourcePath === undefined) {
		return resolveDiscoveredPath(filePath, allowed);
	}
	const source = await resolveDiscoveredPath(sourcePath, allowed);
	if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.length > 4096) throw new BoundaryError("invalid resource path");
	const authorized = await fs.realpath(filePath).catch(() => { throw new BoundaryError("resource not found"); });
	const roots = [await fs.realpath(cwd)];
	for (const candidate of skillPaths) {
		const real = await fs.realpath(candidate).catch(() => null);
		if (real && samePath(real, source)) roots.push(path.dirname(real));
	}
	if (!roots.some((root) => isPathInside(root, authorized)) && !samePath(source, authorized)) {
		throw new BoundaryError("linked resource escapes the workspace or skill directory");
	}
	const stat = await fs.stat(authorized);
	if (!stat.isFile()) throw new BoundaryError("resource is not a file");
	return authorized;
}

export async function readPromptSource(filePath: string, cwd: string, sourcePath?: string): Promise<string> {
	const authorized = await resolvePromptSourcePath(filePath, cwd, sourcePath);
	try { return (await readFileBounded(authorized, MAX_PROMPT_SOURCE_BYTES)).toString("utf8"); }
	catch (error) {
		if (error instanceof FileSizeLimitError) throw new BoundaryError("prompt resource exceeds 1 MB");
		throw error;
	}
}
