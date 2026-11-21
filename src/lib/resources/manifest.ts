import path from "node:path";
import fs from "node:fs/promises";
import { isPathInside } from "../path-boundary";
import type { ResourceCompatibility, ResourceManifest, ResourceView } from "./protocol";
import { RESOURCE_API_VERSION, RESOURCE_BROWSER_CAPABILITIES } from "./protocol";

const ID = /^[a-zA-Z0-9@][a-zA-Z0-9._@/-]{0,159}$/;
const VIEW_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const METHODS = new Set(["select", "confirm", "input", "editor", "web"]);
const PLACEMENTS = new Set(["dialog", "panel", "aboveEditor", "belowEditor"]);
const TITLE_LANGS = new Set(["zh", "zh-Hant", "en", "ja", "ru"]);
/** 侧栏图标白名单：资源只能从 PiWeb 现有图标里挑，不能让包名决定渲染什么组件 */
export const RESOURCE_VIEW_ICONS = new Set(["clock", "cube", "chat", "file", "terminal", "plugin"]);
export const MAX_MANIFEST_BYTES = 256 * 1024;

export function resourceRelativePath(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 512 || /[\x00-\x1f\x7f\\?#%]/.test(value)) throw new Error("Invalid resource entry path");
	const normalized = value.replace(/^\.\//, "");
	if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) throw new Error("Resource entry must stay inside its package");
	return normalized;
}

/** 视图自带的本地化标题：只收已知语言、去重长度限制，其它键直接丢弃。 */
function parseViewTitles(raw: unknown): Partial<Record<"zh" | "zh-Hant" | "en" | "ja" | "ru", string>> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const titles: Partial<Record<"zh" | "zh-Hant" | "en" | "ja" | "ru", string>> = {};
	for (const [lang, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!TITLE_LANGS.has(lang) || typeof value !== "string") continue;
		const text = value.trim().slice(0, 200);
		if (text) titles[lang as keyof typeof titles] = text;
	}
	return Object.keys(titles).length ? titles : undefined;
}

export function parseResourceManifest(raw: unknown, packageName: string): ResourceManifest | undefined {	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (value.apiVersion !== RESOURCE_API_VERSION) throw new Error(`Unsupported PiWeb resource API version: ${String(value.apiVersion)}`);
	const id = typeof value.id === "string" ? value.id : packageName;
	if (!ID.test(id) || id.includes("..")) throw new Error("Invalid resource id");
	const views: ResourceView[] = [];
	const seen = new Set<string>();
	if (value.views !== undefined && !Array.isArray(value.views)) throw new Error("Resource views must be an array");
	for (const rawView of (value.views as unknown[] | undefined ?? []).slice(0, 32)) {
		if (!rawView || typeof rawView !== "object" || Array.isArray(rawView)) throw new Error("Invalid resource view");
		const view = rawView as Record<string, unknown>;
		if (typeof view.id !== "string" || !VIEW_ID.test(view.id) || seen.has(view.id)) throw new Error("Invalid or duplicate resource view id");
		seen.add(view.id);
		const entry = resourceRelativePath(view.entry);
		if (!/\.html?$/i.test(entry) || path.posix.dirname(entry) === ".") throw new Error("A resource view entry must be an HTML file in a dedicated asset directory");
		if (view.placement !== undefined && !PLACEMENTS.has(String(view.placement))) throw new Error("Invalid resource view placement");
		if (view.methods !== undefined && (!Array.isArray(view.methods) || view.methods.some((method) => !METHODS.has(String(method))))) throw new Error("Invalid resource dialog method");
		if (view.capabilities !== undefined && (!Array.isArray(view.capabilities) || view.capabilities.length > RESOURCE_BROWSER_CAPABILITIES.length
			|| view.capabilities.some((capability) => !RESOURCE_BROWSER_CAPABILITIES.includes(capability as never)))) throw new Error("Invalid browser capability");
		const titles = parseViewTitles(view.titles);
		views.push({ id: view.id, title: typeof view.title === "string" ? view.title.slice(0, 200) : view.id,
			...(titles ? { titles } : {}),
			...(view.capabilities ? { capabilities: [...new Set(view.capabilities as ResourceView["capabilities"])] } : {}),
			...(typeof view.icon === "string" && RESOURCE_VIEW_ICONS.has(view.icon) ? { icon: view.icon } : {}),
			entry, placement: (view.placement ?? "panel") as ResourceView["placement"], methods: [...new Set(view.methods as ResourceView["methods"] ?? [])] });
	}
	const host = value.host === undefined ? undefined : resourceRelativePath(value.host);
	if (host && !/\.(?:mjs|js)$/.test(host)) throw new Error("A resource host entry must be Node ESM (.mjs or .js)");
	return { apiVersion: RESOURCE_API_VERSION, id, views, ...(host ? { host } : {}) };
}

/** Symlinks, not just lexical paths, must remain within the approved package/asset root. */
export async function resolveResourceFile(root: string, relative: string): Promise<string> {
	const clean = resourceRelativePath(relative);
	const realRoot = await fs.realpath(root);
	const target = await fs.realpath(path.join(realRoot, clean));
	if (!isPathInside(realRoot, target) || target === realRoot || !(await fs.stat(target)).isFile()) throw new Error("Resource file escapes its approved root");
	return target;
}

export async function readPackageManifest(root: string): Promise<Record<string, unknown> | undefined> {
	try {
		const file = await resolveResourceFile(root, "package.json");
		const stat = await fs.stat(file);
		if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error("Package manifest is too large");
		const text = await fs.readFile(file, "utf8");
		if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error("Package manifest is too large");
		const raw = JSON.parse(text.replace(/^\uFEFF/, ""));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
		throw error;
	}
}

/** Static hints are advisory: terminal guards and dynamically constructed UI can require review. */
export function staticResourceCompatibility(manifest: ResourceManifest | undefined, sourceTexts: string[]): ResourceCompatibility {
	if (manifest) return "web";
	const source = sourceTexts.join("\n");
	if (/\.custom\s*\(|\.onTerminalInput\s*\(|\.setEditorComponent\s*\(|\.setFooter\s*\(|\.setHeader\s*\(|(?:\.mode\s*[!=]==?\s*["']tui["']|["']tui["']\s*[!=]==?\s*\w+\.mode)/.test(source)) return "adapt";
	return "unknown";
}
