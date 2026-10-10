/**
 * pi-settings：读写 pi settings.json 里 PiWeb 暴露的几项（压缩 / 自动重试 / 思考强度与默认模型）。
 * 与项目信任同一个外科手术式 JSON patch 方式；键名与 pi 完全一致，终端 pi 与 PiWeb 共用同一份配置。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, reloadSettingsManagers } from "../pi";
import { withExternalSettingsLock, withSettingsWriteLock } from "./settings-write-lock";
import { isThinkingLevel, MAX_THINKING_BUDGET, THINKING_BUDGET_LEVELS, type ModelDefaults, type ThinkingBudgetLevel, type ThinkingLevelName } from "../models/thinking";

interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

interface ThinkingSettings {
	/** defaultThinkingLevel；null = 未设置（pi 用 medium） */
	defaultLevel: ThinkingLevelName | null;
	/** modelThinkingLevels：`provider/modelId` → 该模型的默认强度 */
	modelLevels: Record<string, ThinkingLevelName>;
	/** thinkingBudgets：按 token 预算思考的提供商用；未设置的档位用内置预算 */
	budgets: Partial<Record<ThinkingBudgetLevel, number>>;
}

export interface PiSettings {
	compaction: CompactionSettings;
	retry: RetrySettings;
	thinking: ThinkingSettings;
	/** defaultProvider + defaultModel；任一缺失视为未设置 */
	defaultModel: { provider: string; modelId: string } | null;
}

export interface PiSettingsPatch {
	compaction?: Partial<CompactionSettings>;
	retry?: Partial<RetrySettings>;
	thinking?: {
		defaultLevel?: ThinkingLevelName | null;
		/** null 删除该模型的设置 */
		modelLevels?: Record<string, ThinkingLevelName | null>;
		/** null 删除该档位的预算 */
		budgets?: Partial<Record<ThinkingBudgetLevel, number | null>>;
	};
	/** null 清除默认模型 */
	defaultModel?: { provider: string; modelId: string } | null;
}

const DEFAULTS: Pick<PiSettings, "compaction" | "retry"> = {
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
};

async function readSettingsFileStrict(): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await fs.readFile(path.join(getAgentDir(), "settings.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings.json must contain a JSON object");
	return parsed as Record<string, unknown>;
}

function section(raw: Record<string, unknown>, key: "compaction" | "retry"): Record<string, unknown> {
	const value = raw[key];
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectOf(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 读回时宽松：手改出来的非法值当作未设置，不让整个设置页失败 */
function thinkingFrom(raw: Record<string, unknown>): ThinkingSettings {
	const modelLevels: Record<string, ThinkingLevelName> = {};
	for (const [key, level] of Object.entries(objectOf(raw.modelThinkingLevels))) {
		if (isModelKey(key) && isThinkingLevel(level)) modelLevels[key] = level;
	}
	const budgets: Partial<Record<ThinkingBudgetLevel, number>> = {};
	const rawBudgets = objectOf(raw.thinkingBudgets);
	for (const level of THINKING_BUDGET_LEVELS) {
		const value = rawBudgets[level];
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) budgets[level] = value;
	}
	return { defaultLevel: isThinkingLevel(raw.defaultThinkingLevel) ? raw.defaultThinkingLevel : null, modelLevels, budgets };
}

function defaultModelFrom(raw: Record<string, unknown>): PiSettings["defaultModel"] {
	return typeof raw.defaultProvider === "string" && raw.defaultProvider && typeof raw.defaultModel === "string" && raw.defaultModel
		? { provider: raw.defaultProvider, modelId: raw.defaultModel }
		: null;
}

export async function getPiSettings(): Promise<PiSettings> {
	const raw = await readSettingsFileStrict();
	const c = (raw.compaction ?? {}) as Record<string, unknown>;
	const r = (raw.retry ?? {}) as Record<string, unknown>;
	const num = (v: unknown, d: number) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : d);
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
		thinking: thinkingFrom(raw),
		defaultModel: defaultModelFrom(raw),
	};
}

