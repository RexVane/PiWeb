/**
 * pi-settings：读写 pi settings.json 里 PiWeb 设置面板管的那部分
 * （压缩 / 自动重试 / 缓存预热 / 排队投递方式 / 代理）。
 * 与项目信任同一个外科手术式 JSON patch 方式：只动点名的字段，其余原样留着。
 */
import fs from "node:fs";
import path from "node:path";
import { invalidateJsonFile } from "./agent-config";
import { getAgentDir, reloadSettingsManagers, resolveProjectTrust } from "./pi";
import { readFileBounded } from "./read-file-bounded";
import { withSettingsWriteLock } from "./settings-write-lock";
import { redactUrlCredentials } from "./secret-redaction";
import { mutateJsoncSettingsFileSync, readJsoncSettingsObjectSync } from "./jsonc-settings-storage";
import { resolveWorkspacePath } from "./path-security";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

/** off = 不预热；streaming = 只在回合进行中；idle = 回合结束后空闲时也续一次 */
export type CacheWarmingMode = "off" | "streaming" | "idle";
/** 排队的消息一次全部发给模型，还是一次一条 */
export type QueueMode = "all" | "one-at-a-time";

export interface PiSettings {
	compaction: CompactionSettings;
	retry: RetrySettings;
	cacheWarming: CacheWarmingMode;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	/** 空串 = 没设 */
	httpProxy: string;
	/** Project editor values may differ from the currently trusted session settings. */
	effective?: PiSettings;
	projectTrusted?: boolean;
}

/** 写入用的补丁：没出现的字段不动，未在面板开放的 pi 配置交给 SDK 管理。 */
export interface PiSettingsPatch {
	compaction?: Partial<CompactionSettings>;
	retry?: Partial<RetrySettings>;
	cacheWarming?: CacheWarmingMode;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	httpProxy?: string;
}

const DEFAULTS: PiSettings = {
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
	cacheWarming: "idle",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	httpProxy: "",
};

const CACHE_WARMING_MODES: readonly CacheWarmingMode[] = ["off", "streaming", "idle"];
const QUEUE_MODES: readonly QueueMode[] = ["all", "one-at-a-time"];
const MAX_NUMBER = 1_000_000_000;

/** settings.json 走统一缓存：文件没变就不重复读盘解析（每次快照 / 模型目录都会读它） */
function settingsFile(): string {
	return path.join(getAgentDir(), "settings.json");
}

function webProxyFile(): string {
	return path.join(getAgentDir(), "web-proxy.json");
}

function readDirectProxyMode(): boolean {
	try {
		const raw = fs.readFileSync(webProxyFile(), "utf8").replace(/^\uFEFF/, "");
		return (JSON.parse(raw) as { mode?: unknown })?.mode === "direct";
	} catch {
		return false;
	}
}

