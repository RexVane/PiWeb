import { THINKING_LEVELS } from "./thinking-level";
import { supportedThinkingLevelsOf } from "./thinking-probe";

export type ThinkingLevelMap = Record<string, string | null>;
export interface ThinkingLevelRow { level: string; value: string }
/** Start with low/low; subsequent clicks fill the next unused standard level. */
export const THINKING_ADD_ORDER = ["low", "medium", "high", "xhigh", "max", "off", "minimal"] as const;
export const thinkingApiValue = (level: string) => level === "off" ? "none" : level;

export function thinkingRowsFromMap(map: ThinkingLevelMap): ThinkingLevelRow[] {
	return supportedThinkingLevelsOf(true, map).map((level) => ({ level, value: map[level] ?? thinkingApiValue(level) }));
}
export function nextThinkingRow(rows: readonly ThinkingLevelRow[]): ThinkingLevelRow | null {
	const used = new Set(rows.map((row) => row.level));
	const level = THINKING_ADD_ORDER.find((level) => !used.has(level));
	return level ? { level, value: thinkingApiValue(level) } : null;
}
export function validThinkingRows(rows: readonly ThinkingLevelRow[]): boolean {
	const used = new Set<string>();
	return rows.length > 0 && rows.length <= THINKING_LEVELS.length && rows.every(({ level, value }) => {
		if (!THINKING_LEVELS.includes(level) || used.has(level) || !value.trim() || value.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(value)) return false;
		used.add(level); return true;
	});
}
/** Null is required: omitting low/medium would make Pi enable its generic defaults again. */
export function thinkingRowsToMap(rows: readonly ThinkingLevelRow[]): ThinkingLevelMap {
	const map: ThinkingLevelMap = Object.fromEntries(THINKING_LEVELS.map((level) => [level, null]));
	for (const row of rows) map[row.level] = row.value.trim();
	return map;
}

export interface OfficialThinkingModel { provider: string; id: string; reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap }
const canonicalId = (id: string) => id.toLowerCase().split("/").at(-1)!.split(/[@:]/)[0]
	.replace(/deepseek-v(\d+)p(\d+)/g, "deepseek-v$1.$2").replace(/deepseek-v(\d+)-(\d+)-/g, "deepseek-v$1.$2-");
const suffix = /^(?:-(?:background|fast|ultrafast|spot|sg|free|latest|build|\d{4,8}))+$/;
const owners: Array<[RegExp, string]> = [[/^claude/, "anthropic"], [/^gpt-|^o\d/, "openai"], [/^glm/, "zai"], [/^grok/, "xai"], [/^gemini/, "google"], [/^deepseek/, "deepseek"], [/^minimax/, "minimax"]];

/** Match the exact model/version (with known gateway suffixes), never borrow another generation's levels. */
export function matchOfficialThinkingModel(model: Pick<OfficialThinkingModel, "provider" | "id">, catalog: readonly OfficialThinkingModel[]): OfficialThinkingModel | undefined {
	const exact = catalog.find((candidate) => candidate.provider === model.provider && candidate.id === model.id);
	if (exact) return exact;
	const id = canonicalId(model.id);
	const owner = owners.find(([pattern]) => pattern.test(id))?.[1];
	const rank = (provider: string) => provider === owner ? 0 : provider === "openrouter" ? 1 : provider === "radius" ? 2 : provider === "fireworks" ? 3 : 4;
	return catalog.filter((candidate) => {
		if (!candidate.reasoning) return false;
		const base = canonicalId(candidate.id);
		return id === base || (id.startsWith(base) && suffix.test(id.slice(base.length)));
	}).sort((a, b) => canonicalId(b.id).length - canonicalId(a.id).length || rank(a.provider) - rank(b.provider)
		|| Number(Boolean(b.thinkingLevelMap)) - Number(Boolean(a.thinkingLevelMap)) || a.provider.localeCompare(b.provider))[0];
}