/** 模型目录附带的默认值（新会话页显示用）；settings.json 读不了时返回 null，不影响目录 */
export async function getModelDefaults(): Promise<ModelDefaults | null> {
	try {
		const raw = await readSettingsFileStrict();
		const thinking = thinkingFrom(raw);
		const model = defaultModelFrom(raw);
		return { provider: model?.provider ?? null, modelId: model?.modelId ?? null, thinkingLevel: thinking.defaultLevel, modelThinkingLevels: thinking.modelLevels };
	} catch {
		return null;
	}
}

/** enabledModels is Pi's model scope; an absent/invalid setting means no PiWeb-side filtering. */
export async function getEnabledModelPatterns(): Promise<string[] | null> {
	try {
		const patterns = (await readSettingsFileStrict()).enabledModels;
		return Array.isArray(patterns) && patterns.every((pattern) => typeof pattern === "string") ? patterns : null;
	} catch {
		return null;
	}
}

export class PiSettingsValidationError extends Error {}

/** `provider/modelId`：提供商段不能为空，模型 ID 可以再带 /（如 openrouter 的 anthropic/claude-…） */
function isModelKey(key: string): boolean {
	const slash = key.indexOf("/");
	return key.length <= 300 && slash > 0 && slash < key.length - 1 && !/[\u0000-\u001f]/.test(key);
}

function plainObject(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new PiSettingsValidationError(`invalid ${what}`);
	return value as Record<string, unknown>;
}

function validateThinkingPatch(value: unknown): NonNullable<PiSettingsPatch["thinking"]> {
	const input = plainObject(value, "thinking settings");
	const result: NonNullable<PiSettingsPatch["thinking"]> = {};
	for (const [key, field] of Object.entries(input)) {
		if (key === "defaultLevel") {
			if (field !== null && !isThinkingLevel(field)) throw new PiSettingsValidationError("thinking.defaultLevel must be a thinking level or null");
			result.defaultLevel = field;
		} else if (key === "modelLevels") {
			const entries = Object.entries(plainObject(field, "thinking.modelLevels"));
			if (entries.length > 200) throw new PiSettingsValidationError("too many model thinking levels");
			result.modelLevels = {};
			for (const [model, level] of entries) {
				if (!isModelKey(model)) throw new PiSettingsValidationError(`invalid model key: ${model.slice(0, 80)}`);
				if (level !== null && !isThinkingLevel(level)) throw new PiSettingsValidationError(`invalid thinking level for ${model.slice(0, 80)}`);
				result.modelLevels[model] = level;
			}
		} else if (key === "budgets") {
			result.budgets = {};
			for (const [level, budget] of Object.entries(plainObject(field, "thinking.budgets"))) {
				if (!(THINKING_BUDGET_LEVELS as readonly string[]).includes(level)) throw new PiSettingsValidationError(`unknown thinking budget level: ${level}`);
				if (budget !== null && (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget <= 0 || budget > MAX_THINKING_BUDGET)) {
					throw new PiSettingsValidationError(`thinking.budgets.${level} must be a positive integer up to ${MAX_THINKING_BUDGET} or null`);
				}
				result.budgets[level as ThinkingBudgetLevel] = budget;
			}
		} else throw new PiSettingsValidationError(`unknown thinking field: ${key}`);
	}
	return result;
}

function validateDefaultModelPatch(value: unknown): PiSettingsPatch["defaultModel"] {
	if (value === null) return null;
	const input = plainObject(value, "default model");
	if (Object.keys(input).some((key) => key !== "provider" && key !== "modelId")) throw new PiSettingsValidationError("unknown default model field");
	const { provider, modelId } = input;
	if (typeof provider !== "string" || !provider.trim() || provider.length > 200 || provider.includes("/")) throw new PiSettingsValidationError("defaultModel.provider is invalid");
	if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 300) throw new PiSettingsValidationError("defaultModel.modelId is invalid");
	return { provider: provider.trim(), modelId: modelId.trim() };
}