function writeDirectProxyMode(direct: boolean): void {
	const file = webProxyFile();
	if (direct) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify({ mode: "direct" }, null, 2)}\n`, "utf8");
	} else {
		fs.rmSync(file, { force: true });
	}
}

async function readSettingsObject(file: string): Promise<Record<string, unknown>> {
	const text = await readFileBounded(file, 1024 * 1024).then((bytes) => bytes.toString("utf8")).catch((error) => { if (error.code === "ENOENT") return "{}"; throw error; });
	const errors: ParseError[] = [];
	const parsed = parseJsonc(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
	if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PiSettingsValidationError("Settings file is not a valid object");
	return parsed as Record<string, unknown>;
}
async function readSettingsFileStrict(): Promise<Record<string, unknown>> {
	return readSettingsObject(settingsFile());
}
function mergedSettings(global: Record<string, unknown>, project: Record<string, unknown>): Record<string, unknown> {
	return { ...global, ...project, compaction: { ...objectOf(global.compaction), ...objectOf(project.compaction) }, retry: { ...objectOf(global.retry), ...objectOf(project.retry) }, httpProxy: global.httpProxy, cacheWarming: global.cacheWarming };
}

/** enabledModels 是 pi 的模型范围；没写或写错就不过滤 PiWeb 的选择器 */
export async function getEnabledModelPatterns(): Promise<string[] | null> {
	const patterns = (await readSettingsFileStrict()).enabledModels;
	if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) return null;
	return patterns;
}

function objectOf(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const isTokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function normalizedSettings(raw: Record<string, unknown>, directMode = false): PiSettings {
	const c = objectOf(raw.compaction);
	const r = objectOf(raw.retry);
	const num = (v: unknown, d: number) => (isTokenCount(v) ? v : d);
	const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? v as T : d);
	const rawProxy = typeof raw.httpProxy === "string" ? raw.httpProxy.trim() : DEFAULTS.httpProxy;
	return {
		compaction: {
			enabled: c.enabled !== false,
			reserveTokens: num(c.reserveTokens, DEFAULTS.compaction.reserveTokens),
			keepRecentTokens: num(c.keepRecentTokens, DEFAULTS.compaction.keepRecentTokens),
		},
		retry: {
			enabled: r.enabled !== false,
			maxRetries: num(r.maxRetries, DEFAULTS.retry.maxRetries),
			baseDelayMs: num(r.baseDelayMs, DEFAULTS.retry.baseDelayMs),
		},
		cacheWarming: oneOf(raw.cacheWarming, CACHE_WARMING_MODES, DEFAULTS.cacheWarming),
		steeringMode: oneOf(raw.steeringMode, QUEUE_MODES, DEFAULTS.steeringMode),
		followUpMode: oneOf(raw.followUpMode, QUEUE_MODES, DEFAULTS.followUpMode),
		httpProxy: rawProxy || (directMode ? "direct" : DEFAULTS.httpProxy),
	};
}

export async function getPiSettings(cwd?: string): Promise<PiSettings> {
	const global = await readSettingsFileStrict();
	const directMode = readDirectProxyMode();
	if (!cwd) return normalizedSettings(global, directMode);
	const projectRoot = await resolveWorkspacePath(cwd);
	const project = readJsoncSettingsObjectSync(path.join(projectRoot, ".pi", "settings.json"), { projectRoot });
	const trusted = resolveProjectTrust(cwd).trusted;
	return { ...normalizedSettings(mergedSettings(global, project), directMode), effective: normalizedSettings(trusted ? mergedSettings(global, project) : global, directMode), projectTrusted: trusted };
}

/**
 * 回显用：httpProxy 的 userinfo 密码打码（写入路径仍保留原值）。
 * 没有凭据的普通 URL 原样返回，回显与保存语义不变。
 */
export function redactPiSettingsForRead(settings: PiSettings): PiSettings {
	const redact = (value: PiSettings): PiSettings => ({
		...value,
		httpProxy: typeof value.httpProxy === "string" && value.httpProxy && value.httpProxy !== "direct" ? redactUrlCredentials(value.httpProxy) : value.httpProxy,
	});
	return { ...redact(settings), ...(settings.effective ? { effective: redact(settings.effective) } : {}) };
}

export class PiSettingsValidationError extends Error {}
export class PiSettingsRefreshError extends Error {
	constructor(public readonly patch: PiSettingsPatch, cause: unknown) {
		super("设置已保存，但部分活动会话未能刷新。", { cause });
	}
}

// 函数声明而不是箭头函数：TS 只对有显式声明的 never 函数做控制流收窄
function fail(message: string): never {
	throw new PiSettingsValidationError(message);
}

function validateNumberField(section: string, key: string, field: unknown): void {
	if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0 || field > MAX_NUMBER) fail(`${section}.${key} must be a non-negative integer`);
}

function validateString(key: string, value: unknown, max: number): string {
	if (typeof value !== "string") return fail(`${key} must be a string`);
	if (value.length > max) fail(`${key} is too long`);
	return value.trim();
}

export function validatePiSettingsPatch(value: unknown): PiSettingsPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid settings patch");
	const input = value as Record<string, unknown>;
	const known = ["compaction", "retry", "cacheWarming", "steeringMode", "followUpMode", "httpProxy"];
	if (Object.keys(input).some((key) => !known.includes(key))) fail("unknown settings field");
	const result: PiSettingsPatch = {};
	for (const section of ["compaction", "retry"] as const) {
		if (input[section] === undefined) continue;
		const part = input[section];
		if (!part || typeof part !== "object" || Array.isArray(part)) fail(`invalid ${section} settings`);
		const fields = { ...(part as Record<string, unknown>) };
		const allowed = section === "compaction" ? ["enabled", "reserveTokens", "keepRecentTokens"] : ["enabled", "maxRetries", "baseDelayMs"];
		for (const [key, field] of Object.entries(fields)) {
			if (!allowed.includes(key)) fail(`unknown ${section} field: ${key}`);
			if (key === "enabled") {
				if (typeof field !== "boolean") fail(`${section}.${key} must be boolean`);
			} else validateNumberField(section, key, field);
		}
		if (section === "compaction") result.compaction = fields as Partial<CompactionSettings>;
		else result.retry = fields as Partial<RetrySettings>;
	}
	if (input.cacheWarming !== undefined) {
		if (!CACHE_WARMING_MODES.includes(input.cacheWarming as CacheWarmingMode)) fail("cacheWarming must be off, streaming or idle");
		result.cacheWarming = input.cacheWarming as CacheWarmingMode;
	}
	for (const key of ["steeringMode", "followUpMode"] as const) {
		if (input[key] === undefined) continue;
		if (!QUEUE_MODES.includes(input[key] as QueueMode)) fail(`${key} must be all or one-at-a-time`);
		result[key] = input[key] as QueueMode;
	}
	if (input.httpProxy !== undefined) {
		const proxy = validateString("httpProxy", input.httpProxy, 2048);
		if (proxy && proxy !== "direct") {
			let url: URL | undefined;
			try {
				url = new URL(proxy);
			} catch {
				fail("httpProxy must be a URL such as http://127.0.0.1:7890");
			}
			if (!url || !/^(https?|socks[45]?h?):$/.test(url.protocol) || !url.hostname) fail("httpProxy must be an http, https or socks URL");
		}
		result.httpProxy = proxy;
	}
	return result;
}

export async function patchPiSettings(value: unknown, cwd?: string): Promise<PiSettingsPatch> {
	const patch = validatePiSettingsPatch(value);
	if (cwd && (patch.httpProxy !== undefined || patch.cacheWarming !== undefined)) throw new PiSettingsValidationError("Network proxy and cache warming are global settings");
	const projectRoot = cwd ? await resolveWorkspacePath(cwd) : undefined;
	const file = projectRoot ? path.join(projectRoot, ".pi", "settings.json") : settingsFile();
	// retryBusy：Windows 并发写时 settings.json 的 rename/lock 可能暂时 EACCES/EPERM/EBUSY，
	// 在锁内退避重试；合并式 patch 是幂等的，重试安全。重试耗尽由路由映射为 409/503。
	await withSettingsWriteLock(file, async () => {
		mutateJsoncSettingsFileSync(file, (raw) => {
			if (patch.compaction) raw.compaction = { ...objectOf(raw.compaction), ...patch.compaction };
			if (patch.retry) raw.retry = { ...objectOf(raw.retry), ...patch.retry };
			for (const key of ["cacheWarming", "steeringMode", "followUpMode"] as const) {
				if (patch[key] !== undefined) raw[key] = patch[key];
			}
			// 清空或直连 = 不在 Pi CLI 的 settings.json 留无效值；直连偏好单独记在 web-proxy.json。
			if (patch.httpProxy !== undefined) {
				if (patch.httpProxy && patch.httpProxy !== "direct") raw.httpProxy = patch.httpProxy;
				else delete raw.httpProxy;
			}
			return raw;
		}, { projectRoot });
		if (patch.httpProxy !== undefined) {
			writeDirectProxyMode(patch.httpProxy === "direct");
		}
		invalidateJsonFile(file);
	}, { retryBusy: true });
	// 正在运行的会话每次压缩/重试都从 SettingsManager 读：让它们重新读盘，改动立即生效
	try { await reloadSettingsManagers(); }
	catch (error) { throw new PiSettingsRefreshError(patch, error); }
	return patch;
}
