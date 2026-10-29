/**
 * tool-preferences：PiWeb 的工具启用偏好（`~/.pi/agent/web-tool-preferences.json`）。
 *
 * 与官方 pi 一致，工具选择是**全局一份**：pi 用 `~/.pi/agent/settings.json` 的 `defaultTools`
 * （项目可用 `.pi/settings.json` 覆盖）决定所有会话的初始工具。PiWeb 的「三档预设 + 逐项开关」
 * 是同一层语义的图形化版本，因此也只保存一份，所有会话（含新会话、服务重启后）共用。
 *
 * 放在自己的文件而不是 settings.json：preset（尤其 full = 不限制）无法用 pi 的
 * `defaultTools` 白名单表达，直接改写 pi 的全局设置会把终端 pi 的工具选择也一起改坏。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "./pi";
import { withExternalSettingsLock, withSettingsWriteLock } from "./settings-write-lock";
import type { ToolPreset } from "./types";

export interface ToolPreference {
	toolPreset: ToolPreset;
	/** 有值表示用户逐项选择；undefined 表示跟随 preset。 */
	customActiveTools?: string[];
	updatedAt?: number;
}

interface ToolPreferencesFile {
	version: 3;
	/** 全局唯一的一份工具配置，所有会话共用。 */
	global?: ToolPreference;
}

function file(): string {
	return path.join(getAgentDir(), "web-tool-preferences.json");
}

function isPreset(value: unknown): value is ToolPreset {
	return value === "readonly" || value === "standard" || value === "full";
}

function sanitize(value: unknown): ToolPreference | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (!isPreset(raw.toolPreset)) return undefined;
	const custom = Array.isArray(raw.customActiveTools)
		? [...new Set(raw.customActiveTools.filter((name): name is string => typeof name === "string" && name.length > 0))]
		: undefined;
	return {
		toolPreset: raw.toolPreset,
		...(custom ? { customActiveTools: custom } : {}),
		...(typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
	};
}

/**
 * v1 按工作区、v2 按会话各存一份。升成「全局一份」时取最近改过的那个作为起点，
 * 升级后看到的仍是用户最后一次的选择，而不是界面默认档位。
 */
function fromLegacySessions(value: unknown): ToolPreference | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let newest: ToolPreference | undefined;
	for (const entry of Object.values(value)) {
		const preference = sanitize(entry);
		if (!preference) continue;
		if (!newest || (preference.updatedAt ?? 0) > (newest.updatedAt ?? 0)) newest = preference;
	}
	return newest;
}

async function readFile(): Promise<ToolPreferencesFile> {
	try {
		const parsed = JSON.parse(await fs.readFile(file(), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid tool preferences");
		const raw = parsed as Record<string, unknown>;
		const global = sanitize(raw.global) ?? fromLegacySessions(raw.sessions);
		return { version: 3, ...(global ? { global } : {}) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { version: 3 };
	}
}

async function write(data: ToolPreferencesFile, target: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
		await fs.rename(temporary, target);
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}

/** 读取全局工具配置；没有保存过返回 null。 */
export async function readToolPreference(): Promise<ToolPreference | null> {
	const data = await readFile();
	return data.global ?? null;
}

/** 保存全局工具配置（原子替换 + 与 pi 的设置写入共用锁协议）。 */
export async function saveToolPreference(preference: ToolPreference): Promise<void> {
	const target = file();
	const value: ToolPreference = {
		toolPreset: preference.toolPreset,
		...(preference.customActiveTools ? { customActiveTools: [...preference.customActiveTools] } : {}),
		updatedAt: Date.now(),
	};
	await withSettingsWriteLock(target, () => withExternalSettingsLock(target, async () => {
		await write({ version: 3, global: value }, target);
	}));
}
