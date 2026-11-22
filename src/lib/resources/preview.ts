import fs from "node:fs/promises";
import path from "node:path";
import { effectiveResourceDevelopmentRoot } from "./preferences";
import { parseResourceManifest, readPackageManifest, resourceRelativePath, resolveResourceFile } from "./manifest";
import { resolveWorkspacePath, isPathInside } from "../path-security";
import type { WebResourceView } from "./protocol";
import { isResourceDesignWorkspace } from "./development";

/** Inspect only an explicitly chosen development workspace. No Pi loader or host entry is executed. */
export async function preparedResourceViews(cwd: string): Promise<Array<{ view: WebResourceView; root: string; entry: string }>> {
	const root = await effectiveResourceDevelopmentRoot();
	const workspace = await resolveWorkspacePath(cwd);
	const realRoot = await fs.realpath(root).catch(() => null);
	if ((!realRoot || !isPathInside(realRoot, workspace) || workspace === realRoot) && !await isResourceDesignWorkspace(workspace)) throw new Error("Not an independent resource development workspace");
	const parent = await readPackageManifest(workspace);
	const declared = (parent?.piweb as { resources?: unknown } | undefined)?.resources;
	const roots = declared === undefined ? [workspace] : Array.isArray(declared) ? await Promise.all(declared.slice(0, 64).map(async (value) => {
		const directory = await fs.realpath(path.join(workspace, resourceRelativePath(value)));
		if (!isPathInside(workspace, directory)) throw new Error("Preview member escapes its workspace");
		return directory;
	})) : [];
	const result: Array<{ view: WebResourceView; root: string; entry: string }> = [];
	for (const root of roots) {
		const raw = await readPackageManifest(root);
		const manifest = parseResourceManifest(raw?.piweb, typeof raw?.name === "string" ? raw.name : path.basename(root));
		for (const view of manifest?.views ?? []) {
			await resolveResourceFile(root, view.entry);
			const token = Buffer.from(JSON.stringify({ cwd: workspace, source: "development-preview", scope: "user", resourceId: manifest!.id, view: view.id, preview: true, revision: Date.now() })).toString("base64url");
			result.push({ root, entry: view.entry, view: { id: `preview:${manifest!.id}:${view.id}`, resourceId: manifest!.id, scope: "user", title: view.title, placement: view.placement, methods: [], preview: true,
				...(view.titles ? { titles: view.titles } : {}), ...(view.icon ? { icon: view.icon } : {}), ...(view.autoMount === true ? { autoMount: true } : {}),
				url: `/api/resources/views/${token}/assets/${encodeURIComponent(path.posix.basename(view.entry))}` } });
		}
	}
	return result;
}
