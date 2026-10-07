import { canonicalThinkingMap, normalizeThinkingLevelMap, THINKING_LEVELS, type ThinkingLevelMap } from "./thinking";

/** Browser-safe form helpers. Keep the source on each row, not indexed by model ID,
 * so renaming/removing a row never revives an old model or drops unexposed options. */
export interface ModelDraft {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
	/** pi 的 reasoning：支持思考（不写即 false，思考菜单只有 off） */
	reasoning?: boolean;
	/** pi 档位 → 发给提供商的值；null = 不支持该档；xhigh / max 必须写出才支持 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** input 含 image：能看图 */
	vision?: boolean;
	source?: Readonly<Record<string, unknown>>;
}

export function modelDraftFromConfig(value: unknown): ModelDraft {
	const source = value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: { id: typeof value === "string" ? value : "" };
	return {
		id: String(source.id ?? ""),
		name: typeof source.name === "string" ? source.name : "",
		contextWindow: typeof source.contextWindow === "number" ? source.contextWindow : undefined,
		maxTokens: typeof source.maxTokens === "number" ? source.maxTokens : undefined,
		reasoning: source.reasoning === true,
		thinkingLevelMap: normalizeThinkingLevelMap(source.thinkingLevelMap),
		vision: Array.isArray(source.input) && source.input.includes("image"),
		source,
	};
}

/** 档位映射按规范形式逐档比较（键的顺序、首尾空格不算改动） */
function sameThinkingMap(left: ThinkingLevelMap | undefined, right: ThinkingLevelMap | undefined): boolean {
	const a = canonicalThinkingMap(left);
	const b = canonicalThinkingMap(right);
	return THINKING_LEVELS.every((level) => a[level] === b[level]);
}

/** K/M use decimal units. Empty means the SDK default; NaN means invalid input. */
export function parseCapacity(text: string): number | undefined {
	const value = text.trim().toLowerCase();
	if (!value) return undefined;
	const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(value);
	if (!match) return NaN;
	const scaled = Math.round(Number(match[1]) * (match[2] === "k" ? 1000 : match[2] === "m" ? 1_000_000 : 1));
	return Number.isSafeInteger(scaled) && scaled > 0 ? scaled : NaN;
}

export function formatCapacity(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
	if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
	if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`;
	return String(value);
}

export function validateModelDrafts(models: ModelDraft[]): { index: number; reason: "id" | "capacity" } | undefined {
	const ids = new Set<string>();
	for (let index = 0; index < models.length; index += 1) {
		const model = models[index];
		const id = model.id.trim();
		if (!id || ids.has(id)) return { index, reason: "id" };
		ids.add(id);
		if ([model.contextWindow, model.maxTokens].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))) {
			return { index, reason: "capacity" };
		}
	}
	return undefined;
}

/** Only edited form fields replace the source; unknown/nested configuration is opaque. */
export function serializeModelDraft(model: Omit<ModelDraft, "name"> & { name?: string }): Record<string, unknown> {
	const result: Record<string, unknown> = { ...model.source };
	const original = model.source ? modelDraftFromConfig(model.source) : undefined;
	for (const field of ["id", "name", "contextWindow", "maxTokens"] as const) {
		if (original && Object.is(model[field], original[field])) continue;
		const value = model[field];
		if (field === "id" || field === "name") {
			const text = typeof value === "string" ? value.trim() : "";
			if (field === "id" || text) result[field] = text;
			else delete result[field];
		} else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) result[field] = value;
		else delete result[field];
	}
	// 能力字段同样只在改动时写：pi 的默认值是 reasoning false、input ["text"]，关掉时直接删键
	if (!original || (model.reasoning ?? false) !== original.reasoning) {
		if (model.reasoning) result.reasoning = true;
		else delete result.reasoning;
	}
	if (!original ? model.thinkingLevelMap !== undefined : !sameThinkingMap(model.thinkingLevelMap, original.thinkingLevelMap)) {
		const map = canonicalThinkingMap(model.thinkingLevelMap);
		if (Object.keys(map).length) result.thinkingLevelMap = map;
		else delete result.thinkingLevelMap;
	}
	if (!original || (model.vision ?? false) !== original.vision) {
		if (model.vision) result.input = ["text", "image"];
		else delete result.input;
	}
	return result;
}

export interface ProviderDraft {
	baseUrl: string;
	models: ModelDraft[];
	name?: string;
	api?: string;
	/** Blank means unchanged. Redacted secrets are restored by the server, never invented here. */
	apiKey?: string;
}

export function serializeProviderDraft(
	source: Readonly<Record<string, unknown>>,
	draft: ProviderDraft,
	defaultApi?: string,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...source };
	for (const field of ["baseUrl", "name", "api"] as const) {
		const value = draft[field];
		if (value === undefined || value === (typeof source[field] === "string" ? source[field] : "")) continue;
		if (value.trim()) result[field] = value.trim();
		else delete result[field];
	}
	if (draft.apiKey?.trim()) result.apiKey = draft.apiKey.trim();
	// An explicit empty array removes the overrides. Do not merge rows back by ID.
	if (draft.models.length || Object.prototype.hasOwnProperty.call(source, "models")) {
		result.models = draft.models.map(serializeModelDraft);
	}
	// Supply an API only for newly introduced builtin model overrides, not existing rows.
	if (draft.models.length && source.models === undefined && result.api === undefined && defaultApi) {
		result.api = defaultApi;
	}
	return result;
}

/**
 * 提供方块对 pi 有没有内容，与 pi applyModelsJson 同口径：非空 models、baseUrl、headers、compat、
 * 非空 modelOverrides、apiKey、oauth、authHeader 一样都没有，pi 就判整份 models.json 无效（只剩 api / name / 空 models 也算空）。
 */
export function providerOverrideHasContent(config: Readonly<Record<string, unknown>>): boolean {
	const overrides = config.modelOverrides;
	return (Array.isArray(config.models) && config.models.length > 0)
		|| Boolean(config.baseUrl || config.headers || config.compat || config.apiKey || config.oauth)
		|| (typeof overrides === "object" && overrides !== null && Object.keys(overrides).length > 0)
		|| config.authHeader !== undefined;
}

/**
 * 写回内置提供方的覆盖层：删空了（比如 pi 升级后已经内置、以前手动加的同 ID 模型）就整块移除，回到 pi 内置定义——
 * 空块会让 pi 拒绝整份配置、保存失败。hiddenKey：块里有不下发前端的 apiKey，要留着让服务端原样补回。
 */
export function withBuiltinOverride(
	providers: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
	id: string,
	override: Readonly<Record<string, unknown>>,
	hiddenKey = false,
): Record<string, Readonly<Record<string, unknown>>> {
	const next = { ...providers };
	if (hiddenKey || providerOverrideHasContent(override)) next[id] = override;
	else delete next[id];
	return next;
}
