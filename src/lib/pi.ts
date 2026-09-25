/**
 * pi SDK 单例与共享资源：ModelRuntime、SettingsManager、DefaultResourceLoader、PackageManager。
 * 全部走 @earendil-works/pi-coding-agent 公开导出面，pi 零改动。
 */
import path from "node:path";
import fs from "node:fs";
import {
	type ModelRuntime as PiModelRuntime,
	type SettingsManager,
	DefaultPackageManager,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	ProjectTrustStore,
	SessionManager,
	SettingsManager as SettingsManagerClass,
	createAgentSession,
	getAgentDir,
	hasTrustRequiringProjectResources,
	loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";

export { createAgentSession, getAgentDir, loadProjectContextFiles, SessionManager };

// Child tools inherit these defaults; Node itself already decodes source and JSON as UTF-8.
process.env.PYTHONUTF8 ??= "1";
process.env.PYTHONIOENCODING ??= "utf-8";

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

// ---------- 项目信任（与 pi 终端同一份 ~/.pi/agent/trust.json） ----------

let trustStore: ProjectTrustStore | null = null;
function getTrustStore(): ProjectTrustStore {
	if (!trustStore) trustStore = new ProjectTrustStore(getAgentDir());
	return trustStore;
}

export type ProjectTrustState = {
	/** 该目录是否含有需要信任才能加载的项目资源（.pi/settings.json、.pi/extensions、.pi/skills、.agents/skills） */
	required: boolean;
	/** 本次会不会按受信任加载 */
	trusted: boolean;
	/** 结论来源：无需信任 / trust.json 里记住的决定 / settings.json 的 defaultProjectTrust / 还没决定（按不信任处理） */
	source: "not-required" | "remembered" | "default-always" | "default-never" | "undecided";
};

function readDefaultProjectTrust(): "ask" | "always" | "never" {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8")) as { defaultProjectTrust?: string };
		return raw.defaultProjectTrust === "always" || raw.defaultProjectTrust === "never" ? raw.defaultProjectTrust : "ask";
	} catch {
		return "ask";
	}
}

/**
 * 与 pi 终端 main.ts 同一套判定：目录里没有需要信任的项目资源 → 直接信任；
 * 否则看 trust.json 里记住的决定，再看 defaultProjectTrust；「每次询问」在 Web 里没有阻塞式弹窗，
 * 先按不信任加载，并把状态给界面显示一个可点的横幅（用户点信任后写 trust.json 再重载）。
 */
export function resolveProjectTrust(cwd: string): ProjectTrustState {
	const resolved = path.resolve(cwd);
	let required = false;
	try {
		required = hasTrustRequiringProjectResources(resolved);
	} catch {
		required = false;
	}
	if (!required) return { required: false, trusted: true, source: "not-required" };
	const remembered = getTrustStore().get(resolved);
	if (remembered !== null) return { required: true, trusted: remembered, source: "remembered" };
	const fallback = readDefaultProjectTrust();
	if (fallback === "always") return { required: true, trusted: true, source: "default-always" };
	if (fallback === "never") return { required: true, trusted: false, source: "default-never" };
	return { required: true, trusted: false, source: "undecided" };
}

/**
 * 记住某目录的信任决定（null = 忘记）。已缓存的 SettingsManager 就地切换信任态
 * （活跃会话、加载器、包管理器持有的都是它），随后由调用方 reloadLoader + session.reload 让扩展真正加载/卸载。
 */
export function setProjectTrust(cwd: string, decision: boolean | null): ProjectTrustState {
	const resolved = path.resolve(cwd);
	getTrustStore().set(resolved, decision);
	const state = resolveProjectTrust(resolved);
	const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	const sm = settingsCache.get(key);
	if (sm) sm.setProjectTrusted(state.trusted);
	return state;
}

/** 按当前 trust.json / defaultProjectTrust 重新计算每个已缓存目录的信任态并就地写入其 SettingsManager */
export function syncProjectTrust(): void {
	trustStore = null;
	for (const [key, sm] of settingsCache) {
		try {
			sm.setProjectTrusted(resolveProjectTrust(key).trusted);
		} catch {
			/* ignore */
		}
	}
}

