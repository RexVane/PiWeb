/**
 * plugins-service：pi 包与扩展的清单、安装/卸载/更新/启用/停用（与 pi 运行时完全同步与持久化）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, getPackageManager, getResourceLoader, getSettingsManager, reloadAllLoaders, resourceLoaderReady } from "./pi";
import { reloadSessionsForCwd } from "./agent-manager";

export interface PackageView {
	source: string;
	scope: "user" | "project";
	installedPath?: string;
	resources: { extensions: number; skills: number; prompts: number; themes: number };
	disabled: boolean;
}

export interface ExtensionView {
	name: string;
	path: string;
	disabled: boolean;
	/** 加载失败的原因（语法错误、依赖缺失等），来自 pi 资源加载器 */
	error?: string;
}

/**
 * pi 的启用/停用语义（core/package-manager.js isEnabledByOverrides）：
 * settings.extensions 里 `-<path>` 强制排除、`+<path>` 强制包含，路径相对于该 settings 所在的基目录。
 * 之前 PiWeb 写的 disabledExtensions 键 pi 根本不读，开关是假的。
 */
function extensionPattern(extPath: string, baseDir: string): string {
	const rel = path.relative(baseDir, extPath).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") ? rel : extPath.replace(/\\/g, "/");
}

function isForceExcluded(extPath: string, patterns: string[], baseDir: string): boolean {
	const rel = path.relative(baseDir, extPath).replace(/\\/g, "/");
	const abs = extPath.replace(/\\/g, "/");
	const norm = (p: string) => (p.startsWith("./") ? p.slice(2) : p).replace(/\\/g, "/");
	return patterns.some((p) => p.startsWith("-") && [rel, abs].includes(norm(p.slice(1))));
}

/** 全部变更后的统一收尾：加载器就地重载 + 活跃会话 session.reload() + 广播新清单；全局变更影响所有目录 */
async function applyResourceChange(cwd: string, scope: "user" | "project"): Promise<void> {
	await reloadAllLoaders();
	await reloadSessionsForCwd(scope === "project" ? cwd : undefined);
}

