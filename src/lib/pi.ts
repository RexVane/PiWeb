/**
 * pi SDK 单例与共享资源：ModelRuntime、SettingsManager、DefaultResourceLoader、PackageManager。
 * 全部走 @earendil-works/pi-coding-agent 公开导出面，pi 零改动。
 */
import path from "node:path";
import {
	type ModelRuntime as PiModelRuntime,
	type SettingsManager,
	DefaultPackageManager,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager as SettingsManagerClass,
	createAgentSession,
	getAgentDir,
	loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";

export { createAgentSession, getAgentDir, loadProjectContextFiles, SessionManager };

let modelRuntimePromise: Promise<PiModelRuntime> | null = null;

export function getModelRuntime(): Promise<PiModelRuntime> {
	if (!modelRuntimePromise) {
		modelRuntimePromise = ModelRuntime.create().catch((err) => {
			modelRuntimePromise = null;
			throw err;
		});
	}
	return modelRuntimePromise;
}

/** 重建 ModelRuntime（models.json / auth.json 落盘后调用，让目录与认证立即生效） */
export function resetModelRuntime(): void {
	modelRuntimePromise = null;
}

const settingsCache = new Map<string, SettingsManager>();

/** 每个 cwd 一个 SettingsManager（project 级发现依赖 cwd；global 级共享 agentDir） */
export function getSettingsManager(cwd: string): SettingsManager {
	const key = path.resolve(cwd).toLowerCase();
	let sm = settingsCache.get(key);
	if (!sm) {
		sm = SettingsManagerClass.create(cwd, getAgentDir());
		settingsCache.set(key, sm);
	}
	return sm;
}

const loaderCache = new Map<string, DefaultResourceLoader>();

/** 每个 cwd 一个资源加载器（技能/扩展/prompt/主题发现），agent 会话与技能面板共用 */
export function getResourceLoader(cwd: string): DefaultResourceLoader {
	const key = path.resolve(cwd).toLowerCase();
	let loader = loaderCache.get(key);
	if (!loader) {
		loader = new DefaultResourceLoader({ cwd: path.resolve(cwd), agentDir: getAgentDir() });
		loaderCache.set(key, loader);
	}
	return loader;
}

/** 插件/技能变更后清空全部缓存加载器（下次访问重建） */
export function invalidateResourceLoaders(): void {
	loaderCache.clear();
	invalidateSettingsManagers();
}

/** 清空 SettingsManager 与 PackageManager 缓存，强制重新读取 settings.json */
export function invalidateSettingsManagers(): void {
	for (const sm of settingsCache.values()) {
		try {
			sm.reload();
		} catch {
			/* ignore */
		}
	}
	settingsCache.clear();
	packageManagerCache.clear();
}

/** 热重载全部已缓存加载器（对应 pi 的 /reload） */
export async function reloadAllLoaders(): Promise<number> {
	let n = 0;
	for (const loader of loaderCache.values()) {
		try {
			await loader.reload();
			n += 1;
		} catch {
			/* 单个失败不影响其他 */
		}
	}
	invalidateResourceLoaders();
	return n;
}

const packageManagerCache = new Map<string, DefaultPackageManager>();

export function getPackageManager(cwd: string): DefaultPackageManager {
	const resolved = path.resolve(cwd);
	const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	let packageManager = packageManagerCache.get(key);
	if (!packageManager) {
		packageManager = new DefaultPackageManager({
			cwd: resolved,
			agentDir: getAgentDir(),
			settingsManager: getSettingsManager(resolved),
		});
		packageManagerCache.set(key, packageManager);
	}
	return packageManager;
}

/** 会话 JSONL 绝对路径 ↔ URL 安全 id */
export function encodeSessionId(sessionPath: string): string {
	return Buffer.from(sessionPath, "utf8").toString("base64url");
}

export function decodeSessionId(id: string): string {
	return Buffer.from(id, "base64url").toString("utf8");
}

export function isSessionId(id: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(id) && id.length > 8;
}

/** 打开已有会话（不启动 agent，仅读文件树） */
export function openSessionManager(sessionPath: string): SessionManager {
	return SessionManager.open(sessionPath);
}

/** 工具预设 → pi 工具白名单 */
export const TOOL_PRESETS: Record<"readonly" | "standard" | "full", string[]> = {
	readonly: ["read", "grep", "find", "ls"],
	standard: ["read", "bash", "edit", "write"],
	full: [], // 空 = 不限制（全部可用工具）
};
