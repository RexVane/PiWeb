import { resourceRelativePath } from "./manifest";
import type { ResourceSelection } from "./protocol";

const TYPES = ["extensions", "skills", "prompts", "themes"] as const;
export function parseResourceSelection(raw: unknown): ResourceSelection {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Pi resource selection");
	const result: ResourceSelection = { extensions: [], skills: [], prompts: [], themes: [] };
	for (const type of TYPES) {
		const values = (raw as Record<string, unknown>)[type];
		if (values === undefined) continue;
		if (!Array.isArray(values) || values.length > 128) throw new Error("Invalid Pi resource filter");
		result[type] = [...new Set(values.map((value) => {
			const clean = resourceRelativePath(value);
			if (/[*!+]/.test(clean) || clean.startsWith("-")) throw new Error("Market selections must name exact declared paths");
			return clean;
		}))];
	}
	if (!TYPES.some((type) => result[type].length)) throw new Error("Select at least one Pi resource");
	return result;
}

/** Merge selections, not package identities. The Pi SDK still owns discovery and filtering. */
export function mergeResourceSelection(existing: unknown, source: string, selection: ResourceSelection): Record<string, unknown> | string {
	if (typeof existing === "string") return source; // An explicitly installed whole package already selects all of its declared resources.
	if (!existing) return { source, ...selection };
	const entry: Record<string, unknown> = { ...(existing as Record<string, unknown>), source };
	for (const type of TYPES) {
		const current = entry[type];
		if (current === undefined || !selection[type].length) continue; // Omitted filter = all declared resources, not none.
		if (!Array.isArray(current)) throw new Error("Invalid existing Pi package filter");
		if (!current.length) { entry[type] = [...selection[type]]; continue; }
		const selected = new Set(selection[type]);
		entry[type] = [...current.filter((value) => typeof value === "string" && !(/^[+-]/.test(value) && selected.has(value.slice(1)))), ...selection[type].map((value) => `+${value}`)];
		entry[type] = [...new Set(entry[type] as string[])];
	}
	return entry;
}

export function toggleResourcePaths(existing: unknown, source: string, paths: string[] | ResourceSelection, disabled: boolean): Record<string, unknown> {
	const entry: Record<string, unknown> = typeof existing === "string" ? { source } : { ...(existing as Record<string, unknown>), source };
	const contributions: ResourceSelection = Array.isArray(paths) ? { extensions: paths, skills: [], prompts: [], themes: [] } : paths;
	for (const type of TYPES) {
		const ownedPaths = contributions[type]; if (!ownedPaths.length) continue;
		const current = entry[type];
		if (current !== undefined && !Array.isArray(current)) throw new Error("Invalid existing resource filter");
		const owned = new Set(ownedPaths);
		const filters = (current as string[] | undefined ?? []).filter((value) => !(typeof value === "string" && /^[+-]/.test(value) && owned.has(value.slice(1))));
		// An empty array means NONE in Pi, while a +/- only array means ALL with overrides.
		if (Array.isArray(current) && !current.length) entry[type] = disabled ? [] : ownedPaths;
		else entry[type] = [...filters, ...ownedPaths.map((value) => `${disabled ? "-" : "+"}${value}`)];
	}
	return entry;
}
