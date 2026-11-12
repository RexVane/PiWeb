/**
 * pi-settings：读写 pi settings.json 里 PiWeb 设置面板管的那部分
 * （压缩 / 自动重试 / 缓存预热 / 排队投递方式 / 代理 / shell 路径）。
 * 与项目信任同一个外科手术式 JSON patch 方式：只动点名的字段，其余原样留着。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { invalidateJsonFile, readJsonObject, readJsonObjectFresh } from "./agent-config";
import { getAgentDir, reloadSettingsManagers } from "./pi";
import { withExternalSettingsLock, withSettingsWriteLock } from "./settings-write-lock";

/** 按模型单独设的压缩阈值；没写的那一项回落到通用值 */
export interface CompactionModelOverride {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	/**
	 * 键是 `provider/modelId`。上下文只有几千的本地模型和上百万的云端模型共用一个阈值不合适：
	 * 通用值给大模型留的余量，小模型一上来就超了。
	 */
	modelOverrides: Record<string, CompactionModelOverride>;
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
	/** 空串 = 用平台默认 shell */
	shellPath: string;
}

/** 写入用的补丁：没出现的字段不动；modelOverrides 里值为 null 的键表示删掉那个模型的覆盖 */
export interface PiSettingsPatch {
	compaction?: Partial<Omit<CompactionSettings, "modelOverrides">> & { modelOverrides?: Record<string, CompactionModelOverride | null> };
	retry?: Partial<RetrySettings>;
	cacheWarming?: CacheWarmingMode;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	httpProxy?: string;
	shellPath?: string;
}

const DEFAULTS: PiSettings = {
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, modelOverrides: {} },
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
	cacheWarming: "idle",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	httpProxy: "",
	shellPath: "",
};

const CACHE_WARMING_MODES: readonly CacheWarmingMode[] = ["off", "streaming", "idle"];
const QUEUE_MODES: readonly QueueMode[] = ["all", "one-at-a-time"];
const TOKEN_FIELDS = ["reserveTokens", "keepRecentTokens"] as const;
const MAX_NUMBER = 1_000_000_000;
const MAX_MODEL_OVERRIDES = 200;

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

/** 读出来的覆盖表：写坏的条目（不是对象、数值不合法）直接跳过，不让一条坏数据挡住整个面板 */
function readModelOverrides(value: unknown): Record<string, CompactionModelOverride> {
	const out: Record<string, CompactionModelOverride> = {};
	for (const [key, raw] of Object.entries(objectOf(value))) {
		const entry = objectOf(raw);
		const override: CompactionModelOverride = {};
		for (const field of TOKEN_FIELDS) if (isTokenCount(entry[field])) override[field] = entry[field];
		if (Object.keys(override).length > 0) out[key] = override;
	}
	return out;
}

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
			modelOverrides: readModelOverrides(c.modelOverrides),
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
		shellPath: typeof raw.shellPath === "string" ? raw.shellPath : DEFAULTS.shellPath,
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

function validateModelOverrides(value: unknown): Record<string, CompactionModelOverride | null> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail("compaction.modelOverrides must be an object");
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_MODEL_OVERRIDES) fail("too many compaction model overrides");
	const out: Record<string, CompactionModelOverride | null> = {};
	for (const [key, raw] of entries) {
		// pi 按 `provider/modelId` 精确匹配；没有斜杠的键永远匹配不上，写进去只是垃圾
		if (!key || key.length > 300 || !/^[^/\s]+\/\S+$/.test(key)) fail(`invalid model key: ${key || "(empty)"} (expected provider/modelId)`);
		if (raw === null) {
			out[key] = null;
			continue;
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`compaction.modelOverrides["${key}"] must be an object or null`);
		const override: CompactionModelOverride = {};
		for (const [field, fieldValue] of Object.entries(raw as Record<string, unknown>)) {
			if (!(TOKEN_FIELDS as readonly string[]).includes(field)) fail(`unknown compaction override field: ${field}`);
			validateNumberField(`compaction.modelOverrides["${key}"]`, field, fieldValue);
			override[field as (typeof TOKEN_FIELDS)[number]] = fieldValue as number;
		}
		// 两项都没写的覆盖等于没有覆盖：当作删除，不留空对象
		out[key] = Object.keys(override).length > 0 ? override : null;
	}
	return out;
}

