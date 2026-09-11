/**
 * plugins-service：pi 包与扩展的清单、安装/卸载/更新/启用/停用（与 pi 运行时完全同步与持久化）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, getPackageManager, getResourceLoader, invalidateResourceLoaders, reloadAllLoaders, resourceLoaderReady } from "./pi";

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

	const userDisabled = Array.isArray(globalSettings.disabledPackages) ? (globalSettings.disabledPackages as string[]) : [];
	const projectDisabled = Array.isArray(projectSettings.disabledPackages) ? (projectSettings.disabledPackages as string[]) : [];

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
	};

	const globalSettings = await readSettingsFile(path.join(getAgentDir(), "settings.json"));
	const projectSettings = await readSettingsFile(path.join(cwd, ".pi", "settings.json"));

	const disabledExts = new Set<string>([
		...(Array.isArray(globalSettings.disabledExtensions) ? (globalSettings.disabledExtensions as string[]) : []),
		...(Array.isArray(projectSettings.disabledExtensions) ? (projectSettings.disabledExtensions as string[]) : []),
	]);

	const out: ExtensionView[] = [];
	const seenPaths = new Set<string>();

	for (const e of result?.extensions ?? []) {
		const p = String(e.path ?? "");
		if (!p) continue;
		const name = String(e.name ?? path.basename(p).replace(/\.(ts|js)$/, ""));
		const isDisabled = disabledExts.has(p) || disabledExts.has(name);
		seenPaths.add(p);
		out.push({ name, path: p, disabled: isDisabled });
	}

	for (const p of disabledExts) {
		if (!seenPaths.has(p)) {
			seenPaths.add(p);
			const name = path.basename(p).replace(/\.(ts|js)$/, "");
			out.push({ name, path: p, disabled: true });
		}
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

	const packages: any[] = Array.isArray(settings.packages) ? settings.packages : [];
	const disabledPackages: string[] = Array.isArray(settings.disabledPackages) ? (settings.disabledPackages as string[]) : [];

	if (disable) {
		// 从 packages 移至 disabledPackages
		const filteredPackages = packages.filter((p) => {
			const s = typeof p === "string" ? p : p?.source;
			return s !== source;
		});
		if (!disabledPackages.includes(source)) {
			disabledPackages.push(source);
		}
		settings.packages = filteredPackages;
		settings.disabledPackages = disabledPackages;
	} else {
		// 从 disabledPackages 移回 packages
		const filteredDisabled = disabledPackages.filter((s) => s !== source);
		const existsInPackages = packages.some((p) => {
			const s = typeof p === "string" ? p : p?.source;
			return s === source;
		});
		if (!existsInPackages) {
			packages.push(source);
		}
		settings.packages = packages;
		settings.disabledPackages = filteredDisabled;
	}

	await writeSettingsFile(settingsPath, settings);
	invalidateResourceLoaders();
	await reloadAllLoaders();
}

export async function toggleExtension(
	extPath: string,
	disable: boolean,
	cwd: string
): Promise<void> {
	const norm = extPath.replace(/\\/g, "/");
	const isProject = norm.includes(cwd.replace(/\\/g, "/"));
	const settingsPath = isProject ? path.join(cwd, ".pi", "settings.json") : path.join(getAgentDir(), "settings.json");
	const settings = await readSettingsFile(settingsPath);

	const disabledExtensions: string[] = Array.isArray(settings.disabledExtensions)
		? (settings.disabledExtensions as string[])
		: [];

	if (disable) {
		if (!disabledExtensions.includes(extPath)) {
			disabledExtensions.push(extPath);
		}
	} else {
		const idx = disabledExtensions.indexOf(extPath);
		if (idx !== -1) disabledExtensions.splice(idx, 1);
	}

	settings.disabledExtensions = disabledExtensions;
	await writeSettingsFile(settingsPath, settings);
	invalidateResourceLoaders();
	await reloadAllLoaders();
}

export async function installPackage(source: string, local: boolean, cwd: string): Promise<void> {
	const pm = getPackageManager(cwd);
	await pm.installAndPersist(source, { local });
	invalidateResourceLoaders();
	await reloadAllLoaders();
}

export async function removePackage(source: string, local: boolean, cwd: string): Promise<boolean> {
	const pm = getPackageManager(cwd);
	const settingsPath = local ? path.join(cwd, ".pi", "settings.json") : path.join(getAgentDir(), "settings.json");
	const settings = await readSettingsFile(settingsPath);
	if (Array.isArray(settings.disabledPackages) && settings.disabledPackages.includes(source)) {
		settings.disabledPackages = (settings.disabledPackages as string[]).filter((s) => s !== source);
		await writeSettingsFile(settingsPath, settings);
	}

	let removed = false;
	try {
		removed = await pm.removeAndPersist(source, { local });
	} catch {
		try {
			await pm.remove(source, { local });
			removed = true;
		} catch {
			/* ignore */
		}
	}
	invalidateResourceLoaders();
	await reloadAllLoaders();
	return removed;
}

export async function updatePackages(source: string | undefined, cwd: string): Promise<void> {
	const pm = getPackageManager(cwd);
	await pm.update(source);
	invalidateResourceLoaders();
	await reloadAllLoaders();
}

/** 热重载全部扩展（pi /reload 等价物） */
export async function reloadExtensions(): Promise<number> {
	return reloadAllLoaders();
}
