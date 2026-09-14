/** Browser-safe form helpers. Keep the source on each row, not indexed by model ID,
 * so renaming/removing a row never revives an old model or drops unexposed options. */
export interface ModelDraft {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
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
		source,
	};
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
