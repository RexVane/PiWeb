/**
 * pi SDK 单例与共享资源：ModelRuntime、SettingsManager、DefaultResourceLoader、PackageManager。
 * 全部走 @earendil-works/pi-coding-agent 公开导出面，pi 零改动。
 */
import path from "node:path";
import fs from "node:fs";
import { readJsonObjectSync } from "./agent-config";
import {
	type ModelRuntime as PiModelRuntime,
	type SettingsManager,
	DefaultPackageManager,
	DefaultResourceLoader,
	ModelRuntime,
	ProjectTrustStore,
	SessionManager,
	SettingsManager as SettingsManagerClass,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	getAgentDir,
	hasTrustRequiringProjectResources,
	loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";

import { modelFilesFingerprint, reloadStoredCredentials } from "./model-files";

export { createAgentSession, getAgentDir, loadProjectContextFiles, SessionManager };

// Child tools inherit these defaults; Node itself already decodes source and JSON as UTF-8.
process.env.PYTHONUTF8 ??= "1";
process.env.PYTHONIOENCODING ??= "utf-8";

let modelRuntimePromise: Promise<PiModelRuntime> | null = null;
/** 共享运行时每创建一次、每刷新一次就加一：模型列表缓存据此作废（见 models-service） */
let modelRuntimeGeneration = 0;
/** 上一次加载目录时 models.json / auth.json 的指纹 */
let modelFilesSeen: string | null = null;

export function getModelRuntime(): Promise<PiModelRuntime> {
	if (!modelRuntimePromise) {
		modelFilesSeen = modelFilesFingerprint(getAgentDir());
		modelRuntimeGeneration += 1;
		modelRuntimePromise = ModelRuntime.create().catch((err) => {
			modelRuntimePromise = null;
			throw err;
		});
	}
	return modelRuntimePromise;
}

export function modelRuntimeVersion(): number {
	return modelRuntimeGeneration;
}

/**
 * models.json 落盘后调用：就地刷新共享的 ModelRuntime，让目录与认证立即生效。
 * 不能换一个新实例 —— 活跃会话、扩展注册的 provider 都挂在旧实例上，换掉后会话里
 * 选新 provider 的模型会报 "No API key"，扩展 provider 也会从目录里消失。
 * 只读本地配置不联网；刷新失败才退回整体重建。手改的 auth.json 也在这里重读（SDK 的存储会缓存它）。
 */
export async function refreshModelRuntime(): Promise<void> {
	const pending = modelRuntimePromise;
	if (!pending) return;
	// 先记指纹再刷新：刷新期间又改的文件，下一次检查还能发现
	modelFilesSeen = modelFilesFingerprint(getAgentDir());
	modelRuntimeGeneration += 1;
	try {
		const runtime = await pending;
		reloadStoredCredentials(runtime);
		await runtime.refresh({ allowNetwork: false });
	} catch {
		if (modelRuntimePromise === pending) modelRuntimePromise = null;
	}
}

/** 读目录的入口调用：models.json / auth.json 的指纹变了才刷新（两次 stat，不读内容）。返回是否刷新过。 */
export async function refreshModelRuntimeIfFilesChanged(): Promise<boolean> {
	if (!modelRuntimePromise) return false;
	if (modelFilesFingerprint(getAgentDir()) === modelFilesSeen) return false;
	await refreshModelRuntime();
	return true;
}

const settingsCache = new Map<string, SettingsManager>();
/** 缓存键 → 原始目录。键在 Windows 上是小写的，不能拿它当目录交给 SDK 或算资源指纹 */
const settingsCwds = new Map<string, string>();

// ---------- 项目信任（与 pi 终端同一份 ~/.pi/agent/trust.json） ----------

let trustStore: { agentDir: string; store: ProjectTrustStore } | null = null;
/** 跟着 agentDir 走：readTrustFile 每次按当前 agentDir 读，写也必须落在同一份 trust.json */
function getTrustStore(): ProjectTrustStore {
	const agentDir = getAgentDir();
	if (trustStore?.agentDir !== agentDir) trustStore = { agentDir, store: new ProjectTrustStore(agentDir) };
	return trustStore.store;
}

export type ProjectTrustState = {
	/** 该目录是否含有需要信任才能加载的项目资源（.pi/settings.json、.pi/extensions、.pi/skills、.agents/skills） */
	required: boolean;
	/** 本次会不会按受信任加载 */
	trusted: boolean;
	/** 结论来源：无需信任 / trust.json 里记住的决定 / settings.json 的 defaultProjectTrust / 还没决定（按不信任处理） */
	source: "not-required" | "remembered" | "default-always" | "default-never" | "undecided";
};

/**
 * 交给 SDK 信任存储的目录写法：Windows 上取真实大小写。
 *
 * SDK 用 JS 版 realpathSync 规范化 trust.json 的键，它在 Windows 上**保留输入的大小写**
 * （`d:\aiapp\piweb` 原样返回，只有 .native 才给 `D:\AIApp\PiWeb`），再按字符串精确匹配。
 * 同一个目录写进去和查出来的大小写只要不一样，记住的决定就查不到。
 */
function trustPath(cwd: string): string {
	const resolved = path.resolve(cwd);
	try {
		return process.platform === "win32" ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/** trust.json 的解析结果按文件修订缓存：resolveProjectTrust 在指纹、资源清单、快照里被频繁调用 */
interface TrustFile {
	revision: string;
	/** 原样的键 */
	keys: string[];
	/** 折叠后的键（Windows 小写）→ 决定 */
	decisions: Map<string, boolean>;
}
let trustFileCache: TrustFile | null = null;
const foldTrustKey = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);

/** 读不懂（被写了一半、格式不对）返回 null，调用方退回 SDK 加锁读 */
function readTrustFile(): TrustFile | null {
	const file = path.join(getAgentDir(), "trust.json");
	let revision: string;
	try {
		const stat = fs.statSync(file);
		revision = `${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
	} catch {
		return { revision: "missing", keys: [], decisions: new Map() }; // 还没有 trust.json：什么都没记住
	}
	if (trustFileCache?.revision === revision) return trustFileCache;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const decisions = new Map<string, boolean>();
		for (const [key, value] of Object.entries(parsed)) {
			if (value === true || value === false) decisions.set(foldTrustKey(key), value);
			else if (value !== null) return null; // SDK 认定为坏文件，交给它报错
		}
		trustFileCache = { revision, keys: Object.keys(parsed), decisions };
		return trustFileCache;
	} catch {
		return null;
	}
}

/**
 * 记住的信任决定：与 SDK 一样从该目录逐级往上找最近的一条，但 Windows 上不分大小写
 * （pi 终端写进去的键是当时 shell 里 cwd 的写法，大小写不一定是真实的）。
 * 不走 SDK 的 get()：它每次都同步加文件锁、失败还会自旋等待。读不懂时再退回 SDK。
 */
function rememberedProjectTrust(cwd: string): boolean | null {
	const trust = readTrustFile();
	if (!trust) return getTrustStore().get(trustPath(cwd));
	let current = trustPath(cwd);
	for (;;) {
		const decision = trust.decisions.get(foldTrustKey(current));
		if (decision !== undefined) return decision;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function readDefaultProjectTrust(): "ask" | "always" | "never" {
	// 同步读且被 getSettingsManager / 资源指纹反复调用：走统一缓存（文件没变就不重新读盘解析）
	const raw = readJsonObjectSync(path.join(getAgentDir(), "settings.json")) as { defaultProjectTrust?: string };
	return raw.defaultProjectTrust === "always" || raw.defaultProjectTrust === "never" ? raw.defaultProjectTrust : "ask";
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
	const remembered = rememberedProjectTrust(resolved);
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
	const target = trustPath(resolved);
	// 同一目录大小写不同的旧键先删掉：查找不分大小写，留着它会顶替（或在「忘记」后复活）这次的决定
	for (const key of readTrustFile()?.keys ?? []) {
		if (key !== target && foldTrustKey(key) === foldTrustKey(target)) getTrustStore().set(key, null);
	}
	getTrustStore().set(target, decision);
	trustFileCache = null; // 同一毫秒内连写两次时修订号可能不变，别读到旧缓存
	const state = resolveProjectTrust(resolved);
	const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	const sm = settingsCache.get(key);
	if (sm) sm.setProjectTrusted(state.trusted);
	return state;
}

/** 按当前 trust.json / defaultProjectTrust 重新计算每个已缓存目录的信任态并就地写入其 SettingsManager */
export function syncProjectTrust(): void {
	trustStore = null;
	trustFileCache = null;
	for (const [key, sm] of settingsCache) {
		try {
			// 缓存键在 Windows 上是小写的，拿原始目录去算（见 settingsCwds）
			sm.setProjectTrusted(resolveProjectTrust(settingsCwds.get(key) ?? key).trusted);
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
		settingsCwds.set(key, resolved);
	}
	return sm;
}

interface LoaderEntry {
	/** 原始目录（缓存键在 Windows 上是小写的） */
	cwd: string;
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

/**
 * SDK 的内置扩展（MCP、codemode、tool_search）：pi 命令行自己会带上，SDK 使用方要自己传，
 * 不传 PiWeb 里就没有 mcp.json 配的服务器、也没有 codemode。名字与 CLI 一致（路径 `builtin:<name>`），
 * settings 里的 `-builtin:mcp` 才能停用它们。llama.cpp 那个内置扩展 SDK 没有公开导出，补不了。
 * 工厂每次加载都新建自己的状态；MCP 要等 session_start 才连服务器，只做清单的发现缓存不会拉起进程。
 */
const BUILTIN_EXTENSIONS = [
	{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true as const },
	{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true as const },
	{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true as const },
];

function loaderKey(cwd: string): string {
	const resolved = path.resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 每个热会话必须拥有自己的扩展 runtime；这里只创建，不加入发现缓存。 */
export async function createSessionResourceLoader(cwd: string, settingsOverride?: SettingsManager): Promise<DefaultResourceLoader> {
	const settingsManager = settingsOverride ?? getSettingsManager(cwd);
	settingsManager.setProjectTrusted(resolveProjectTrust(cwd).trusted);
	const loader = new DefaultResourceLoader({ cwd: path.resolve(cwd), agentDir: getAgentDir(), settingsManager, extensionFactories: BUILTIN_EXTENSIONS });
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
		const loader = new DefaultResourceLoader({ cwd: path.resolve(cwd), agentDir: getAgentDir(), settingsManager: getSettingsManager(cwd), extensionFactories: BUILTIN_EXTENSIONS });
		entry = { cwd: path.resolve(cwd), loader, ready: Promise.resolve(), version: 0, fingerprint: "" };
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
			// 用原始目录：小写键会让资源指纹对不上（每次都多重载一轮），信任查找也会出错
			await queueLoaderReload(entry.cwd, entry);
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

/** 工具预设 → pi 工具白名单（ask_user_question 只是问用户、不碰文件，各档都放行） */
export const TOOL_PRESETS: Record<"readonly" | "standard" | "full", string[]> = {
	readonly: ["read", "grep", "find", "ls", "ask_user_question"],
	standard: ["read", "grep", "find", "ls", "bash", "edit", "write", "codemode", "tool_search", "ask_user_question"],
	full: [], // 空 = 不限制（全部可用工具）
};

const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

/** 与 SDK isMcpToolName 一致：MCP 服务器工具 `mcp__<server>__<tool>` 与三个资源工具 */
export function isMcpToolName(name: string): boolean {
	return name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(name);
}

/**
 * 档位是否放行某个工具（只是上限，开不开由 SDK / 扩展决定）。
 * standard 另外放行 MCP 工具：服务器是用户自己在 mcp.json 里配的；readonly 不放，MCP 工具能写盘、调外部服务。
 */
export function presetAllowsTool(preset: keyof typeof TOOL_PRESETS, name: string): boolean {
	if (preset === "full") return true;
	return TOOL_PRESETS[preset].includes(name) || (preset === "standard" && isMcpToolName(name));
}
