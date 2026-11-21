import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "../pi";
import { replaceFileAtomically } from "../atomic-file";
import { withExternalSettingsLock, withSettingsWriteLock } from "../settings-write-lock";
import type { ResourcePreferences } from "./protocol";

export const DEFAULT_RESOURCE_CATALOG = "https://raw.githubusercontent.com/RexVane/PiWeb/main/resources/catalog/index.json";
const METHODS = ["select", "confirm", "input", "editor", "web"] as const;
const defaults = (): ResourcePreferences => ({ catalogUrls: [], renderers: {} });

export function publicCatalogUrl(value: unknown): string {
	if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid resource catalog URL");
	const url = new URL(value);
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443"
		|| !host.includes(".") || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
		|| host.includes(":") || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Catalogs must use a public HTTPS URL without credentials");
	return url.href;
}

export function normalizeResourcePreferences(raw: unknown): ResourcePreferences {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid resource preferences");
	const value = raw as Record<string, unknown>;
	const result = defaults();
	if (value.developmentRoot !== undefined) {
		if (typeof value.developmentRoot !== "string" || !path.isAbsolute(value.developmentRoot) || value.developmentRoot.length > 4096 || /[\x00-\x1f\x7f]/.test(value.developmentRoot)) throw new Error("Invalid resource development directory");
		result.developmentRoot = value.developmentRoot;
	}
	if (value.catalogUrls !== undefined) {
		if (!Array.isArray(value.catalogUrls) || value.catalogUrls.length > 16) throw new Error("Invalid resource catalog list");
		result.catalogUrls = [...new Set(value.catalogUrls.map(publicCatalogUrl))];
	}
	if (value.renderers !== undefined) {
		if (!value.renderers || typeof value.renderers !== "object" || Array.isArray(value.renderers)) throw new Error("Invalid resource renderer preferences");
		for (const method of METHODS) {
			const id = (value.renderers as Record<string, unknown>)[method];
			if (id === undefined || id === "") continue;
			if (typeof id !== "string" || id.length > 300 || /[\x00-\x1f\x7f]/.test(id)) throw new Error("Invalid resource renderer id");
			result.renderers[method] = id;
		}
	}
	return result;
}

export function resourcePreferencesPath(): string { return path.join(getAgentDir(), "web-resources.json"); }

/**
 * 默认的资源源码根：agent 目录下的 resource-sources。
 *
 * 源码根是全局一份，不按工作区分；没在设置里改过就直接用它，不必先选目录。
 * 刻意放在 Pi 的自动扫描目录（extensions / skills / prompts / themes）之外，
 * 避免未完成的设计或适配工作区在显式安装前被 Pi SDK 自动加载执行。
 */
export function defaultResourceDevelopmentRoot(): string {
	return path.join(getAgentDir(), "resource-sources");
}

/** 实际生效的源码根：用户选过的优先，否则就是默认的全局目录。 */
export async function effectiveResourceDevelopmentRoot(): Promise<string> {
	return (await getResourcePreferences()).developmentRoot || defaultResourceDevelopmentRoot();
}

export async function getResourcePreferences(): Promise<ResourcePreferences> {
	try {
		const file = resourcePreferencesPath();
		if ((await fs.stat(file)).size > 128 * 1024) throw new Error("Resource preferences are too large; existing data was not changed");
		return normalizeResourcePreferences(JSON.parse(await fs.readFile(file, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
		throw error;
	}
}

/** Merge under the same cross-process file lock; a damaged file is never silently replaced. */
export async function saveResourcePreferences(patch: Partial<ResourcePreferences>): Promise<ResourcePreferences> {
	const file = resourcePreferencesPath();
	await fs.mkdir(path.dirname(file), { recursive: true });
	return withSettingsWriteLock(file, () => withExternalSettingsLock(file, async () => {
		const current = await getResourcePreferences();
		const next = normalizeResourcePreferences({ ...current, ...patch, renderers: patch.renderers === undefined ? current.renderers : patch.renderers });
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
			await replaceFileAtomically(temporary, file);
		} finally { await fs.unlink(temporary).catch(() => undefined); }
		return next;
	}));
}
