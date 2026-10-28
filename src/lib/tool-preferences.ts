/**
 * tool-preferences：PiWeb 的工具启用偏好（`~/.pi/agent/web-tool-preferences.json`）。
 *
 * 工具选择不写进 pi 的会话 JSONL：session 只是历史记录，工具策略是 PiWeb 的 UI 状态。
 * 但只存在浏览器 localStorage 不够——服务重启、换浏览器、或服务端空闲回收会话后都会丢。
 * 这里按会话保存 preset 与逐项启用列表，服务端在冷启动 / 快照 / 工具命令前恢复；
 * 逐项选择仍然只属于该会话，不会被同工作区的新会话继承（与原设置页语义一致）。
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
version: 2;
/** pathKey(sessionPath) → 该会话自己的偏好 */
sessions: Record<string, ToolPreference>;
}

function file(): string {
return path.join(getAgentDir(), "web-tool-preferences.json");
}

function pathKey(target: string): string {
const resolved = path.resolve(target);
return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

function readSessions(value: unknown): Record<string, ToolPreference> {
const out: Record<string, ToolPreference> = {};
if (!value || typeof value !== "object" || Array.isArray(value)) return out;
for (const [key, entry] of Object.entries(value)) {
const preference = sanitize(entry);
if (preference) out[key] = preference;
}
return out;
}

async function readFile(): Promise<ToolPreferencesFile> {
try {
const parsed = JSON.parse(await fs.readFile(file(), "utf8")) as unknown;
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid tool preferences");
const raw = parsed as Record<string, unknown>;
// v1 曾按工作区保存，无法可靠映射回会话（工作区里可能有多个会话），直接忽略。
return { version: 2, sessions: readSessions(raw.sessions) };
} catch (error) {
if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
return { version: 2, sessions: {} };
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

/** 读取某会话的工具偏好；没有保存过返回 null。 */
export async function readToolPreference(sessionPath: string): Promise<ToolPreference | null> {
const data = await readFile();
return data.sessions[pathKey(sessionPath)] ?? null;
}

/** 保存某会话的工具偏好（原子替换 + 与 pi 的设置写入共用锁协议）。 */
export async function saveToolPreference(sessionPath: string, preference: ToolPreference): Promise<void> {
const target = file();
const key = pathKey(sessionPath);
const value: ToolPreference = {
toolPreset: preference.toolPreset,
...(preference.customActiveTools ? { customActiveTools: [...preference.customActiveTools] } : {}),
updatedAt: Date.now(),
};
await withSettingsWriteLock(target, () => withExternalSettingsLock(target, async () => {
const data = await readFile();
data.sessions[key] = value;
await write(data, target);
}));
}
