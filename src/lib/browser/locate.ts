/**
 * 找本机可用的 Chromium 系浏览器（PiWeb 不打包浏览器）：
 * PI_WEB_BROWSER 显式指定时只认它；否则按平台常见安装位置找 Chrome → Edge → Chromium。
 */
import { existsSync } from "node:fs";
import path from "node:path";

export interface LocateDeps {
	exists(file: string): boolean;
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
}

const defaults: LocateDeps = { exists: existsSync, env: process.env, platform: process.platform };

function windowsCandidates(env: Record<string, string | undefined>): string[] {
	const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((root): root is string => Boolean(root));
	const relative = ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe", "Chromium/Application/chrome.exe"];
	return relative.flatMap((rel) => roots.map((root) => path.win32.join(root, rel)));
}

function macCandidates(env: Record<string, string | undefined>): string[] {
	const apps = [
		"Google Chrome.app/Contents/MacOS/Google Chrome",
		"Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"Chromium.app/Contents/MacOS/Chromium",
	];
	const roots = ["/Applications", ...(env.HOME ? [path.posix.join(env.HOME, "Applications")] : [])];
	return apps.flatMap((app) => roots.map((root) => path.posix.join(root, app)));
}

function linuxCandidates(env: Record<string, string | undefined>): string[] {
	const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
	const dirs = (env.PATH ?? "").split(":").filter(Boolean);
	return names.flatMap((name) => dirs.map((dir) => path.posix.join(dir, name)));
}

/** 浏览器可执行文件路径；找不到（或 PI_WEB_BROWSER 指向不存在的文件）返回 null */
export function locateBrowser(deps: LocateDeps = defaults): string | null {
	const explicit = deps.env.PI_WEB_BROWSER?.trim();
	if (explicit) return deps.exists(explicit) ? explicit : null;
	const candidates = deps.platform === "win32" ? windowsCandidates(deps.env) : deps.platform === "darwin" ? macCandidates(deps.env) : linuxCandidates(deps.env);
	return candidates.find((file) => deps.exists(file)) ?? null;
}
