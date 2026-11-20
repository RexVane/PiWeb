/**
 * Manage user-owned prompt templates through Pi's public resource resolver.
 * Disabled templates remain discoverable. Toggles change the official prompts /
 * packages filters, never Markdown contents or a PiWeb-only enabled flag.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter, type ResolvedResource } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getPackageManager, getSettingsManager, reloadAllLoaders, resolveProjectTrust } from "./pi";
import { reloadSessionsForCwd } from "./agent-manager";
import { BoundaryError, isPathInside, samePath } from "./path-boundary";
import { resolveDiscoveredPath } from "./path-security";
import { invalidateJsonFile } from "./agent-config";
import { mutateJsoncSettingsFileSync, readJsoncSettingsObjectSync } from "./jsonc-settings-storage";
import { flushSettingsOrThrow, withSettingsWriteLock } from "./settings-write-lock";
import { readFileBounded } from "./read-file-bounded";
import { moveToTrash } from "./recycle-bin";
import type { PromptTemplateView } from "./prompt-template-view";

export const MAX_PROMPT_TEMPLATE_BYTES = 1024 * 1024;
const REFRESH_WARNING = "提示词模板更改已保存，资源刷新失败，请重载会话。";

async function resolveTemplates(cwd: string): Promise<ResolvedResource[]> {
	const manager = getSettingsManager(cwd);
	await flushSettingsOrThrow(manager);
	await manager.reload();
	await flushSettingsOrThrow(manager);
	manager.setProjectTrusted(resolveProjectTrust(cwd).trusted);
	// Catalog reads must not install packages or execute extension factories.
	return (await getPackageManager(cwd).resolve(async () => "skip")).prompts;
}

function findResource(resources: ResolvedResource[], filePath: string): ResolvedResource | undefined {
	return resources.find((resource) => samePath(resource.path, filePath));
}

async function authorizedResource(filePath: string, cwd: string): Promise<ResolvedResource> {
	if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.length > 4096 || path.extname(filePath) !== ".md") {
		throw new BoundaryError("Invalid prompt template path.");
	}
	const resources = await resolveTemplates(cwd);
	// Check spelling first to preserve the original link / declaration when removing.
	const declared = findResource(resources, filePath);
	if (declared) return declared;
	const canonical = await resolveDiscoveredPath(filePath, resources.map((resource) => resource.path));
	for (const resource of resources) {
		if (await fs.realpath(resource.path).then((value) => samePath(value, canonical), () => false)) return resource;
	}
	throw new BoundaryError("Prompt template is no longer configured; refresh the list.");
}

function sourceLabel(resource: ResolvedResource, cwd: string): string {
	if (resource.metadata.origin === "package") return resource.metadata.source.replace(/^npm:/, "");
	const directory = resource.metadata.baseDir || path.dirname(resource.path);
	for (const [root, label] of [[cwd, "."], [os.homedir(), "~"]]) {
		if (isPathInside(root, directory)) {
			const relative = path.relative(root, directory).replace(/\\/g, "/");
			return relative ? `${label}/${relative}` : label;
		}
	}
	return directory;
}

interface RemovalPlan {
	removed: string;
	link: boolean;
	managedRoot: string;
	expectedCanonical?: string;
}

/** Only remove a single Markdown entry in a personal/project prompt directory. */
async function removalPlan(resource: ResolvedResource, cwd: string): Promise<RemovalPlan> {
	if (resource.metadata.origin === "package" || resource.metadata.scope === "temporary") {
		throw new BoundaryError("Package or temporary templates cannot be deleted here; disable them instead.");
	}
	const target = await fs.realpath(resource.path);
	const cacheRoots = [path.join(getAgentDir(), "npm"), path.join(getAgentDir(), "git"), path.join(cwd, ".pi", "npm"), path.join(cwd, ".pi", "git")];
	for (const cache of cacheRoots) {
		const canonical = await fs.realpath(cache).catch(() => path.resolve(cache));
		if (isPathInside(canonical, target)) throw new BoundaryError("Package-managed templates must be disabled, not deleted.");
	}
	const targetKey = target.replace(/\\/g, "/");
	if ((process.platform === "win32" ? targetKey.toLowerCase() : targetKey).includes("/node_modules/")) {
		throw new BoundaryError("Package-managed templates must be disabled, not deleted.");
	}

	const roots = [path.join(getAgentDir(), "prompts"), path.join(cwd, ".pi", "prompts")];
	for (const rawRoot of roots) {
		if (!isPathInside(rawRoot, resource.path) || samePath(rawRoot, resource.path)) continue;
		const declaredParent = path.dirname(rawRoot);
		if (samePath(declaredParent, path.join(cwd, ".pi")) && (await fs.lstat(declaredParent)).isSymbolicLink()) {
			throw new BoundaryError("Project .pi directory must not be a link for template removal.");
		}
		const rootParent = await fs.realpath(declaredParent);
		const root = path.join(rootParent, path.basename(rawRoot));
		// Never follow a prompt-directory alias into another user's source tree.
		if ((await fs.lstat(root)).isSymbolicLink()) continue;
		const relative = path.relative(rawRoot, resource.path);
		let parent = root;
		for (const segment of path.dirname(relative).split(path.sep).filter((value) => value !== ".")) {
			parent = path.join(parent, segment);
			if ((await fs.lstat(parent)).isSymbolicLink()) throw new BoundaryError("Remove linked template directories from their original source.");
		}
		const physicalParent = await fs.realpath(parent);
		if (!isPathInside(root, physicalParent)) throw new BoundaryError("Template removal path changed; original files were retained.");
		const removed = path.join(physicalParent, path.basename(relative));
		const stat = await fs.lstat(removed);
		if (!stat.isSymbolicLink() && (!stat.isFile() || !samePath(await fs.realpath(removed), removed))) {
			throw new BoundaryError("Template removal path changed; original files were retained.");
		}
		return { removed, link: stat.isSymbolicLink(), managedRoot: root, ...(stat.isSymbolicLink() ? {} : { expectedCanonical: removed }) };
	}
	throw new BoundaryError("External templates must be removed from their original source; disable them here instead.");
}