export function validatePiSettingsPatch(value: unknown): PiSettingsPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new PiSettingsValidationError("invalid settings patch");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !["compaction", "retry", "thinking", "defaultModel"].includes(key))) throw new PiSettingsValidationError("unknown settings field");
	const result: PiSettingsPatch = {};
	for (const section of ["compaction", "retry"] as const) {
		if (input[section] === undefined) continue;
		const part = input[section];
		if (!part || typeof part !== "object" || Array.isArray(part)) throw new PiSettingsValidationError(`invalid ${section} settings`);
		const fields = part as Record<string, unknown>;
		const allowed = section === "compaction" ? ["enabled", "reserveTokens", "keepRecentTokens"] : ["enabled", "maxRetries", "baseDelayMs"];
		for (const [key, field] of Object.entries(fields)) {
			if (!allowed.includes(key)) throw new PiSettingsValidationError(`unknown ${section} field: ${key}`);
			if (key === "enabled") {
				if (typeof field !== "boolean") throw new PiSettingsValidationError(`${section}.${key} must be boolean`);
			} else if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0 || field > 1_000_000_000) {
				throw new PiSettingsValidationError(`${section}.${key} must be a non-negative integer`);
			}
		}
		if (section === "compaction") result.compaction = fields as Partial<CompactionSettings>;
		else result.retry = fields as Partial<RetrySettings>;
	}
	if (input.thinking !== undefined) result.thinking = validateThinkingPatch(input.thinking);
	if (input.defaultModel !== undefined) result.defaultModel = validateDefaultModelPatch(input.defaultModel);
	return result;
}

/** 合并「键 → 值或 null」的补丁：null 删除，空对象整个删掉（与 pi removeModelThinkingLevel 一致） */
function mergeKeyed(raw: Record<string, unknown>, field: string, patch: Record<string, unknown>): void {
	const next = { ...objectOf(raw[field]) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete next[key];
		else next[key] = value;
	}
	if (Object.keys(next).length) raw[field] = next;
	else delete raw[field];
}

function applyPatch(raw: Record<string, unknown>, patch: PiSettingsPatch): void {
	if (patch.compaction) raw.compaction = { ...section(raw, "compaction"), ...patch.compaction };
	if (patch.retry) raw.retry = { ...section(raw, "retry"), ...patch.retry };
	if (patch.thinking) {
		const { defaultLevel, modelLevels, budgets } = patch.thinking;
		if (defaultLevel === null) delete raw.defaultThinkingLevel;
		else if (defaultLevel !== undefined) raw.defaultThinkingLevel = defaultLevel;
		if (modelLevels) mergeKeyed(raw, "modelThinkingLevels", modelLevels);
		if (budgets) mergeKeyed(raw, "thinkingBudgets", budgets);
	}
	if (patch.defaultModel === null) {
		delete raw.defaultProvider;
		delete raw.defaultModel;
	} else if (patch.defaultModel) {
		raw.defaultProvider = patch.defaultModel.provider;
		raw.defaultModel = patch.defaultModel.modelId;
	}
}

export async function patchPiSettings(value: unknown): Promise<void> {
	const patch = validatePiSettingsPatch(value);
	const file = path.join(getAgentDir(), "settings.json");
	await withSettingsWriteLock(file, () => withExternalSettingsLock(file, async () => {
		const raw = await readSettingsFileStrict();
		applyPatch(raw, patch);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(raw, null, "\t"), "utf8");
			await fs.rename(temporary, file);
		} finally {
			await fs.rm(temporary, { force: true }).catch(() => undefined);
		}
	}));
	// 正在运行的会话每次压缩/重试、新建会话与切换模型取默认强度都从 SettingsManager 读：让它们重新读盘，改动立即生效
	// （思考预算在会话创建时读入，对新会话生效）
	await reloadSettingsManagers();
}
