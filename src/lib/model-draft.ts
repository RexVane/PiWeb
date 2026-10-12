/** Browser-safe form helpers. Keep the source on each row, not indexed by model ID,
 * so renaming/removing a row never revives an old model or drops unexposed options. */
export interface ModelDraft {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
	source?: Readonly<Record<string, unknown>>;
	/** 来自 modelOverrides：只覆盖内置模型的部分字段。缺省 = models[] 里的定义或新加的行 */
	origin?: "override";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function modelDraftFromConfig(value: unknown): ModelDraft {
	const source = isRecord(value) ? value : { id: typeof value === "string" ? value : "" };
	return {
		id: String(source.id ?? ""),
		name: typeof source.name === "string" ? source.name : "",
		contextWindow: typeof source.contextWindow === "number" ? source.contextWindow : undefined,
		maxTokens: typeof source.maxTokens === "number" ? source.maxTokens : undefined,
		source,
	};
}

/** modelOverrides 的一条：键是模型 ID，值只含要覆盖的字段 */
export function modelDraftFromOverride(id: string, value: unknown): ModelDraft {
	return { ...modelDraftFromConfig({ ...(isRecord(value) ? value : {}), id }), origin: "override" };
}

/** 内置 provider 的 models.json 条目 → 表单行：models[] 的定义在前，modelOverrides 的覆盖在后 */
export function modelDraftsFromProviderConfig(config: unknown): ModelDraft[] {
	const source = isRecord(config) ? config : {};
	const definitions = Array.isArray(source.models) ? source.models.map(modelDraftFromConfig) : [];
	const overrides = isRecord(source.modelOverrides)
		? Object.entries(source.modelOverrides).map(([id, value]) => modelDraftFromOverride(id, value))
		: [];
	return [...definitions, ...overrides];
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
	/** 内置 provider 的目录模型 ID：给了就按 splitBuiltinModels 把覆盖已有模型的行写进 modelOverrides */
	catalogIds?: ReadonlySet<string>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...source };
	for (const field of ["baseUrl", "name", "api"] as const) {
		const value = draft[field];
		if (value === undefined || value === (typeof source[field] === "string" ? source[field] : "")) continue;
		if (value.trim()) result[field] = value.trim();
		else delete result[field];
	}
	if (draft.apiKey?.trim()) result.apiKey = draft.apiKey.trim();
	const { definitions, overrides } = catalogIds
		? splitBuiltinModels(draft.models, catalogIds)
		: { definitions: draft.models.map(serializeModelDraft), overrides: undefined };
	// An explicit empty array removes the overrides. Do not merge rows back by ID.
	if (definitions.length || Object.prototype.hasOwnProperty.call(source, "models")) {
		result.models = definitions;
	}
	// 表单载入了全部 modelOverrides，这里整体替换；删光了就去掉这个键
	if (overrides) {
		if (Object.keys(overrides).length) result.modelOverrides = overrides;
		else delete result.modelOverrides;
	}
	// Supply an API only for newly introduced builtin model definitions, not existing rows.
	if (definitions.length && source.models === undefined && result.api === undefined && defaultApi) {
		result.api = defaultApi;
	}
	return result;
}

/**
 * 内置 provider 的表单行分流。models[] 里与内置模型同 ID 的条目会被 SDK 当成新定义整条重建
 * （reasoning / 上下文 / 价格 / 思考档位回到默认值，provider 级 api 还会顶掉模型自己的协议），
 * 所以覆盖已有模型要写 modelOverrides：只写填了的字段，其余沿用内置值。
 * - 自带 api / baseUrl 的 models[] 条目是手写的完整定义，原样留在 models[]；
 * - ID 在目录里，或来自 modelOverrides 且 ID 没改 → modelOverrides（没有要覆盖的字段就不写）；
 * - 其余是新模型 → models[]。
 */
function splitBuiltinModels(models: ModelDraft[], catalogIds: ReadonlySet<string>): {
	definitions: Record<string, unknown>[];
	overrides: Record<string, unknown>;
} {
	const definitions: Record<string, unknown>[] = [];
	const overrides: Array<[string, Record<string, unknown>]> = [];
	for (const model of models) {
		const serialized = serializeModelDraft(model);
		const id = String(serialized.id ?? "");
		const fullDefinition = model.origin !== "override" && (serialized.api !== undefined || serialized.baseUrl !== undefined);
		const keptOverride = model.origin === "override" && model.source !== undefined && modelDraftFromConfig(model.source).id === id;
		if (fullDefinition || !(catalogIds.has(id) || keptOverride)) {
			definitions.push(serialized);
			continue;
		}
		const fields = { ...serialized };
		delete fields.id;
		if (Object.keys(fields).length) overrides.push([id, fields]);
	}
	// fromEntries 按数据属性写入，"__proto__" 这类 ID 也不会改原型
	return { definitions, overrides: Object.fromEntries(overrides) };
}

/** 条目里只剩这些字段时，SDK 不认它（见 isInertProviderConfig） */
const INERT_PROVIDER_FIELDS = new Set(["api", "name", "models", "modelOverrides"]);

/**
 * 内置 provider 的 models.json 条目是否「什么都没覆盖」。SDK 要求条目至少有非空的 models / modelOverrides、
 * baseUrl、headers、compat、apiKey、oauth、authHeader 之一，否则报错、整份 models.json 存不进去；
 * 只剩 api / name 这类只对 models[] 有用的字段时，删掉条目才等于「全用内置默认」。
 * 有不认识的字段就交给 SDK 校验，不替用户删。注意前端拿到的配置已去掉 apiKey，调用方要另外排除存了密钥的条目。
 */
export function isInertProviderConfig(config: Readonly<Record<string, unknown>>): boolean {
	if (Array.isArray(config.models) && config.models.length) return false;
	if (isRecord(config.modelOverrides) && Object.keys(config.modelOverrides).length) return false;
	return Object.keys(config).every((field) => INERT_PROVIDER_FIELDS.has(field));
}
