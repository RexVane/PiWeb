import { resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";

export type ModelScopeRuntime = Parameters<typeof resolveModelScopeWithDiagnostics>[1];

/** 用 pi 自己的模型通配规则过滤 PiWeb 选择器里的模型 */
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