export async function listPromptTemplates(cwd: string): Promise<PromptTemplateView[]> {
	const resources = await resolveTemplates(cwd);
	const templates: PromptTemplateView[] = [];
	for (const resource of resources) {
		let description = "";
		let argumentHint: string | undefined;
		let readError = false;
		try {
			const { frontmatter, body } = parseFrontmatter((await readFileBounded(resource.path, MAX_PROMPT_TEMPLATE_BYTES)).toString("utf8"));
			description = typeof frontmatter.description === "string" ? frontmatter.description : "";
			if (!description) {
				const first = body.split("\n").find((line) => line.trim()) || "";
				description = first.slice(0, 60) + (first.length > 60 ? "..." : "");
			}
			if (typeof frontmatter["argument-hint"] === "string") argumentHint = frontmatter["argument-hint"].slice(0, 400);
		} catch { readError = true; }
		const canDelete = await removalPlan(resource, cwd).then(() => true, () => false);
		templates.push({
			name: path.basename(resource.path).replace(/\.md$/, ""), description: description.slice(0, 1000),
			...(argumentHint ? { argumentHint } : {}), filePath: resource.path,
			scope: resource.metadata.scope, origin: resource.metadata.origin,
			sourceLabel: sourceLabel(resource, cwd), disabled: !resource.enabled,
			canToggle: resource.metadata.scope === "user" || resource.metadata.scope === "project", canDelete,
			...(readError ? { readError: true } : {}),
		});
	}
	return templates.sort((a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath));
}

export async function readPromptTemplate(filePath: string, cwd: string): Promise<string> {
	const resource = await authorizedResource(filePath, cwd);
	return (await readFileBounded(resource.path, MAX_PROMPT_TEMPLATE_BYTES)).toString("utf8");
}

function patternsOf(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new BoundaryError("Prompt filters must be an array of strings.");
	return value;
}

function patternPath(value: string, baseDir: string): string {
	const home = os.homedir();
	const expanded = value === "~" ? home : /^~[\\/]/.test(value) ? path.join(home, value.slice(2)) : value;
	return path.resolve(baseDir, expanded);
}

/** Keep source declarations / glob filters; replace only this file's exact overrides. */
function overridePatterns(current: string[], file: string, baseDir: string, disabled: boolean): string[] {
	const rest = current.filter((entry) => {
		if (!/^[+!-]/.test(entry)) return true;
		return !samePath(patternPath(entry.slice(1), baseDir), file);
	});
	const relative = path.relative(baseDir, file).replace(/\\/g, "/");
	const pattern = relative && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative) ? relative : file.replace(/\\/g, "/");
	return [...rest, `${disabled ? "-" : "+"}${pattern}`];
}

