import path from "node:path";
import fs from "node:fs/promises";
import { DefaultPackageManager, SettingsManager, type PackageManager, type ResolvedResource } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getPackageManager, getSettingsManager, resolveProjectTrust } from "../pi";
import { isPathInside } from "../path-boundary";
import { securePackageManager } from "../package-manager-safe";
import { parseResourceManifest, readPackageManifest, resolveResourceFile, resourceRelativePath } from "./manifest";
import type { ResourcePackage, ResourceView, WebResourceView } from "./protocol";

const sameRoot = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** Pi owns the containing Git/npm/local package and its resource filters. Listing never loads extension/host code. */
export async function discoverResourcePackages(cwd: string, options: { manager?: PackageManager; globalOnly?: boolean } = {}): Promise<ResourcePackage[]> {
	let manager = options.manager;
	if (!manager) {
		const settings = getSettingsManager(cwd); await settings.reload(); settings.setProjectTrusted(resolveProjectTrust(cwd).trusted);
		manager = options.globalOnly ? securePackageManager(new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: SettingsManager.inMemory(settings.getGlobalSettings()) })) : getPackageManager(cwd);
	}
	const resolved = await manager.resolve(async () => "skip");
	const all = [...resolved.extensions, ...resolved.skills, ...resolved.prompts, ...resolved.themes];
	const result: ResourcePackage[] = [];
	for (const configured of manager.listConfiguredPackages().slice(0, 256)) {
		if (options.globalOnly && configured.scope !== "user") continue;
		const installRoot = configured.installedPath ?? manager.getInstalledPath(configured.source, configured.scope);
		if (!installRoot) continue;
		try { if (!(await fs.stat(installRoot)).isDirectory()) continue; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		const realInstallRoot = await fs.realpath(installRoot);
		const belongs = (entry: ResolvedResource) => entry.metadata.scope === configured.scope
			&& (entry.metadata.packageRoot ? sameRoot(entry.metadata.packageRoot, installRoot) || sameRoot(entry.metadata.packageRoot, realInstallRoot) : entry.metadata.source === configured.source);
		let roots = [installRoot];
		try {
			const parent = await readPackageManifest(installRoot);
			const resources = (parent?.piweb as { resources?: unknown } | undefined)?.resources;
			if (resources !== undefined) {
				if (!Array.isArray(resources) || resources.length > 64) throw new Error("Invalid resource collection declaration");
				const realRoot = await fs.realpath(installRoot);
				roots = await Promise.all(resources.map(async (value) => {
					const directory = await fs.realpath(path.join(installRoot, resourceRelativePath(value)));
					if (!isPathInside(realRoot, directory) || sameRoot(realRoot, directory) || !(await fs.stat(directory)).isDirectory()) throw new Error("Resource collection member escapes its Pi package");
					return directory;
				}));
			}
		} catch {
			result.push({ id: path.basename(installRoot), name: path.basename(installRoot), version: "", source: configured.source, scope: configured.scope, root: installRoot, installRoot, extensionPaths: [], cwd, enabled: false, error: "Invalid resource collection manifest" });
			continue;
		}
		for (const root of roots) {
			const lexicalRoot = sameRoot(root, installRoot) ? installRoot : path.join(installRoot, path.relative(realInstallRoot, root));
			const owns = (entry: ResolvedResource) => belongs(entry) && (isPathInside(root, entry.path) || isPathInside(lexicalRoot, entry.path));
			const entries = all.filter(owns);
			let name = path.basename(root); let version = ""; let manifest: ResourcePackage["manifest"]; let error: string | undefined;
			try {
				const raw = await readPackageManifest(root);
				if (typeof raw?.name === "string") name = raw.name.slice(0, 160);
				if (typeof raw?.version === "string") version = raw.version.slice(0, 80);
				manifest = parseResourceManifest(raw?.piweb, name);
				if (manifest) { for (const view of manifest.views) await resolveResourceFile(root, view.entry); if (manifest.host) await resolveResourceFile(root, manifest.host); }
			} catch (failure) { error = failure instanceof Error ? failure.message : "Invalid resource package"; }
			const extensions = resolved.extensions.filter(owns);
			const relative = (entry: ResolvedResource) => path.relative(isPathInside(installRoot, entry.path) ? installRoot : realInstallRoot, entry.path).replaceAll(path.sep, "/");
			const resourcePaths = { extensions: extensions.map(relative), skills: resolved.skills.filter(owns).map(relative), prompts: resolved.prompts.filter(owns).map(relative), themes: resolved.themes.filter(owns).map(relative) };
			const enabled = manifest ? extensions.some((entry) => entry.enabled) : entries.some((entry) => entry.enabled);
			result.push({ id: manifest?.id ?? name, name, version, source: configured.source, scope: configured.scope, root, installRoot,
				extensionPaths: resourcePaths.extensions, resourcePaths, cwd, enabled: enabled && !error, ...(manifest ? { manifest } : {}), ...(error ? { error } : {}) });
		}
	}
	const ids = new Map<string, ResourcePackage[]>();
	for (const resource of result.filter((item) => item.enabled && item.manifest)) { const key = `${resource.scope}:${resource.id}`; ids.set(key, [...(ids.get(key) ?? []), resource]); }
	for (const resources of ids.values()) if (resources.length > 1) for (const resource of resources) { resource.enabled = false; resource.error = "Conflicting resource id; disable one of the packages"; }
	return result;
}

export function resourceViewId(resource: ResourcePackage, view: ResourceView): string { return `${resource.scope}:${resource.id}:${view.id}`; }
export function webResourceView(resource: ResourcePackage, view: ResourceView): WebResourceView {
	const token = Buffer.from(JSON.stringify({ cwd: resource.cwd, source: resource.source, scope: resource.scope, resourceId: resource.id, view: view.id, revision: resource.version })).toString("base64url");
	return { id: resourceViewId(resource, view), resourceId: resource.id, scope: resource.scope, title: view.title, placement: view.placement, methods: view.methods,
		...(view.titles ? { titles: view.titles } : {}), ...(view.icon ? { icon: view.icon } : {}), ...(view.capabilities ? { capabilities: view.capabilities } : {}),
		url: `/api/resources/views/${token}/assets/${encodeURIComponent(path.posix.basename(view.entry))}` };
}
export async function resourceViews(cwd: string): Promise<WebResourceView[]> {
	return (await discoverResourcePackages(cwd)).filter((resource) => resource.enabled && resource.manifest).flatMap((resource) => resource.manifest!.views.map((view) => webResourceView(resource, view)));
}
export async function findResourceView(cwd: string, id: string): Promise<WebResourceView | undefined> { return (await resourceViews(cwd)).find((view) => view.id === id); }
export function parseResourceViewToken(token: string): { cwd: string; source: string; scope: "user" | "project"; resourceId?: string; preview?: boolean; view: string } {
	if (typeof token !== "string" || token.length > 12_000 || !/^[\w-]+$/.test(token)) throw new Error("Invalid resource view token");
	const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
	if (!value || typeof value !== "object" || typeof value.cwd !== "string" || value.cwd.length > 4096 || !path.isAbsolute(value.cwd)
		|| typeof value.source !== "string" || value.source.length > 4096 || (value.scope !== "user" && value.scope !== "project")
		|| value.resourceId !== undefined && (typeof value.resourceId !== "string" || value.resourceId.length > 160) || typeof value.view !== "string" || value.view.length > 80) throw new Error("Invalid resource view token");
	return { cwd: value.cwd, source: value.source, scope: value.scope, resourceId: value.resourceId, preview: value.preview === true, view: value.view };
}
