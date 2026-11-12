/**
 * pi-settings：读写 pi settings.json 里 PiWeb 设置面板管的那部分
 * （压缩 / 自动重试 / 缓存预热 / 排队投递方式 / 代理）。
 * 与项目信任同一个外科手术式 JSON patch 方式：只动点名的字段，其余原样留着。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { invalidateJsonFile, readJsonObject, readJsonObjectFresh } from "./agent-config";
import { getAgentDir, reloadSettingsManagers } from "./pi";
import { withExternalSettingsLock, withSettingsWriteLock } from "./settings-write-lock";

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

async function readSettingsFileStrict(): Promise<Record<string, unknown>> {
	return readJsonObject(settingsFile());
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

export async function getPiSettings(): Promise<PiSettings> {
	const raw = await readSettingsFileStrict();
	const c = objectOf(raw.compaction);
	const r = objectOf(raw.retry);
	const num = (v: unknown, d: number) => (isTokenCount(v) ? v : d);
	const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? v as T : d);
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
		httpProxy: typeof raw.httpProxy === "string" ? raw.httpProxy : DEFAULTS.httpProxy,
	};
}

export class PiSettingsValidationError extends Error {}

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
		if (proxy) {
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

export async function patchPiSettings(value: unknown): Promise<PiSettingsPatch> {
	const patch = validatePiSettingsPatch(value);
	const file = settingsFile();
	await withSettingsWriteLock(file, () => withExternalSettingsLock(file, async () => {
		const raw = await readJsonObjectFresh(file);
		if (patch.compaction) raw.compaction = { ...objectOf(raw.compaction), ...patch.compaction };
		if (patch.retry) raw.retry = { ...objectOf(raw.retry), ...patch.retry };
		for (const key of ["cacheWarming", "steeringMode", "followUpMode"] as const) {
			if (patch[key] !== undefined) raw[key] = patch[key];
		}
		// 清空 = 删掉键，回到 pi 的默认行为（不留空字符串）
		if (patch.httpProxy !== undefined) {
			if (patch.httpProxy) raw.httpProxy = patch.httpProxy;
			else delete raw.httpProxy;
		}
		await fs.mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(raw, null, "\t"), "utf8");
			await fs.rename(temporary, file);
		} finally {
			await fs.rm(temporary, { force: true }).catch(() => undefined);
		}
		invalidateJsonFile(file);
	}));
	// 正在运行的会话每次压缩/重试都从 SettingsManager 读：让它们重新读盘，改动立即生效
	await reloadSettingsManagers();
	return patch;
}
