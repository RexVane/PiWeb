/**
 * pi-settings：读写 pi settings.json 的数值化配置（压缩/自动重试）。
 * 与项目信任同一个外科手术式 JSON patch 方式。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, reloadSettingsManagers } from "./pi";

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

async function readSettingsFile(): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await fs.readFile(path.join(getAgentDir(), "settings.json"), "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

export async function getPiSettings(): Promise<PiSettings> {
	const raw = await readSettingsFile();
	const c = (raw.compaction ?? {}) as Record<string, unknown>;
	const r = (raw.retry ?? {}) as Record<string, unknown>;
	const num = (v: unknown, d: number) => (typeof v === "number" && v >= 0 ? v : d);
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

export async function patchPiSettings(patch: { compaction?: Partial<CompactionSettings>; retry?: Partial<RetrySettings> }): Promise<void> {
	const file = path.join(getAgentDir(), "settings.json");
	const raw = await readSettingsFile();
	const cur = await getPiSettings();
	if (patch.compaction) raw.compaction = { ...cur.compaction, ...patch.compaction };
	if (patch.retry) raw.retry = { ...cur.retry, ...patch.retry };
	await fs.writeFile(file, JSON.stringify(raw, null, "\t"), "utf8");
	// 正在运行的会话每次压缩/重试都从 SettingsManager 读：让它们重新读盘，改动立即生效
	await reloadSettingsManagers();
}
