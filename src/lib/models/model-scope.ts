import { resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";

export type ModelScopeRuntime = Parameters<typeof resolveModelScopeWithDiagnostics>[1];

/** Apply Pi's exact model-pattern semantics to a list used by PiWeb's model picker. */
export async function filterModelsByPiScope<T extends { provider: string; id: string }>(
	models: T[],
	patterns: string[],
	runtime: ModelScopeRuntime,
): Promise<T[]> {
	if (patterns.length === 0) return models;
	const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, runtime);
	const allowed = new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
	return models.filter((model) => allowed.has(`${model.provider}/${model.id}`));
}
