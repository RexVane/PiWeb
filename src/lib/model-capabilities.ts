import { customModelGaps, fillModelFields, parseCapacity, type ModelFieldFill } from "./model-draft";
import { matchOfficialModel, type OfficialThinkingModel } from "./thinking-config";

export interface ReportedModelCapabilities {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	reasoning?: boolean;
}
export interface OfficialModelCapabilities extends OfficialThinkingModel {
	contextWindow: number;
	maxTokens: number;
	input: readonly string[];
}

/** Only fill absent declarations. Endpoint limits beat the catalog; existing values (including false)
 * and modelOverrides beat both. Unknown models never inherit another generation or SDK defaults. */
export function inferModelCapabilities(
	providers: Readonly<Record<string, unknown>>,
	reported: ReadonlyMap<string, readonly ReportedModelCapabilities[]>,
	catalog: readonly OfficialModelCapabilities[],
): ReturnType<typeof fillModelFields> {
	const fills: ModelFieldFill[] = customModelGaps(providers).map((gap) => {
		const endpoint = reported.get(gap.provider)?.find((model) => model.id === gap.id);
		const official = matchOfficialModel({ provider: gap.provider, id: gap.id }, catalog);
		// Gateways sometimes encode a smaller context deployment as @500k / :128k.
		const suffix = /[@:]([\d.]+[km])$/i.exec(gap.id);
		const deploymentLimit = suffix ? parseCapacity(suffix[1]) : undefined;
		const contextWindow = official && deploymentLimit && Number.isFinite(deploymentLimit)
			? Math.min(official.contextWindow, deploymentLimit) : official?.contextWindow;
		return {
			provider: gap.provider, index: gap.index, id: gap.id,
			contextWindow: endpoint?.contextWindow ?? contextWindow,
			maxTokens: endpoint?.maxTokens ?? official?.maxTokens,
			vision: endpoint?.vision ?? (official ? official.input.includes("image") : undefined),
			reasoning: endpoint?.reasoning ?? official?.reasoning,
		};
	});
	return fillModelFields(providers, fills);
}