/** 每个 cwd 一个 SettingsManager（project 级发现依赖 cwd；global 级共享 agentDir），按项目信任状态创建 */
export function getSettingsManager(cwd: string): SettingsManager {
	const resolved = path.resolve(cwd);
	const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	let sm = settingsCache.get(key);
	if (!sm) {
		sm = SettingsManagerClass.create(resolved, getAgentDir(), { projectTrusted: resolveProjectTrust(resolved).trusted });
		settingsCache.set(key, sm);
	}
	return sm;
}

interface LoaderEntry {
	loader: DefaultResourceLoader;
	ready: Promise<void>;
	/** 发现缓存的版本；每个热会话分别追踪自己已应用的版本。 */
	version: number;
	fingerprint: string;
}

const loaderCache = new Map<string, LoaderEntry>();

let resourceLock: Promise<void> = Promise.resolve();
/** 资源加载/重载（含 AgentSession.reload）全局排队：SDK 的扩展模块缓存是进程级且按 cwd 切换时清空，不能交错 */
export function withResourceLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = resourceLock.then(fn, fn);
	resourceLock = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function loaderKey(cwd: string): string {
	const resolved = path.resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 每个热会话必须拥有自己的扩展 runtime；这里只创建，不加入发现缓存。 */
export async function createSessionResourceLoader(cwd: string, extensionFactories: InlineExtension[] = []): Promise<DefaultResourceLoader> {
	const settingsManager = getSettingsManager(cwd);
	settingsManager.setProjectTrusted(resolveProjectTrust(cwd).trusted);
	const loader = new DefaultResourceLoader({ cwd: path.resolve(cwd), agentDir: getAgentDir(), settingsManager, extensionFactories });
	const reload = loader.reload.bind(loader);
	loader.reload = async (options) => {
		settingsManager.setProjectTrusted(resolveProjectTrust(cwd).trusted);
		await reload(options);
	};
	try {
		await withResourceLock(() => loader.reload());
		return loader;
	} catch (error) {
		loader.getExtensions().runtime.invalidate();
		throw error;
	}
}

/**
 * 每 cwd 的只读发现缓存（技能/扩展/prompt 面板），绝不能传给 AgentSession。
 * SDK 缓存的是扩展工厂，DefaultResourceLoader 的 runtime 却会被 bindCore 就地绑定到会话。
 */
export function getResourceLoader(cwd: string): DefaultResourceLoader {
	const key = loaderKey(cwd);
	let entry = loaderCache.get(key);
	if (!entry) {
		const loader = new DefaultResourceLoader({ cwd: path.resolve(cwd), agentDir: getAgentDir(), settingsManager: getSettingsManager(cwd) });
		entry = { loader, ready: Promise.resolve(), version: 0, fingerprint: "" };
		loaderCache.set(key, entry);
		queueLoaderReload(cwd, entry);
	}
	return entry.loader;
}

function queueLoaderReload(cwd: string, entry: LoaderEntry): Promise<void> {
	const run = withResourceLock(async () => {
		getSettingsManager(cwd).setProjectTrusted(resolveProjectTrust(cwd).trusted);
		// 发现缓存从未被会话绑定；替换前释放它自己的 event-bus 订阅。
		entry.loader.getExtensions().runtime.invalidate();
		const fingerprint = resourceFingerprint(cwd);
		await entry.loader.reload();
		entry.fingerprint = fingerprint;
		entry.version += 1;
	});
	entry.ready = run;
	// getResourceLoader 是同步兼容接口；错误仍由 ready 的 await 方接收。
	void run.catch(() => undefined);
	return run;
}

export function resourceLoaderVersion(cwd: string): number {
	return loaderCache.get(loaderKey(cwd))?.version ?? 0;
}

/** 等待某 cwd 的加载器完成发现；消费 loader 前必须 await（ensureSession / 快照 / 技能面板等）。 */
export async function resourceLoaderReady(cwd: string): Promise<void> {
	getResourceLoader(cwd);
	await loaderCache.get(loaderKey(cwd))!.ready;
}

/** 用户可能随手新建 .md / SKILL.md 的目录：全局与项目的 prompts、skills、extensions */
function watchedResourceDirs(cwd: string): string[] {
	const agentDir = getAgentDir();
	const project = path.join(path.resolve(cwd), ".pi");
	return [
		path.join(agentDir, "prompts"),
		path.join(agentDir, "skills"),
		path.join(agentDir, "extensions"),
		path.join(project, "prompts"),
		path.join(project, "skills"),
		path.join(project, "extensions"),
	];
}

function resourceFingerprint(cwd: string): string {
	const records: string[] = [String(resolveProjectTrust(cwd).trusted)];
	const visit = (file: string, depth: number) => {
		try {
			const stat = fs.statSync(file);
			records.push(`${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
			if (stat.isDirectory() && depth < 2) {
				for (const entry of fs.readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
					if (entry.name !== "node_modules") visit(path.join(file, entry.name), depth + 1);
				}
			}
		} catch {
			records.push(`${file}:missing`);
		}
	};
	for (const dir of watchedResourceDirs(cwd)) visit(dir, 0);
	for (const file of [path.join(getAgentDir(), "settings.json"), path.join(cwd, ".pi", "settings.json")]) visit(file, 2);
	return records.join("\n");
}

/**
 * 资源目录里有比上次加载更新的文件（用户刚新建了 prompt / 技能 / 扩展）就重载一次。
 * 只 stat 几个目录，不递归项目；返回是否真的重载了。
 */
export function resourceLoaderIsStale(cwd: string): boolean {
	const entry = loaderCache.get(loaderKey(cwd));
	return !entry || resourceFingerprint(cwd) !== entry.fingerprint;
}

export async function refreshResourceLoaderIfStale(cwd: string): Promise<boolean> {
	await resourceLoaderReady(cwd);
	const entry = loaderCache.get(loaderKey(cwd));
	if (!entry) return false;
	if (resourceFingerprint(cwd) === entry.fingerprint) return false;
	await reloadLoader(cwd);
	return true;
}

/** 已缓存的加载器（不存在时不创建） */
export function peekResourceLoader(cwd: string): DefaultResourceLoader | undefined {
	return loaderCache.get(loaderKey(cwd))?.loader;
}

/** 仅重载某 cwd 的发现缓存；热会话由 reloadSessionsForCwd 分别更新，不能共享 runtime。 */
export async function reloadLoader(cwd: string): Promise<void> {
	const entry = loaderCache.get(loaderKey(cwd));
	if (!entry) {
		await resourceLoaderReady(cwd);
		return;
	}
	await queueLoaderReload(cwd, entry);
}

/** 让所有已缓存的 SettingsManager 就地重新读盘（活跃会话持有的就是这些实例） */
export async function reloadSettingsManagers(): Promise<void> {
	for (const sm of settingsCache.values()) {
		try {
			await sm.reload();
		} catch {
			/* ignore */
		}
	}
}

/** 保留活跃加载器持有的 SettingsManager，重新读盘而不是留下脱离缓存的实例。 */
export function invalidateSettingsManagers(): void {
	for (const sm of settingsCache.values()) void sm.reload().catch(() => undefined);
	packageManagerCache.clear();
}

/** 热重载全部已缓存加载器（对应 pi 的 /reload）；就地刷新，不清缓存；返回重载过的 cwd 键 */
export async function reloadAllLoaders(): Promise<string[]> {
	// 先让 SettingsManager 重新读盘（加载器 reload 内部也会 reload 同一个实例），包缓存清掉
	for (const sm of settingsCache.values()) {
		try {
			await sm.reload();
		} catch {
			/* ignore */
		}
	}
	packageManagerCache.clear();
	const reloaded: string[] = [];
	for (const [key, entry] of loaderCache) {
		try {
			await queueLoaderReload(key, entry);
			reloaded.push(key);
		} catch {
			/* 单个失败不影响其他 */
		}
	}
	return reloaded;
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
	standard: ["read", "grep", "find", "ls", "bash", "edit", "write"],
	full: [], // 空 = 不限制（全部可用工具）
};
