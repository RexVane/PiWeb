import type { Usage } from "@earendil-works/pi-ai";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const numberOrZero = (value: unknown) => validNumber(value) ? value : 0;
const tokenFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/** Unknown historical usage is represented by zeros, not fabricated billing/token measurements.
 * SDK context estimation ignores all-zero usage and estimates the message content instead.
 */
export function normalizeImportedUsage(value?: unknown): Usage {
	const usage = record(value) ? value : {};
	const cost = record(usage.cost) ? usage.cost : {};
	const input = numberOrZero(usage.input);
	const output = numberOrZero(usage.output);
	const cacheRead = numberOrZero(usage.cacheRead);
	const cacheWrite = numberOrZero(usage.cacheWrite);
	return {
		...usage,
		input, output, cacheRead, cacheWrite,
		totalTokens: validNumber(usage.totalTokens) ? usage.totalTokens : input + output + cacheRead + cacheWrite,
		cost: {
			...cost,
			input: numberOrZero(cost.input), output: numberOrZero(cost.output),
			cacheRead: numberOrZero(cost.cacheRead), cacheWrite: numberOrZero(cost.cacheWrite),
			total: numberOrZero(cost.total),
		},
	};
}

/** Repair old imports in the SDK's in-memory entries before it projects them into a model request.
 * SessionManager.getEntries() exposes the entries shared with its branch/index; only the usage
 * leaf of malformed imported assistant messages is changed. Disk history is not rewritten here.
 * Normal Pi/CLI sessions and complete live usage/billing records are left untouched.
 */
export function repairImportedAssistantUsage(entries: readonly unknown[]): number {
	if (!entries.some((entry) => record(entry) && entry.type === "custom" && entry.customType === "piweb-import")) return 0;
	let repaired = 0;
	for (const entry of entries) {
		if (!record(entry) || entry.type !== "message" || !record(entry.message) || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (record(usage) && tokenFields.every((key) => validNumber(usage[key])) && record(usage.cost)
			&& costFields.every((key) => validNumber((usage.cost as Record<string, unknown>)[key]))) continue;
		entry.message.usage = normalizeImportedUsage(usage);
		repaired += 1;
	}
	return repaired;
}
