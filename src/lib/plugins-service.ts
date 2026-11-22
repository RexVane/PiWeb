/**
 * plugins-service：pi 包与扩展的清单、安装/卸载/更新/启用/停用（与 pi 运行时完全同步与持久化）。
 */
import path from "node:path";
import type { ResolvedResource, SourceInfo } from "@earendil-works/pi-coding-agent";
import { invalidateJsonFile, readJsonObjectFresh, readJsonObjectSafe } from "./agent-config";
import { mutateJsoncSettingsFileSync, readJsoncSettingsObjectSync } from "./jsonc-settings-storage";
import { getAgentDir, getPackageManager, getResourceLoader, getSettingsManager, reloadAllLoaders, resourceLoaderReady } from "./pi";
import { reloadSessionsForCwd } from "./agent-manager";
import { flushSettingsOrThrow, withExternalSettingsLock, withSettingsWriteLock } from "./settings-write-lock";
import { validatePackageSource } from "./package-manager-safe";
import { beginNpmSettingsWrite, finishNpmTrashCleanup, NpmTransactionCommittedError, NpmUninstallTrashPendingError, recoverNpmPrefix, withNpmInstallTransaction, type NpmTransactionPlan } from "./npm-install-transaction";
import { mergeResourceSelection } from "./resources/selection";
import type { ResourceSelection } from "./resources/protocol";
import { resolveModelPath } from "./path-security";

/** 包内提供的资源类型：给「来源=包」打标签用，与 pi manifest 的四类资源一致 */
export type PluginResourceType = "extensions" | "skills" | "prompts" | "themes";

export interface PackageView {
	source: string;
	scope: "user" | "project";
	installedPath?: string;
	resources: { extensions: number; skills: number; prompts: number; themes: number };
	/** resources 里非零的类型（扩展 / 技能 / 提示词 / 主题），界面用它当标签 */
	types: PluginResourceType[];
	disabled: boolean;
}

export interface ExtensionView {
	name: string;
	path: string;
	disabled: boolean;
	/**
	 * 作用域：这条声明落在哪一层。内置扩展默认 user（个人 settings），
	 * 项目 settings 里有 `+builtin:x` / `-builtin:x` 覆盖时才是 project。
	 */
	scope: "user" | "project" | "temporary";
	/** 来源：builtin=随 pi 发版；top-level=目录发现或 settings 显式声明；package=pi 包带入 */
	origin: "builtin" | "top-level" | "package";
	/** SDK 配置来源，不能从文件所在位置推断包身份或写入作用域。 */
	sourceInfo?: SourceInfo;
	/** 加载失败的原因（语法错误、依赖缺失等），来自 pi 资源加载器 */
	error?: string;
}

