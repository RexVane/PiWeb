/** Browser-safe form helpers. Keep the source on each row, not indexed by model ID,
 * so renaming/removing a row never revives an old model or drops unexposed options. */
export interface ModelDraft {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
	/** 输入模态里有 image（models.json 的 `input`）。undefined = 源里没写：pi 会当成只文本、把贴图换成占位文字 */
	vision?: boolean;
	source?: Readonly<Record<string, unknown>>;
	/** 来自 modelOverrides：只覆盖内置模型的部分字段。缺省 = models[] 里的定义或新加的行 */
	origin?: "override";
}

/**
 * models.json 里模型的 `input` 字段（pi 用它判断能不能收图）。
 * 没写 → pi 按只文本处理，而且提示语会说是「模型不支持图像」，很容易被当成模型能力问题。
 */
export function modelInputFor(vision: boolean): string[] {
	return vision ? ["text", "image"] : ["text"];
}

/**
 * pi 在 models[] 条目没写这些字段时用的值（provider-composer.js 的 modelFromJson：
 * `contextWindow ?? 128000`、`maxTokens ?? 16384`、`input ?? ["text"]`）。只用来向用户解释「不填会被当成什么」。
 *
 * PiWeb 不替用户编容量：maxTokens 会原样当成请求的 max_tokens 发出去（pi-ai simple-options），
 * contextWindow 决定 max_tokens 的钳制和自动压缩的时机——往大了猜，上游会直接拒绝请求；
 * 往小了猜只是提前压缩。所以只写端点报的或用户填的值，缺的交给体检卡片提醒。
 */