function sameDeclaration(left: ResolvedResource, right: ResolvedResource): boolean {
	return left.metadata.scope === right.metadata.scope && left.metadata.origin === right.metadata.origin
		&& left.metadata.source === right.metadata.source && left.metadata.baseDir === right.metadata.baseDir;
}

async function refreshSavedTemplates(cwd: string, scope: string): Promise<{ warning?: string }> {
	let failed = false;
	try { await reloadAllLoaders(); } catch { failed = true; }
	try { await reloadSessionsForCwd(scope === "project" ? cwd : undefined); } catch { failed = true; }
	return failed ? { warning: REFRESH_WARNING } : {};
}

export async function setPromptTemplateDisabled(filePath: string, disabled: boolean, cwd: string): Promise<{ changed: boolean; warning?: string }> {
	const resource = await authorizedResource(filePath, cwd);
	if (resource.metadata.scope !== "user" && resource.metadata.scope !== "project") throw new BoundaryError("Temporary templates cannot be toggled in settings.");
	const isProject = resource.metadata.scope === "project";
	const baseDir = isProject ? path.join(cwd, ".pi") : getAgentDir();
	const file = path.join(baseDir, "settings.json");
	const boundary = isProject ? { projectRoot: cwd } : undefined;
	const changed = await withSettingsWriteLock(file, async () => {
		readJsoncSettingsObjectSync(file, boundary); // Invalid JSON or project links must never be overwritten.
		const fresh = findResource(await resolveTemplates(cwd), resource.path);
		if (!fresh || !sameDeclaration(resource, fresh)) throw new BoundaryError("Template configuration changed; refresh the list.");
		if (fresh.enabled === !disabled) return false;
		mutateJsoncSettingsFileSync(file, (settings) => {
			if (fresh.metadata.origin === "top-level") {
				return { ...settings, prompts: overridePatterns(patternsOf(settings.prompts), fresh.path, fresh.metadata.baseDir || baseDir, disabled) };
			}
			if (!Array.isArray(settings.packages)) throw new BoundaryError("Template package is no longer configured.");
			let found = false;
			const packages = settings.packages.map((entry: unknown) => {
				const source = typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
				if (source !== fresh.metadata.source) return entry;
				found = true;
				const pkg: Record<string, unknown> = typeof entry === "string" ? { source: entry } : entry as Record<string, unknown>;
				const current = patternsOf(pkg.prompts);
				const packageRoot = fresh.metadata.baseDir || fresh.metadata.packageRoot;
				if (!packageRoot) throw new BoundaryError("Template package root is unavailable.");
				// [] means load none, unlike an omitted filter. Enabling one must not enable all siblings.
				const relative = path.relative(packageRoot, fresh.path).replace(/\\/g, "/");
				const prompts = Array.isArray(pkg.prompts) && current.length === 0 && pkg.autoload !== false && !disabled
					? [relative] : overridePatterns(current, fresh.path, packageRoot, disabled);
				return { ...pkg, prompts };
			});
			if (!found) throw new BoundaryError("Template package is no longer configured.");
			return { ...settings, packages };
		}, boundary);
		invalidateJsonFile(file);
		const updated = findResource(await resolveTemplates(cwd), fresh.path);
		if (!updated || updated.enabled === disabled) throw new Error("Prompt template enabled state was not applied by Pi.");
		return true;
	});
	return changed ? { changed, ...await refreshSavedTemplates(cwd, resource.metadata.scope) } : { changed };
}

export async function previewDeletePromptTemplate(filePath: string, cwd: string): Promise<{ removed: string; link: boolean }> {
	const plan = await removalPlan(await authorizedResource(filePath, cwd), cwd);
	return { removed: plan.removed, link: plan.link };
}

export async function deletePromptTemplate(filePath: string, cwd: string, expectedPath: string): Promise<{ removed: string; warning?: string }> {
	const resource = await authorizedResource(filePath, cwd);
	const plan = await removalPlan(resource, cwd);
	if (!samePath(expectedPath, plan.removed)) throw new BoundaryError("Template removal path changed; review it again.");
	const result = await moveToTrash(plan.removed, { managedRoot: plan.managedRoot, expectedLink: plan.link, expectedCanonical: plan.expectedCanonical, expectedKind: "file" });
	return { removed: result.removed, ...await refreshSavedTemplates(cwd, resource.metadata.scope) };
}
