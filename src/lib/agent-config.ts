/**
 * agent-config：`~/.pi/agent` 下被反复读取的 JSON 配置（settings.json / auth.json / 项目 settings.json）
 * 的统一读盘缓存。
 *
 * 这些文件在启动、首屏、每个会话快照里都会被读很多次：
 * - settings.json 单次 read+parse 约 0.3ms，但 `resolveProjectTrust` 走的是**同步**读，出现在
 *   每次会话创建、每次资源指纹、每次加载器发现里；
 * - auth.json 在每次模型目录刷新（设置面板/模型选择器）时读一次；
 * - 项目 `.pi/settings.json` 在插件面板里读。
 *
 * 缓存按 (mtime, ctime, size, ino) 校验：文件没变就直接返回内存里的解析结果，文件换了
 * （pi 自己写、或 PiWeb 的写路径）立刻回源。调用方拿到的是副本，可以随意修改；
 * 写路径改完文件后应当调用 `invalidateJsonFile()`——同一毫秒内的等长写入不会改变校验戳。
 */
import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type JsonObject = Record<string, unknown>;

interface Entry {
	stamp: string;
	value?: JsonObject;
	error?: Error;
}

const cache = new Map<string, Entry>();

/** 校验戳：mtime + ctime + 大小 + inode，任一变化都回源 */
function stampOf(stat: { mtimeMs: number; ctimeMs: number; size: number; ino: number }): string {
	return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
}

function parseJsonObject(text: string, file: string): JsonObject {
	const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} must contain a JSON object`);
	return parsed as JsonObject;
}

function copyOf(value: JsonObject | undefined): JsonObject {
	return value ? structuredClone(value) : {};
}

async function readEntry(file: string): Promise<Entry> {
	let stat;
	try {
		stat = await fs.stat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const missing: Entry = { stamp: "missing", value: {} };
		cache.set(file, missing);
		return missing;
	}
	const stamp = stampOf(stat);
	const cached = cache.get(file);
	if (cached && cached.stamp === stamp) return cached;
	const entry: Entry = { stamp };
	try {
		entry.value = parseJsonObject(await fs.readFile(file, "utf8"), file);
	} catch (error) {
		entry.error = error as Error;
	}
	cache.set(file, entry);
	return entry;
}

/** 严格读：文件不存在当 `{}`，内容非法抛错（与 pi 自己读 settings.json 的口径一致）。返回副本。 */
export async function readJsonObject(file: string): Promise<JsonObject> {
	const entry = await readEntry(file);
	if (entry.error) throw entry.error;
	return copyOf(entry.value);
}

/**
 * 读-改-写的临界区里用：绕过校验戳直接读盘。别的写入者（pi 的 SettingsManager、pi CLI）不会作废这里的缓存，
 * 同一时刻落盘的等长内容戳不变，拿缓存去合并会把对方刚写的字段盖回去。返回副本。
 */
export async function readJsonObjectFresh(file: string): Promise<JsonObject> {
	cache.delete(file);
	return readJsonObject(file);
}

/** 宽松读：读不到、解析失败都退化成 `{}`（"没配就当默认"的场景）。返回副本。 */
export async function readJsonObjectSafe(file: string): Promise<JsonObject> {
	try {
		return await readJsonObject(file);
	} catch {
		return {};
	}
}

/** 同步宽松读：给 `resolveProjectTrust` 这类同步路径用，任何失败都返回 `{}`。返回副本。 */
export function readJsonObjectSync(file: string): JsonObject {
	try {
		const stamp = stampOf(statSync(file));
		const cached = cache.get(file);
		let entry: Entry;
		if (cached && cached.stamp === stamp) {
			entry = cached;
		} else {
			entry = { stamp };
			try {
				entry.value = parseJsonObject(readFileSync(file, "utf8"), file);
			} catch (error) {
				entry.error = error as Error;
			}
			cache.set(file, entry);
		}
		if (entry.error) throw entry.error;
		return copyOf(entry.value);
	} catch {
		return {};
	}
}

/** 写路径改完文件后调用：同一毫秒内的等长写入不会改变校验戳，缓存必须被显式作废。 */
export function invalidateJsonFile(file: string): void {
	cache.delete(file);
}

/**
 * 按文件名作废（不需要先解析出 agent 目录）。
 * 凭证登录/登出这类路径只知道"auth.json 变了"，用它避免为了一个文件名去碰用户目录。
 */
export function invalidateJsonFilesNamed(basename: string): void {
	for (const key of [...cache.keys()]) {
		if (path.basename(key) === basename) cache.delete(key);
	}
}

/** 测试与"整目录切换"场景用 */
export function invalidateAllJsonFiles(): void {
	cache.clear();
}