export const PI_MODEL_FALLBACKS = { contextWindow: 128_000, maxTokens: 16_384 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function modelDraftFromConfig(value: unknown): ModelDraft {
	const source = isRecord(value) ? value : { id: typeof value === "string" ? value : "" };
	const input = Array.isArray(source.input)
		? source.input.filter((item): item is string => typeof item === "string")
		: undefined;
	return {
		id: String(source.id ?? ""),
		name: typeof source.name === "string" ? source.name : "",
		contextWindow: typeof source.contextWindow === "number" ? source.contextWindow : undefined,
		maxTokens: typeof source.maxTokens === "number" ? source.maxTokens : undefined,
		// 只有源里写了 input 才算「声明过」：没写 ≠ 只文本，而是「会被 pi 当只文本」
		vision: input ? input.includes("image") : undefined,
		source,
	};
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 「获取可用模型」返回的一条 → 表单行：端点报了容量与视觉就带上，没报的留空（不猜） */
export function modelDraftFromCatalog(entry: { id: string; name?: string; contextWindow?: number; maxTokens?: number; vision?: boolean }): ModelDraft {
	const contextWindow = positiveInt(entry.contextWindow);
	const maxTokens = positiveInt(entry.maxTokens);
	return {
		id: entry.id.trim(),
		name: entry.name ?? "",
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(typeof entry.vision === "boolean" ? { vision: entry.vision } : {}),
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

/**
 * Only edited form fields replace the source; unknown/nested configuration is opaque.
 * 容量留空就不写（交给 pi 的缺省，见 PI_MODEL_FALLBACKS），不替用户编值。
 */
export function serializeModelDraft(model: Omit<ModelDraft, "name"> & { name?: string }): Record<string, unknown> {
	const result: Record<string, unknown> = { ...model.source };
	const original = model.source ? modelDraftFromConfig(model.source) : undefined;
	for (const field of ["id", "name", "contextWindow", "maxTokens"] as const) {
		const value = model[field];
		if (original && Object.is(value, original[field])) continue;
		if (field === "id" || field === "name") {
			const text = typeof value === "string" ? value.trim() : "";
			if (field === "id" || text) result[field] = text;
			else delete result[field];
		} else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) result[field] = value;
		else delete result[field];
	}
	// input 是数组：只在明确表态时写（端点报的或用户选的），不默认猜视觉
	// （猜错会把图片发给不收图的上游；留空只是被 pi 当纯文本，体检卡片会提醒）
	const vision = model.vision;
	if (vision === undefined) {
		// 源里声明过、现在选「未声明」= 明确取消这个声明（否则保留源值会让人取消不掉）
		if (original?.vision !== undefined) delete result.input;
	} else if (!Object.is(vision, original?.vision)) {
		result.input = modelInputFor(vision);
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
		: { definitions: draft.models.map((model) => serializeModelDraft(model)), overrides: undefined };
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
		const id = model.id.trim();
		const source = isRecord(model.source) ? model.source : undefined;
		// 自带 api / baseUrl 的 models[] 条目是手写的完整定义，原样留在 models[]
		const fullDefinition = model.origin !== "override" && (source?.api !== undefined || source?.baseUrl !== undefined);
		const keptOverride = model.origin === "override" && source !== undefined && modelDraftFromConfig(source).id === id;
		const asOverride = !fullDefinition && (catalogIds.has(id) || keptOverride);
		const serialized = serializeModelDraft(model);
		if (!asOverride) {
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

export type CustomModelField = "contextWindow" | "maxTokens" | "input";

/** 体检的一条：models[] 里有字段没写的模型（已写的值一并带上，界面要显示） */
export interface CustomModelGap {
	provider: string;
	/** 在 models[] 里的位置：手写的文件可能有重复 ID，按位置定位才准 */
	index: number;
	id: string;
	name: string | null;
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	missing: CustomModelField[];
}

/**
 * 体检：models.json 里哪些模型有字段没写、会落到 pi 的缺省上（见 PI_MODEL_FALLBACKS）。
 * 只看 providers[].models[]——modelOverrides 覆盖的是内置模型，那些模型 pi 的目录里有真值。
 * 读的是设置页已经载入的那份配置（密钥已去掉也不影响），保存后重新载入就自动刷新。
 */
export function customModelGaps(providers: Readonly<Record<string, unknown>>): CustomModelGap[] {
	const gaps: CustomModelGap[] = [];
	for (const [provider, config] of Object.entries(providers)) {
		const models = isRecord(config) && Array.isArray(config.models) ? config.models : [];
		models.forEach((model, index) => {
			if (!isRecord(model)) return;
			const id = typeof model.id === "string" ? model.id.trim() : "";
			if (!id) return;
			const missing: CustomModelField[] = [];
			if (model.contextWindow === undefined) missing.push("contextWindow");
			if (model.maxTokens === undefined) missing.push("maxTokens");
			if (!Array.isArray(model.input)) missing.push("input");
			if (!missing.length) return;
			const declared = modelDraftFromConfig(model);
			gaps.push({
				provider,
				index,
				id,
				name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : null,
				...(declared.contextWindow === undefined ? {} : { contextWindow: declared.contextWindow }),
				...(declared.maxTokens === undefined ? {} : { maxTokens: declared.maxTokens }),
				...(declared.vision === undefined ? {} : { vision: declared.vision }),
				missing,
			});
		});
	}
	return gaps;
}

/** 用户在体检卡片里给某个模型填的值；没填的字段不带 */
export interface ModelFieldFill {
	provider: string;
	index: number;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
}

/**
 * 按用户填的值补字段：只补空着的（已写的值不改），按 provider + 位置定位并核对 ID，对不上就跳过。
 * 不改入参；返回新的 providers 与实际补了几个模型。
 */
export function fillModelFields(providers: Readonly<Record<string, unknown>>, fills: readonly ModelFieldFill[]): { providers: Record<string, unknown>; filled: number } {
	const next = JSON.parse(JSON.stringify(providers)) as Record<string, unknown>;
	let filled = 0;
	for (const fill of fills) {
		const config = Object.prototype.hasOwnProperty.call(next, fill.provider) ? next[fill.provider] : undefined;
		const model = isRecord(config) && Array.isArray(config.models) ? config.models[fill.index] : undefined;
		if (!isRecord(model) || typeof model.id !== "string" || model.id.trim() !== fill.id) continue;
		let touched = false;
		for (const key of ["contextWindow", "maxTokens"] as const) {
			const value = positiveInt(fill[key]);
			if (model[key] === undefined && value !== undefined) {
				model[key] = value;
				touched = true;
			}
		}
		if (typeof fill.vision === "boolean" && !Array.isArray(model.input)) {
			model.input = modelInputFor(fill.vision);
			touched = true;
		}
		if (touched) filled += 1;
	}
	return { providers: next, filled };
}
