/**
 * pi 思考强度的纯函数（浏览器与服务端共用，不依赖 pi SDK）：档位、就近钳制、默认强度推导、自定义模型档位表。
 * 规则与 pi-ai 的 getSupportedThinkingLevels / clampThinkingLevel、pi 新建会话与切换模型时的默认值推导保持一致。
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** pi 没配置 defaultThinkingLevel 时用的默认值（DEFAULT_THINKING_LEVEL） */
export const PI_DEFAULT_THINKING_LEVEL: ThinkingLevelName = "medium";

/** 需要在 thinkingLevelMap 里显式写出才算支持的档位（其余档位不写即支持） */
export const OPT_IN_THINKING_LEVELS: readonly ThinkingLevelName[] = ["xhigh", "max"];

export function isThinkingLevel(value: unknown): value is ThinkingLevelName {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** pi 档位 → 发给提供商的值；null 表示不支持该档 */
export type ThinkingLevelMap = Partial<Record<ThinkingLevelName, string | null>>;

/** 与 pi-ai getSupportedThinkingLevels 相同：非推理模型只有 off；null 排除该档；xhigh / max 必须显式映射 */
export function supportedThinkingLevels(reasoning: boolean, map?: ThinkingLevelMap): ThinkingLevelName[] {
	if (!reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (OPT_IN_THINKING_LEVELS.includes(level)) return mapped !== undefined;
		return true;
	});
}

/** 与 pi-ai clampThinkingLevel 相同：不支持时先往高找最近的支持档，再往低找 */
export function clampThinkingLevel(level: string, supported: readonly string[]): string {
	if (supported.includes(level)) return level;
	const index = (THINKING_LEVELS as readonly string[]).indexOf(level);
	if (index === -1) return supported[0] ?? "off";
	for (let i = index; i < THINKING_LEVELS.length; i += 1) if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
	for (let i = index - 1; i >= 0; i -= 1) if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
	return supported[0] ?? "off";
}

/** thinkingBudgets 可配的档位（pi 只给这四档设 token 预算；xhigh / max 按 high 的预算） */
export const THINKING_BUDGET_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingBudgetLevel = (typeof THINKING_BUDGET_LEVELS)[number];

/** 没配置 thinkingBudgets 时 pi-ai 用的预算（DEFAULT_THINKING_BUDGETS），设置页拿来做占位提示 */
export const PI_DEFAULT_THINKING_BUDGETS: Record<ThinkingBudgetLevel, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
/** PiWeb 接受的单档预算上限（防手滑多打几个 0） */
export const MAX_THINKING_BUDGET = 2_000_000;

/** pi settings.json 里与「默认」有关的几项（全局设置） */
export interface ModelDefaults {
	/** defaultProvider + defaultModel：新会话的默认模型 */
	provider: string | null;
	modelId: string | null;
	/** defaultThinkingLevel：未设置时 pi 用 medium */
	thinkingLevel: ThinkingLevelName | null;
	/** modelThinkingLevels：按 `provider/modelId` 的默认强度，优先于全局默认 */
	modelThinkingLevels: Record<string, ThinkingLevelName>;
}

export const modelKey = (provider: string, id: string) => `${provider}/${id}`;

/** pi 新会话 / 切换模型时的默认强度：按模型设置 → 全局默认 → medium，再按模型能力钳制 */
export function defaultThinkingFor(defaults: ModelDefaults | null | undefined, provider: string, id: string, supported: readonly string[]): string {
	const level = defaults?.modelThinkingLevels[modelKey(provider, id)] ?? defaults?.thinkingLevel ?? PI_DEFAULT_THINKING_LEVEL;
	return clampThinkingLevel(level, supported);
}

/** 只保留合法档位键、值为字符串或 null 的映射；非对象返回 undefined */
export function normalizeThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: ThinkingLevelMap = {};
	for (const [key, mapped] of Object.entries(value as Record<string, unknown>)) {
		if (isThinkingLevel(key) && (mapped === null || typeof mapped === "string")) out[key] = mapped;
	}
	return out;
}

/** 档位表的一行：是否可用 + 发给提供商的值（空 = 用 pi 的档位名 / 提供商默认） */
export interface ThinkingLevelRow {
	level: ThinkingLevelName;
	enabled: boolean;
	value: string;
}

/** 把 thinkingLevelMap 展开成 7 行（表单用） */
export function thinkingRowsFromMap(map: ThinkingLevelMap | undefined): ThinkingLevelRow[] {
	return THINKING_LEVELS.map((level) => {
		const mapped = map?.[level];
		const optIn = OPT_IN_THINKING_LEVELS.includes(level);
		return { level, enabled: optIn ? typeof mapped === "string" : mapped !== null, value: typeof mapped === "string" ? mapped : "" };
	});
}

/**
 * 表单 7 行 → thinkingLevelMap。普通档位：关 = null，开且填了值 = 该值，开且留空 = 不写（用默认）；
 * xhigh / max：关 = 不写，开 = 填的值或档位名本身（pi 要求显式映射）。
 * draft：编辑中的表单状态——值不去空格，xhigh / max 开着但留空时记为 ""（输入框能清空重填），保存前再规范化。
 */
export function thinkingMapFromRows(rows: readonly ThinkingLevelRow[], options: { draft?: boolean } = {}): ThinkingLevelMap {
	const out: ThinkingLevelMap = {};
	for (const row of rows) {
		const filled = row.value.trim() !== "";
		const value = options.draft ? row.value : row.value.trim();
		if (OPT_IN_THINKING_LEVELS.includes(row.level)) {
			if (row.enabled) out[row.level] = filled ? value : options.draft ? "" : row.level;
		} else if (!row.enabled) out[row.level] = null;
		else if (filled) out[row.level] = value;
	}
	return out;
}

/** 写进 models.json 前的规范形式（去空格、留空的 xhigh / max 用档位名、普通档位的空值不写） */
export function canonicalThinkingMap(map: ThinkingLevelMap | undefined): ThinkingLevelMap {
	return thinkingMapFromRows(thinkingRowsFromMap(map));
}
