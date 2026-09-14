/**
 * pi-settings：读写 pi settings.json 的数值化配置（压缩/自动重试）。
 * 与项目信任同一个外科手术式 JSON patch 方式。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, reloadSettingsManagers } from "./pi";
import { withExternalSettingsLock, withSettingsWriteLock } from "./settings-write-lock";

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface PiSettings {
	compaction: CompactionSettings;
	retry: RetrySettings;
}

const DEFAULTS: PiSettings = {
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
};

async function readSettingsFileStrict(): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await fs.readFile(path.join(getAgentDir(), "settings.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings.json must contain a JSON object");
	return parsed as Record<string, unknown>;
}

function section(raw: Record<string, unknown>, key: "compaction" | "retry"): Record<string, unknown> {
	const value = raw[key];
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function getPiSettings(): Promise<PiSettings> {
	const raw = await readSettingsFileStrict();
	const c = (raw.compaction ?? {}) as Record<string, unknown>;
	const r = (raw.retry ?? {}) as Record<string, unknown>;
	const num = (v: unknown, d: number) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : d);
	return {
		compaction: {
			enabled: c.enabled !== false,
			reserveTokens: num(c.reserveTokens, DEFAULTS.compaction.reserveTokens),
			keepRecentTokens: num(c.keepRecentTokens, DEFAULTS.compaction.keepRecentTokens),
		},
		retry: {
			enabled: r.enabled !== false,
			maxRetries: num(r.maxRetries, DEFAULTS.retry.maxRetries),
			baseDelayMs: num(r.baseDelayMs, DEFAULTS.retry.baseDelayMs),
		},
	};
}

export class PiSettingsValidationError extends Error {}

export function validatePiSettingsPatch(value: unknown): { compaction?: Partial<CompactionSettings>; retry?: Partial<RetrySettings> } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new PiSettingsValidationError("invalid settings patch");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => key !== "compaction" && key !== "retry")) throw new PiSettingsValidationError("unknown settings field");
	const result: { compaction?: Partial<CompactionSettings>; retry?: Partial<RetrySettings> } = {};
	for (const section of ["compaction", "retry"] as const) {
		if (input[section] === undefined) continue;
		const part = input[section];
		if (!part || typeof part !== "object" || Array.isArray(part)) throw new PiSettingsValidationError(`invalid ${section} settings`);
		const fields = part as Record<string, unknown>;
		const allowed = section === "compaction" ? ["enabled", "reserveTokens", "keepRecentTokens"] : ["enabled", "maxRetries", "baseDelayMs"];
		for (const [key, field] of Object.entries(fields)) {
			if (!allowed.includes(key)) throw new PiSettingsValidationError(`unknown ${section} field: ${key}`);
			if (key === "enabled") {
				if (typeof field !== "boolean") throw new PiSettingsValidationError(`${section}.${key} must be boolean`);
			} else if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0 || field > 1_000_000_000) {
				throw new PiSettingsValidationError(`${section}.${key} must be a non-negative integer`);
			}
		}
		if (section === "compaction") result.compaction = fields as Partial<CompactionSettings>;
		else result.retry = fields as Partial<RetrySettings>;
	}
	return result;
}

export async function patchPiSettings(value: unknown): Promise<void> {
	const patch = validatePiSettingsPatch(value);
	const file = path.join(getAgentDir(), "settings.json");
	await withSettingsWriteLock(file, () => withExternalSettingsLock(file, async () => {
		const raw = await readSettingsFileStrict();
		if (patch.compaction) raw.compaction = { ...section(raw, "compaction"), ...patch.compaction };
		if (patch.retry) raw.retry = { ...section(raw, "retry"), ...patch.retry };
		await fs.mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(raw, null, "\t"), "utf8");
			await fs.rename(temporary, file);
		} finally {
			await fs.rm(temporary, { force: true }).catch(() => undefined);
		}
	}));
	// 正在运行的会话每次压缩/重试都从 SettingsManager 读：让它们重新读盘，改动立即生效
	await reloadSettingsManagers();
}