export class ExtensionToggleError extends Error {}
export class ResourceRefreshError extends Error {
	readonly applied = true;
	readonly warningCode?: "PACKAGE_TRASH_PENDING";
	constructor(message: string, options?: ErrorOptions & { warningCode?: "PACKAGE_TRASH_PENDING" }) {
		super(message, options);
		this.warningCode = options?.warningCode;
	}
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

/** SDK 内置扩展的路径前缀（builtin:mcp / builtin:codemode / builtin:tool-search） */
const BUILTIN_PREFIX = "builtin:";

/** settings.extensions 里针对这个内置扩展的 +/-/! 覆盖项 */
const isBuiltinOverride = (pattern: string, extPath: string) => /^[+!-]/.test(pattern) && pattern.slice(1) === extPath;

function resourcePathKey(value: string): string {
	const normalized = path.resolve(value).replace(/\\/g, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function resolveExtensions(cwd: string): Promise<ResolvedResource[]> {
	// Resolving disabled resources gives us their configuration origin too. Reading
	// the catalog must never install missing packages as a side effect.
	return (await getPackageManager(cwd).resolve(async () => "skip")).extensions;
}

function findExtension(resources: ResolvedResource[], extPath: string): ResolvedResource | undefined {
	const key = resourcePathKey(extPath);
	return resources.find((resource) => resourcePathKey(resource.path) === key);
}

function sourceInfoFor(resource: ResolvedResource): SourceInfo {
	return { path: resource.path, ...resource.metadata };
}

function assertStandaloneExtension(resource: ResolvedResource | undefined): asserts resource is ResolvedResource {
	if (!resource) throw new ExtensionToggleError("Extension is no longer configured; refresh the plugin list.");
	if (resource.metadata.origin === "package") {
		throw new ExtensionToggleError(`This extension belongs to ${resource.metadata.source}; use the whole-package toggle.`);
	}
	if (resource.metadata.scope !== "user" && resource.metadata.scope !== "project") {
		throw new ExtensionToggleError("Temporary extensions cannot be toggled in settings.");
	}
}

/** 全部变更后的统一收尾：加载器就地重载 + 活跃会话 session.reload() + 广播新清单；全局变更影响所有目录 */
async function applyResourceChange(cwd: string, scope: "user" | "project"): Promise<void> {
	const failures: unknown[] = [];
	const collectFailure = (error: unknown) => failures.push(...(error instanceof AggregateError ? error.errors : [error]));
	// Revocation must not depend on a successful loader/session refresh.
	try { await reloadAllLoaders(); } catch (error) { collectFailure(error); }
	try { await reloadSessionsForCwd(scope === "project" ? cwd : undefined); } catch (error) { collectFailure(error); }
	if (failures.length) throw new ResourceRefreshError("更改已保存，但资源刷新失败；请刷新列表或重载会话。", { cause: new AggregateError(failures) });
}

/** npm/git share their scope's install prefix across sources and processes. */
async function withPackageInstallLock<T>(cwd: string, local: boolean, operation: () => Promise<T>): Promise<T> {
	const root = local ? path.join(cwd, ".pi") : getAgentDir();
	if (local) readJsoncSettingsObjectSync(path.join(root, "settings.json"), { projectRoot: cwd });
	recoverNpmPrefix(path.join(root, "npm"), local ? cwd : undefined, npmRecoveryScopes(cwd));
	await finishNpmTrashCleanup(npmRecoveryScopes(cwd));
	const lockPath = path.join(root, "piweb-package-install");
	return withSettingsWriteLock(lockPath, () => withExternalSettingsLock(lockPath, operation));
}
const npmRecoveryScopes = (cwd: string): NpmTransactionPlan[] => [{ root: path.join(getAgentDir(), "npm") }, { root: path.join(cwd, ".pi", "npm"), projectRoot: cwd }];

type PackageManagerInternals = {
	packageSourcesMatch(existing: unknown, source: string, scope: string): boolean;
	parseSource(source: string): { type: string; pinned?: boolean };
	resolvePathFromBase(source: string, baseDir: string): string;
};
const sourceOfPackage = (value: unknown): string => typeof value === "string" ? value : String((value as { source?: unknown } | null)?.source ?? "");
/** Pi stores local sources relative to their settings directory, but SDK inputs are cwd-relative. */
function configuredPackageInput(pm: PackageManagerInternals, source: string, settingsPath: string, entries: readonly unknown[]): string {
	if (!entries.some((entry) => sourceOfPackage(entry) === source) || pm.parseSource(source).type !== "local") return source;
	if (typeof pm.resolvePathFromBase !== "function") throw new Error("This pi SDK cannot resolve configured local package sources.");
	// Resolve the declaration even when its source directory no longer exists.
	return pm.resolvePathFromBase(source, path.dirname(settingsPath));
}
async function npmMutationPlan(pm: ReturnType<typeof getPackageManager>, cwd: string, local: boolean, source: string, remove: boolean, selection?: ResourceSelection): Promise<NpmTransactionPlan> {
	const file = local ? path.join(cwd, ".pi", "settings.json") : path.join(getAgentDir(), "settings.json");
	const current = await readSettingsFileStrict(file);
	const internal = pm as unknown as PackageManagerInternals;
	if (typeof internal.packageSourcesMatch !== "function") throw new Error("This pi SDK cannot prepare a safe npm settings transaction.");
	const before = Array.isArray(current.packages) ? current.packages : [];
	const scope = local ? "project" : "user";
	let packages: unknown[];
	if (remove) packages = before.filter((entry) => !internal.packageSourcesMatch(entry, source, scope));
	else {
		packages = [...before];
		const index = packages.findIndex((entry) => internal.packageSourcesMatch(entry, source, scope));
		if (index === -1) packages.push(selection ? mergeResourceSelection(undefined, source, selection) : source);
		else packages[index] = selection ? mergeResourceSelection(packages[index], source, selection) : typeof packages[index] === "string" ? source : { ...(packages[index] as object), source };
	}
	const after = { ...(!remove || Object.hasOwn(current, "packages") || packages.length ? { packages } : {}), ...(Object.hasOwn(current, "disabledPackages") ? { disabledPackages: remove && Array.isArray(current.disabledPackages) ? current.disabledPackages.filter((entry) => sourceOfPackage(entry) !== source) : current.disabledPackages } : {}) };
	return { root: path.join(path.dirname(file), "npm"), ...(local ? { projectRoot: cwd } : {}), settings: { file, ...(local ? { projectRoot: cwd } : {}), after }, ...(remove ? { recyclePrevious: true } : {}) };
}
async function runNpmMutation<T>(plans: NpmTransactionPlan[], sm: ReturnType<typeof getSettingsManager>, operation: () => Promise<T>): Promise<T> {
	try { return await withNpmInstallTransaction(plans, operation); }
	catch (error) {
		// SDK setters update memory before persistence. Rejoin the recovered disk
		// state after a failed transaction instead of retaining a phantom package.
		await sm.reload(); sm.drainErrors();
		if (error instanceof NpmTransactionCommittedError) throw new ResourceRefreshError(error.message, { cause: error, ...(error instanceof NpmUninstallTrashPendingError ? { warningCode: "PACKAGE_TRASH_PENDING" as const } : {}) });
		throw error;
	}
}

async function readSettingsFile(filePath: string): Promise<Record<string, unknown>> {
	return readJsonObjectSafe(filePath);
}

/** 只用在写路径（预检、改写、落盘核对）：SDK 刚 flush 过的文件不能拿缓存里的旧版来判断 */
async function readSettingsFileStrict(filePath: string): Promise<Record<string, unknown>> {
	return readJsonObjectFresh(filePath);
}

async function prepareSettingsWrite(cwd: string, file: string): Promise<ReturnType<typeof getSettingsManager>> {
	await readSettingsFileStrict(file);
	const manager = getSettingsManager(cwd);
	await flushSettingsOrThrow(manager);
	// Another cwd's manager may have changed the same global array since our last read.
	await manager.reload();
	await flushSettingsOrThrow(manager);
	return manager;
}

async function verifySettingsField(file: string, field: "extensions" | "packages", expected: unknown): Promise<void> {
	const persisted = await readSettingsFileStrict(file);
	if (JSON.stringify(persisted[field] ?? []) !== JSON.stringify(expected ?? [])) {
		throw new Error(`Pi settings ${field} was not persisted`);
	}
}

async function countResources(installedPath: string, pm: ReturnType<typeof getPackageManager>): Promise<PackageView["resources"]> {
	// An absolute installed path is resolved locally without installation or
	// loading extension code. The SDK applies manifests, globs and conventions.
	const resources = await pm.resolveExtensionSources([path.resolve(installedPath)], { temporary: true });
	return {
		extensions: resources.extensions.length,
		skills: resources.skills.length,
		prompts: resources.prompts.length,
		themes: resources.themes.length,
	};
}

/** resources 计数 → 类型标签（顺序固定，界面不用再排） */
function packageTypes(resources: PackageView["resources"]): PluginResourceType[] {
	const out: PluginResourceType[] = [];
	if (resources.extensions > 0) out.push("extensions");
	if (resources.skills > 0) out.push("skills");
	if (resources.prompts > 0) out.push("prompts");
	if (resources.themes > 0) out.push("themes");
	return out;
}

/**
 * 作用域与来源：与 skills-service 的 resolvePlacement 同一套口径 —— 有 SDK metadata 就照用，
 * 没有才按位置回退。内置扩展没有 SourceInfo，只能看项目 settings 里有没有针对它的 ±/! 覆盖。
 */
function extensionPlacement(
	extPath: string,
	sourceInfo: SourceInfo | undefined,
	projectPatterns: string[],
	cwd: string,
): Pick<ExtensionView, "scope" | "origin"> {
	if (extPath.startsWith(BUILTIN_PREFIX)) {
		const overridden = projectPatterns.some((pattern) => isBuiltinOverride(pattern, extPath));
		return { scope: overridden ? "project" : "user", origin: "builtin" };
	}
	if (sourceInfo) {
		return { scope: sourceInfo.scope, origin: sourceInfo.origin === "package" ? "package" : "top-level" };
	}
	// 没有 metadata（加载失败的条目）：按位置回退，工作区内算项目级
	const rel = path.relative(path.resolve(cwd), path.resolve(extPath));
	const inProject = Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
	return { scope: inProject ? "project" : "user", origin: "top-level" };
}

export async function listPackages(cwd: string): Promise<PackageView[]> {
	const pm = getPackageManager(cwd);
	recoverNpmPrefix(path.join(getAgentDir(), "npm"), undefined, npmRecoveryScopes(cwd));
	recoverNpmPrefix(path.join(cwd, ".pi", "npm"), cwd, npmRecoveryScopes(cwd));
	await finishNpmTrashCleanup(npmRecoveryScopes(cwd));
	await getSettingsManager(cwd).reload();
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
		const resources = installedPath ? await countResources(installedPath, pm) : { extensions: 0, skills: 0, prompts: 0, themes: 0 };
		out.push({ source: p.source, scope: p.scope, installedPath, resources, types: packageTypes(resources), disabled: false });
	}

	// 2. 停用包（持久化在 disabledPackages）
	for (const source of projectDisabled) {
		const key = `project:${source}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const installedPath = pm.getInstalledPath(source, "project");
		const resources = installedPath ? await countResources(installedPath, pm) : { extensions: 0, skills: 0, prompts: 0, themes: 0 };
		out.push({ source, scope: "project", installedPath, resources, types: packageTypes(resources), disabled: true });
	}

	for (const source of userDisabled) {
		const key = `user:${source}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const installedPath = pm.getInstalledPath(source, "user");
		const resources = installedPath ? await countResources(installedPath, pm) : { extensions: 0, skills: 0, prompts: 0, themes: 0 };
		out.push({ source, scope: "user", installedPath, resources, types: packageTypes(resources), disabled: true });
	}


	return out;
}

export async function listLoadedExtensions(cwd: string): Promise<ExtensionView[]> {
	await resourceLoaderReady(cwd);
	const loader = getResourceLoader(cwd);
	const result = loader.getExtensions() as unknown as {
		extensions?: Array<{ path?: string; name?: string; sourceInfo?: SourceInfo }>;
		errors?: Array<{ path: string; error: string }>;
	};
	const sm = getSettingsManager(cwd);
	const projectPatterns = sm.getProjectSettings().extensions ?? [];
	const resolved = await resolveExtensions(cwd);

	const out: ExtensionView[] = [];
	const seenPaths = new Set<string>();
	for (const e of result?.extensions ?? []) {
		const p = String(e.path ?? "");
		if (!p) continue;
		const name = p.startsWith(BUILTIN_PREFIX) ? p.slice(BUILTIN_PREFIX.length) : String(e.name ?? path.basename(p).replace(/\.(ts|js)$/, ""));
		seenPaths.add(resourcePathKey(p));
		const resource = findExtension(resolved, p);
		const sourceInfo = e.sourceInfo?.origin === "package" ? e.sourceInfo : resource ? sourceInfoFor(resource) : e.sourceInfo;
		out.push({
			name,
			path: p,
			disabled: false,
			...extensionPlacement(p, sourceInfo, projectPatterns, cwd),
			...(p.startsWith(BUILTIN_PREFIX) ? {} : { sourceInfo }),
		});
	}
	for (const err of result?.errors ?? []) {
		if (seenPaths.has(resourcePathKey(err.path))) continue;
		seenPaths.add(resourcePathKey(err.path));
		const resource = findExtension(resolved, err.path);
		const sourceInfo = resource && sourceInfoFor(resource);
		out.push({
			name: path.basename(err.path).replace(/\.(ts|js)$/, ""),
			path: err.path,
			disabled: false,
			error: err.error,
			...extensionPlacement(err.path, sourceInfo, projectPatterns, cwd),
			sourceInfo,
		});
	}
	// The SDK returns disabled entries, including wildcard exclusions and package
	// filters, with the same metadata used for enabled entries.
	for (const resource of resolved) {
		if (resource.enabled || seenPaths.has(resourcePathKey(resource.path))) continue;
		seenPaths.add(resourcePathKey(resource.path));
		const sourceInfo = sourceInfoFor(resource);
		out.push({
			name: path.basename(resource.path).replace(/\.(ts|js)$/, ""),
			path: resource.path,
			disabled: true,
			...extensionPlacement(resource.path, sourceInfo, projectPatterns, cwd),
			sourceInfo,
		});
	}
	// PiWeb's package manager does not own builtin factories. Their exclusion keys
	// are synthetic identifiers; project overrides take precedence over global ones.
	const builtinPatterns = [...(sm.getGlobalSettings().extensions ?? []), ...projectPatterns];
	for (const entry of builtinPatterns) {
		const p = entry.slice(1);
		if (!entry.startsWith("-") || !p.startsWith(BUILTIN_PREFIX) || seenPaths.has(resourcePathKey(p))) continue;
		seenPaths.add(resourcePathKey(p));
		out.push({
			name: p.slice(BUILTIN_PREFIX.length),
			path: p,
			disabled: true,
			...extensionPlacement(p, undefined, projectPatterns, cwd),
			sourceInfo: {
				path: p, source: "builtin", origin: "top-level", scope: projectPatterns.some((pattern) => isBuiltinOverride(pattern, p)) ? "project" : "user",
			},
		});
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
	await withSettingsWriteLock(settingsPath, async () => {
		// 直接改文件之前先让 SettingsManager 把还没落盘的改动写完：不然它稍后落盘时
		// 会拿内存里的旧 packages 盖掉这次的修改（写完后 applyResourceChange 会让所有实例重新读盘）
		await prepareSettingsWrite(cwd, settingsPath);
		movePackage(settingsPath, source, disable);
	});
	await applyResourceChange(cwd, scope);
}

function movePackage(settingsPath: string, source: string, disable: boolean): void {
	mutateJsoncSettingsFileSync(settingsPath, (settings) => {
		const sourceOf = (p: unknown) => (typeof p === "string" ? p : (p as { source?: string } | null)?.source);
		const packages: unknown[] = Array.isArray(settings.packages) ? settings.packages : [];
		// 停用的包原样存到 disabledPackages（PiWeb 私有键，pi 不读）
		const disabledPackages: unknown[] = Array.isArray(settings.disabledPackages) ? settings.disabledPackages : [];
		if (![...packages, ...disabledPackages].some((p) => sourceOf(p) === source)) {
			throw new ExtensionToggleError("Package is not configured in this scope; refresh the plugin list.");
		}
		if (disable) {
			const moved = packages.filter((p) => sourceOf(p) === source);
			settings.packages = packages.filter((p) => sourceOf(p) !== source);
			settings.disabledPackages = [...disabledPackages.filter((p) => sourceOf(p) !== source), ...(moved.length ? moved : [source])];
		} else {
			const restored = disabledPackages.filter((p) => sourceOf(p) === source);
			settings.disabledPackages = disabledPackages.filter((p) => sourceOf(p) !== source);
			settings.packages = packages.some((p) => sourceOf(p) === source) ? packages : [...packages, ...(restored.length ? restored : [source])];
		}
		return settings;
	});
	invalidateJsonFile(settingsPath);
}

/**
 * 内置扩展的开关，与 `pi config` 一致：默认写全局 settings 的 `-builtin:<name>`。
 * 项目 settings 已经有这一项的 +/-/! 覆盖时改项目那条（项目覆盖优先于全局），并写成显式的 +/-，才盖得过全局。
 */
async function toggleBuiltinExtension(extPath: string, disable: boolean, cwd: string): Promise<void> {
	const manager = getSettingsManager(cwd);
	await flushSettingsOrThrow(manager);
	await manager.reload();
	const isProject = (manager.getProjectSettings().extensions ?? []).some((p) => isBuiltinOverride(p, extPath));
	const settingsPath = isProject ? path.join(cwd, ".pi", "settings.json") : path.join(getAgentDir(), "settings.json");
	await withSettingsWriteLock(settingsPath, async () => {
		const sm = await prepareSettingsWrite(cwd, settingsPath);
		const current = (isProject ? sm.getProjectSettings().extensions : sm.getGlobalSettings().extensions) ?? [];
		const rest = current.filter((p) => !isBuiltinOverride(p, extPath));
		const next = isProject ? [...rest, `${disable ? "-" : "+"}${extPath}`] : disable ? [...rest, `-${extPath}`] : rest;
		if (isProject) sm.setProjectExtensionPaths(next);
		else sm.setExtensionPaths(next);
		await flushSettingsOrThrow(sm);
		await verifySettingsField(settingsPath, "extensions", next);
	});
	await applyResourceChange(cwd, isProject ? "project" : "user");
}

export async function toggleExtension(
	extPath: string,
	disable: boolean,
	cwd: string
): Promise<void> {
	if (extPath.startsWith(BUILTIN_PREFIX)) return toggleBuiltinExtension(extPath, disable, cwd);
	const manager = getSettingsManager(cwd);
	await flushSettingsOrThrow(manager);
	await manager.reload();
	const resource = findExtension(await resolveExtensions(cwd), extPath);
	assertStandaloneExtension(resource);
	const isProject = resource.metadata.scope === "project";
	const baseDir = isProject ? path.join(cwd, ".pi") : getAgentDir();
	const settingsPath = isProject ? path.join(cwd, ".pi", "settings.json") : path.join(getAgentDir(), "settings.json");
	await withSettingsWriteLock(settingsPath, async () => {
		const sm = await prepareSettingsWrite(cwd, settingsPath);
		const currentResource = findExtension(await resolveExtensions(cwd), extPath);
		assertStandaloneExtension(currentResource);
		if (currentResource.metadata.scope !== resource.metadata.scope) {
			throw new ExtensionToggleError("Extension configuration changed; refresh the plugin list.");
		}
		const current = (isProject ? sm.getProjectSettings().extensions : sm.getGlobalSettings().extensions) ?? [];
		const pattern = extensionPattern(currentResource.path, baseDir);
		const withoutOurs = current.filter((p) => !(/^[+-]/.test(p) && resourcePathKey(path.resolve(baseDir, p.slice(1))) === resourcePathKey(currentResource.path)));
		// An explicit + also enables resources excluded by an existing !glob, while
		// preserving that glob for the other resources it controls.
		const next = [...withoutOurs, `${disable ? "-" : "+"}${pattern}`];
		if (isProject) sm.setProjectExtensionPaths(next);
		else sm.setExtensionPaths(next);
		await flushSettingsOrThrow(sm);
		await verifySettingsField(settingsPath, "extensions", next);
		const updated = findExtension(await resolveExtensions(cwd), currentResource.path);
		if (!updated || updated.enabled === disable) throw new Error("Extension enabled state was not applied by Pi.");
	});
	await applyResourceChange(cwd, isProject ? "project" : "user");
}

export async function installPackage(source: string, local: boolean, cwd: string, selection?: ResourceSelection): Promise<void> {
	validatePackageSource(source);
	if (selection && !/^(?:npm:|git[^:]*:|https?:\/\/)/.test(source)) source = resolveModelPath(source, cwd);
	const pm = getPackageManager(cwd);
	const settingsPath = local ? path.join(cwd, ".pi", "settings.json") : path.join(getAgentDir(), "settings.json");
	await withPackageInstallLock(cwd, local, () => withSettingsWriteLock(settingsPath, async () => {
		const sm = await prepareSettingsWrite(cwd, settingsPath);
		const before = (local ? sm.getProjectSettings() : sm.getGlobalSettings()).packages ?? [];
		const install = async () => {
			if (!selection) await pm.installAndPersist(source, { local });
			else {
				// Acquire files without ever briefly enabling the whole collection in settings.
				await pm.install(source, { local });
				const installedPath = pm.getInstalledPath(source, local ? "project" : "user");
				if (!installedPath) throw new ExtensionToggleError("Cannot resolve the resource collection");
				const resources = await pm.resolveExtensionSources([path.resolve(installedPath)], { temporary: true });
				for (const type of ["extensions", "skills", "prompts", "themes"] as const) for (const value of selection[type]) {
					const target = path.resolve(installedPath, value);
					if (!resources[type].some((resource) => resourcePathKey(resource.path) === resourcePathKey(target)
						|| type === "skills" && path.basename(resource.path) === "SKILL.md" && resourcePathKey(path.dirname(resource.path)) === resourcePathKey(target))) {
						throw new ExtensionToggleError("Selection is not declared by the Pi package");
					}
				}
				const internal = pm as unknown as PackageManagerInternals;
				const next = [...before];
				const index = next.findIndex((entry) => internal.packageSourcesMatch(entry, source, local ? "project" : "user"));
				const merged = mergeResourceSelection(index < 0 ? undefined : next[index], source, selection);
				if (index < 0) next.push(merged as never); else next[index] = merged as never;
				if (source.startsWith("npm:")) beginNpmSettingsWrite(path.join(path.dirname(settingsPath), "npm"));
				if (local) sm.setProjectPackages(next); else sm.setPackages(next);
			}
			await flushSettingsOrThrow(sm);
			await verifySettingsField(settingsPath, "packages", (local ? sm.getProjectSettings() : sm.getGlobalSettings()).packages);
		};
		if (source.startsWith("npm:")) await runNpmMutation([await npmMutationPlan(pm, cwd, local, source, false, selection)], sm, install);
		else await install();
	}));
	await applyResourceChange(cwd, local ? "project" : "user");
}

export async function removePackage(source: string, local: boolean, cwd: string): Promise<boolean> {
	validatePackageSource(source);
	const pm = getPackageManager(cwd);
	const settingsPath = local ? path.join(cwd, ".pi", "settings.json") : path.join(getAgentDir(), "settings.json");
	const removed = await withPackageInstallLock(cwd, local, () => withSettingsWriteLock(settingsPath, async () => {
		const sm = await prepareSettingsWrite(cwd, settingsPath);
		const settings = await readSettingsFileStrict(settingsPath);
		const active = Array.isArray(settings.packages) ? settings.packages : [];
		const disabled = Array.isArray(settings.disabledPackages) ? settings.disabledPackages : [];
		const internal = pm as unknown as PackageManagerInternals;
		const sdkSource = configuredPackageInput(internal, source, settingsPath, [...active, ...disabled]);
		const matches = (entry: unknown) => internal.packageSourcesMatch(entry, sdkSource, local ? "project" : "user");
		if (!active.some(matches) && !disabled.some(matches)) return false;
		const remove = async () => {
		// SDK failures must surface before touching the disabled-package bookkeeping.
		const removedActive = await pm.removeAndPersist(sdkSource, { local });
		await flushSettingsOrThrow(sm);
		await verifySettingsField(settingsPath, "packages", (local ? sm.getProjectSettings() : sm.getGlobalSettings()).packages);
		let removedDisabled = false;
		if (source.startsWith("npm:")) beginNpmSettingsWrite(path.join(path.dirname(settingsPath), "npm"));
		mutateJsoncSettingsFileSync(settingsPath, (settings) => {
			if (Array.isArray(settings.disabledPackages) && settings.disabledPackages.some(matches)) {
				settings.disabledPackages = settings.disabledPackages.filter((entry) => !matches(entry));
				removedDisabled = true;
				return settings;
			}
			return undefined;
		});
		if (removedDisabled) invalidateJsonFile(settingsPath);
		return removedActive || removedDisabled;
		};
		return source.startsWith("npm:") ? runNpmMutation([await npmMutationPlan(pm, cwd, local, source, true)], sm, remove) : remove();
	}));
	await applyResourceChange(cwd, local ? "project" : "user");
	return removed;
}

export async function updatePackages(source: string | undefined, cwd: string): Promise<void> {
	if (source !== undefined) validatePackageSource(source);
	const pm = getPackageManager(cwd);
	await withPackageInstallLock(cwd, false, () => withPackageInstallLock(cwd, true, () =>
		withSettingsWriteLock(path.join(getAgentDir(), "settings.json"), async () => {
			const sm = await prepareSettingsWrite(cwd, path.join(getAgentDir(), "settings.json"));
			const internal = pm as unknown as PackageManagerInternals;
			const plans: NpmTransactionPlan[] = [];
			for (const local of [false, true]) {
				const packages = (local ? sm.getProjectSettings() : sm.getGlobalSettings()).packages ?? [];
				if (!packages.some((entry) => {
					const value = sourceOfPackage(entry);
					if (!value.startsWith("npm:") || (source && !internal.packageSourcesMatch(entry, source, local ? "project" : "user"))) return false;
					return !internal.parseSource(value).pinned;
				})) continue;
				plans.push({ root: local ? path.join(cwd, ".pi", "npm") : path.join(getAgentDir(), "npm"), ...(local ? { projectRoot: cwd } : {}) });
			}
			if (plans.length) await runNpmMutation(plans, sm, () => pm.update(source));
			else await pm.update(source);
		})));
	await applyResourceChange(cwd, "user");
}

/** 热重载全部扩展（pi /reload 等价物）：加载器 + 所有活跃会话 */
export async function reloadExtensions(cwd?: string): Promise<{ loaders: number; sessions: number }> {
	const loaders = (await reloadAllLoaders()).length;
	const sessions = await reloadSessionsForCwd(cwd);
	return { loaders, sessions };
}
