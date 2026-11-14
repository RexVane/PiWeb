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
import { normalizeToolPreset } from "./tool-preset";
import type { ToolPreset } from "./types";
import { readFileBounded } from "./read-file-bounded";

export interface ToolPreference {
toolPreset: ToolPreset;
/** 有值表示用户逐项选择；undefined 表示跟随 preset。 */
customActiveTools?: string[];
updatedAt?: number;
}

interface ToolPreferencesFile {
version: 2;
/** pathKey(sessionPath) → 该会话自己的偏好 */
sessions: Record<string, unknown>;
}

export class ToolPreferencesValidationError extends Error {}

function file(): string {
return path.join(getAgentDir(), "web-tool-preferences.json");
}

function pathKey(target: string): string {
const resolved = path.resolve(target);
return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sanitize(value: unknown): ToolPreference {
const invalid = () => { throw new ToolPreferencesValidationError("Saved tool permissions are invalid; the original record was retained"); };
if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
const raw = value as Record<string, unknown>;
// 旧文件里的 `standard` 在这里归一成 workspace：读进来就是新语义，写回去只有新 id。
const toolPreset = normalizeToolPreset(raw.toolPreset);
if (!toolPreset) return invalid();
if (raw.customActiveTools !== undefined && (!Array.isArray(raw.customActiveTools) || raw.customActiveTools.length > 1000
|| raw.customActiveTools.some((name) => typeof name !== "string" || !name.trim() || name.length > 512))) return invalid();
if (raw.updatedAt !== undefined && (typeof raw.updatedAt !== "number" || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0)) return invalid();
const custom = raw.customActiveTools === undefined ? undefined : [...new Set(raw.customActiveTools as string[])];
return {
toolPreset,
...(custom ? { customActiveTools: custom } : {}),
...(typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
};
}

function readSessions(value: unknown): Record<string, unknown> {
if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolPreferencesValidationError("Saved tool permission records are invalid");
// Preserve other sessions byte-for-byte in value terms, including invalid rows.
// Reading one bad row fails closed; saving another session must not silently drop it.
return value as Record<string, unknown>;
}

async function readFile(): Promise<ToolPreferencesFile> {
try {
const parsed = JSON.parse((await readFileBounded(file(), 16 * 1024 * 1024)).toString("utf8").replace(/^\uFEFF/, "")) as unknown;
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid tool preferences");
const raw = parsed as Record<string, unknown>;
// v1 曾按工作区保存，无法可靠映射回会话（工作区里可能有多个会话），直接忽略。
if (raw.version === 1) return { version: 2, sessions: {} };
if (raw.version !== 2) throw new ToolPreferencesValidationError("Unsupported saved tool permissions version");
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
const key = pathKey(sessionPath);
return Object.hasOwn(data.sessions, key) ? sanitize(data.sessions[key]) : null;
}

/** 保存某会话的工具偏好（原子替换 + 与 pi 的设置写入共用锁协议）。 */
export async function saveToolPreference(sessionPath: string, preference: ToolPreference): Promise<void> {
const target = file();
const key = pathKey(sessionPath);
const value = sanitize({
toolPreset: preference.toolPreset,
...(preference.customActiveTools ? { customActiveTools: [...preference.customActiveTools] } : {}),
updatedAt: Date.now(),
});
await withSettingsWriteLock(target, () => withExternalSettingsLock(target, async () => {
const data = await readFile();
data.sessions[key] = value;
await write(data, target);
}));
}