function validateString(key: string, value: unknown, max: number): string {
	if (typeof value !== "string") return fail(`${key} must be a string`);
	if (value.length > max) fail(`${key} is too long`);
	return value.trim();
}

export function validatePiSettingsPatch(value: unknown): PiSettingsPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid settings patch");
	const input = value as Record<string, unknown>;
	const known = ["compaction", "retry", "cacheWarming", "steeringMode", "followUpMode", "httpProxy", "shellPath"];
	if (Object.keys(input).some((key) => !known.includes(key))) fail("unknown settings field");
	const result: PiSettingsPatch = {};
	for (const section of ["compaction", "retry"] as const) {
		if (input[section] === undefined) continue;
		const part = input[section];
		if (!part || typeof part !== "object" || Array.isArray(part)) fail(`invalid ${section} settings`);
		const fields = { ...(part as Record<string, unknown>) };
		const allowed = section === "compaction" ? ["enabled", "reserveTokens", "keepRecentTokens", "modelOverrides"] : ["enabled", "maxRetries", "baseDelayMs"];
		let modelOverrides: Record<string, CompactionModelOverride | null> | undefined;
		for (const [key, field] of Object.entries(fields)) {
			if (!allowed.includes(key)) fail(`unknown ${section} field: ${key}`);
			if (key === "enabled") {
				if (typeof field !== "boolean") fail(`${section}.${key} must be boolean`);
			} else if (key === "modelOverrides") {
				modelOverrides = validateModelOverrides(field);
			} else validateNumberField(section, key, field);
		}
		if (section === "compaction") result.compaction = { ...(fields as Partial<CompactionSettings>), ...(modelOverrides ? { modelOverrides } : {}) } as PiSettingsPatch["compaction"];
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
	if (input.shellPath !== undefined) result.shellPath = validateString("shellPath", input.shellPath, 1024);
	return result;
}

/** pi 支持 shellPath 以 `~` 开头：存在性检查前按它的规则展开 */
function expandHome(value: string): string {
	return value === "~" || value.startsWith("~/") || value.startsWith("~\\") ? path.join(os.homedir(), value.slice(1)) : value;
}

export async function patchPiSettings(value: unknown): Promise<PiSettingsPatch> {
	const patch = validatePiSettingsPatch(value);
	// 写错的 shell 路径不会当场报错，而是之后每一次 bash 工具都失败；存进去之前先确认文件在
	if (patch.shellPath) {
		const exists = await fs.stat(expandHome(patch.shellPath)).then((stat) => stat.isFile(), () => false);
		if (!exists) throw new PiSettingsValidationError(`shell not found: ${patch.shellPath}`);
	}
	const file = settingsFile();
	await withSettingsWriteLock(file, () => withExternalSettingsLock(file, async () => {
		const raw = await readJsonObjectFresh(file);
		if (patch.compaction) {
			const { modelOverrides, ...rest } = patch.compaction;
			const next: Record<string, unknown> = { ...objectOf(raw.compaction), ...rest };
			if (modelOverrides) {
				const merged: Record<string, unknown> = { ...objectOf(next.modelOverrides) };
				for (const [key, override] of Object.entries(modelOverrides)) {
					if (override === null) delete merged[key];
					else merged[key] = override;
				}
				// 一条都不剩就把键删掉，别在 settings.json 里留一个空对象
				if (Object.keys(merged).length > 0) next.modelOverrides = merged;
				else delete next.modelOverrides;
			}
			raw.compaction = next;
		}
		if (patch.retry) raw.retry = { ...objectOf(raw.retry), ...patch.retry };
		for (const key of ["cacheWarming", "steeringMode", "followUpMode"] as const) {
			if (patch[key] !== undefined) raw[key] = patch[key];
		}
		// 清空 = 删掉键，回到 pi 的默认行为（不留空字符串）
		for (const key of ["httpProxy", "shellPath"] as const) {
			if (patch[key] === undefined) continue;
			if (patch[key]) raw[key] = patch[key];
			else delete raw[key];
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