async function readSettingsFile(filePath: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

async function writeSettingsFile(filePath: string, data: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8");
}

async function countResources(installedPath: string): Promise<PackageView["resources"]> {
	const out = { extensions: 0, skills: 0, prompts: 0, themes: 0 };
	const dirs: (keyof PackageView["resources"] | "prompts")[] = ["extensions", "skills", "prompts", "themes"];
	// 包可能直接就是资源目录，也可能带 src/dist；按约定目录统计
	const candidates = [installedPath, path.join(installedPath, "dist")];
	for (const base of candidates) {
		for (const d of dirs) {
			try {
				const entries = await fs.readdir(path.join(base, d), { withFileTypes: true });
				if (d === "extensions") {
					out.extensions += entries.filter((e) => e.isFile() && /\.(ts|js)$/.test(e.name)).length;
				} else if (d === "skills") {
					out.skills += entries.filter((e) => e.isDirectory()).length;
				} else if (d === "prompts") {
					out.prompts += entries.filter((e) => e.isFile() && /\.md$/.test(e.name)).length;
				} else if (d === "themes") {
					out.themes += entries.filter((e) => e.isFile() && /\.json$/.test(e.name)).length;
				}
			} catch {
				/* 目录不存在 */
			}
		}
	}
	return out;
}

export async function listPackages(cwd: string): Promise<PackageView[]> {
	const pm = getPackageManager(cwd);
	const configured = pm.listConfiguredPackages();

	const globalSettings = await readSettingsFile(path.join(getAgentDir(), "settings.json"));
	const projectSettings = await readSettingsFile(path.join(cwd, ".pi", "settings.json"));

	const sourceOf = (p: unknown): string => (typeof p === "string" ? p : String((p as { source?: string } | null)?.source ?? ""));
	const userDisabled = (Array.isArray(globalSettings.disabledPackages) ? globalSettings.disabledPackages : []).map(sourceOf).filter(Boolean);
	const projectDisabled = (Array.isArray(projectSettings.disabledPackages) ? projectSettings.disabledPackages : []).map(sourceOf).filter(Boolean);

	const out: PackageView[] = [];
	const seen = new Set<string>();

	// 1. 活跃配置包（已启用）
	for (const p of configured) {
		const key = `${p.scope}:${p.source}`;
		seen.add(key);
		const installedPath = p.installedPath ?? pm.getInstalledPath(p.source, p.scope);
		const resources = installedPath ? await countResources(installedPath) : { extensions: 0, skills: 0, prompts: 0, themes: 0 };
		out.push({ source: p.source, scope: p.scope, installedPath, resources, disabled: false });
	}

	// 2. 停用包（持久化在 disabledPackages）
	for (const source of projectDisabled) {
		const key = `project:${source}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const installedPath = pm.getInstalledPath(source, "project");
		const resources = installedPath ? await countResources(installedPath) : { extensions: 0, skills: 0, prompts: 0, themes: 0 };
		out.push({ source, scope: "project", installedPath, resources, disabled: true });
	}

	for (const source of userDisabled) {
		const key = `user:${source}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const installedPath = pm.getInstalledPath(source, "user");
		const resources = installedPath ? await countResources(installedPath) : { extensions: 0, skills: 0, prompts: 0, themes: 0 };
		out.push({ source, scope: "user", installedPath, resources, disabled: true });
	}

	return out;
}

export async function listLoadedExtensions(cwd: string): Promise<ExtensionView[]> {
	await resourceLoaderReady(cwd);
	const loader = getResourceLoader(cwd);
	const result = loader.getExtensions() as unknown as {
		extensions?: Array<{ path?: string; name?: string }>;
		errors?: Array<{ path: string; error: string }>;
	};
	const sm = getSettingsManager(cwd);
	const globalPatterns = sm.getGlobalSettings().extensions ?? [];
	const projectPatterns = sm.getProjectSettings().extensions ?? [];
	const agentDir = getAgentDir();
	const projectBase = path.join(cwd, ".pi");

	const out: ExtensionView[] = [];
	const seenPaths = new Set<string>();
	for (const e of result?.extensions ?? []) {
		const p = String(e.path ?? "");
		if (!p) continue;
		const name = String(e.name ?? path.basename(p).replace(/\.(ts|js)$/, ""));
		seenPaths.add(p);
		out.push({ name, path: p, disabled: false });
	}
	for (const err of result?.errors ?? []) {
		if (seenPaths.has(err.path)) continue;
		seenPaths.add(err.path);
		out.push({ name: path.basename(err.path).replace(/\.(ts|js)$/, ""), path: err.path, disabled: false, error: err.error });
	}
	// 被 `-path` 排除的扩展不会出现在 loader 结果里：从两份 settings 的模式里补出来，让用户能重新启用
	const excluded: Array<{ pattern: string; base: string }> = [
		...globalPatterns.filter((p) => p.startsWith("-")).map((p) => ({ pattern: p.slice(1), base: agentDir })),
		...projectPatterns.filter((p) => p.startsWith("-")).map((p) => ({ pattern: p.slice(1), base: projectBase })),
	];
	for (const { pattern, base } of excluded) {
		const abs = path.isAbsolute(pattern) ? pattern : path.resolve(base, pattern);
		if (seenPaths.has(abs)) continue;
		seenPaths.add(abs);
		out.push({ name: path.basename(abs).replace(/\.(ts|js)$/, ""), path: abs, disabled: true });
	}
	return out;
}

export async function togglePackage(
	source: string,
	disable: boolean,
	scope: "user" | "project",
	cwd: string
): Promise<void> {
	const settingsPath = scope === "project" ? path.join(cwd, ".pi", "settings.json") : path.join(getAgentDir(), "settings.json");
	const settings = await readSettingsFile(settingsPath);
	const sourceOf = (p: unknown) => (typeof p === "string" ? p : (p as { source?: string } | null)?.source);
	const packages: unknown[] = Array.isArray(settings.packages) ? settings.packages : [];
	// 停用的包原样存到 disabledPackages（PiWeb 私有键，pi 不读；保留对象形式的过滤配置，启用时原样放回）
	const disabledPackages: unknown[] = Array.isArray(settings.disabledPackages) ? settings.disabledPackages : [];

	if (disable) {
		const moved = packages.filter((p) => sourceOf(p) === source);
		settings.packages = packages.filter((p) => sourceOf(p) !== source);
		settings.disabledPackages = [...disabledPackages.filter((p) => sourceOf(p) !== source), ...(moved.length ? moved : [source])];
	} else {
		const restored = disabledPackages.filter((p) => sourceOf(p) === source);
		settings.disabledPackages = disabledPackages.filter((p) => sourceOf(p) !== source);
		settings.packages = packages.some((p) => sourceOf(p) === source) ? packages : [...packages, ...(restored.length ? restored : [source])];
	}
	await writeSettingsFile(settingsPath, settings);
	await applyResourceChange(cwd, scope);
}

export async function toggleExtension(
	extPath: string,
	disable: boolean,
	cwd: string
): Promise<void> {
	const norm = extPath.replace(/\\/g, "/").toLowerCase();
	const isProject = norm.startsWith(`${path.resolve(cwd).replace(/\\/g, "/").toLowerCase()}/`);
	const baseDir = isProject ? path.join(cwd, ".pi") : getAgentDir();
	const sm = getSettingsManager(cwd);
	const current = (isProject ? sm.getProjectSettings().extensions : sm.getGlobalSettings().extensions) ?? [];
	const pattern = extensionPattern(extPath, baseDir);
	const withoutOurs = current.filter((p) => !(p.startsWith("-") && [pattern, extPath.replace(/\\/g, "/")].includes((p.slice(1).startsWith("./") ? p.slice(3) : p.slice(1)).replace(/\\/g, "/"))));
	const next = disable ? [...withoutOurs, `-${pattern}`] : withoutOurs;
	if (!disable && isForceExcluded(extPath, next, baseDir)) {
		// 还有别的形式的排除模式（例如绝对路径），保留 pi 语义：再加一个 +path 强制包含也压不过 -path，直接删掉匹配项
		for (let i = next.length - 1; i >= 0; i -= 1) if (isForceExcluded(extPath, [next[i]], baseDir)) next.splice(i, 1);
	}
	if (isProject) sm.setProjectExtensionPaths(next);
	else sm.setExtensionPaths(next);
	await applyResourceChange(cwd, isProject ? "project" : "user");
}

export async function installPackage(source: string, local: boolean, cwd: string): Promise<void> {
	const pm = getPackageManager(cwd);
	await pm.installAndPersist(source, { local });
	await applyResourceChange(cwd, local ? "project" : "user");
}

export async function removePackage(source: string, local: boolean, cwd: string): Promise<boolean> {
	const pm = getPackageManager(cwd);
	const settingsPath = local ? path.join(cwd, ".pi", "settings.json") : path.join(getAgentDir(), "settings.json");
	const settings = await readSettingsFile(settingsPath);
	const sourceOf = (p: unknown) => (typeof p === "string" ? p : (p as { source?: string } | null)?.source);
	if (Array.isArray(settings.disabledPackages) && settings.disabledPackages.some((p) => sourceOf(p) === source)) {
		settings.disabledPackages = settings.disabledPackages.filter((p) => sourceOf(p) !== source);
		await writeSettingsFile(settingsPath, settings);
	}
	// 卸载失败必须让界面知道（之前这里把异常吞掉还返回成功）
	const removed = await pm.removeAndPersist(source, { local });
	await applyResourceChange(cwd, local ? "project" : "user");
	return removed;
}

export async function updatePackages(source: string | undefined, cwd: string): Promise<void> {
	const pm = getPackageManager(cwd);
	await pm.update(source);
	await applyResourceChange(cwd, "user");
}

/** 热重载全部扩展（pi /reload 等价物）：加载器 + 所有活跃会话 */
export async function reloadExtensions(cwd?: string): Promise<{ loaders: number; sessions: number }> {
	const loaders = (await reloadAllLoaders()).length;
	const sessions = await reloadSessionsForCwd(cwd);
	return { loaders, sessions };
}
