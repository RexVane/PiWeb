import fs from "node:fs/promises";
import path from "node:path";
import { discoverResourcePackages, parseResourceViewToken } from "./discovery";
import { resolveResourceFile, resourceRelativePath } from "./manifest";
import { resolveWorkspacePath } from "../path-security";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
};
export const RESOURCE_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/** Never a general filesystem route: both package identity and the declared view asset directory are rechecked. */
export async function readResourceAsset(token: string, asset: string): Promise<{ data: Buffer; mimeType: string }> {
	const request = parseResourceViewToken(token);
	const cwd = await resolveWorkspacePath(request.cwd);
	const preview = request.preview ? (await (await import("./preview")).preparedResourceViews(cwd)).find((item) => item.view.resourceId === request.resourceId && item.view.id.endsWith(`:${request.view}`)) : undefined;
	const resources = request.preview ? [] : await discoverResourcePackages(cwd);
	const resource = resources.find((item) => item.enabled && item.source === request.source && item.scope === request.scope && (!request.resourceId || item.id === request.resourceId));
	const view = resource?.manifest?.views.find((item) => item.id === request.view);
	const root = preview?.root ?? resource?.root;
	const entry = preview?.entry ?? view?.entry;
	if (!root || !entry) throw new Error("Resource view is not enabled");
	const clean = resourceRelativePath(asset);
	const mimeType = MIME[path.posix.extname(clean).toLowerCase()];
	if (!mimeType) throw new Error("Unsupported resource asset type");
	const webRoot = path.join(root, path.posix.dirname(entry));
	const approvedRoot = await fs.realpath(root);
	const realWebRoot = await fs.realpath(webRoot);
	const { isPathInside } = await import("../path-boundary");
	if (!isPathInside(approvedRoot, realWebRoot)) throw new Error("Resource asset directory escapes its package");
	const file = await resolveResourceFile(realWebRoot, clean);
	if ((await fs.stat(file)).size > 5 * 1024 * 1024) throw new Error("Resource asset is too large");
	const data = await fs.readFile(file);
	if (data.length > 5 * 1024 * 1024) throw new Error("Resource asset is too large");
	return { data, mimeType };
}
