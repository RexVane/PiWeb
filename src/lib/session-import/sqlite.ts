/**
 * 只读 SQLite 封装（node:sqlite 的 DatabaseSync，Node 24 起无需 flag）。
 *
 * 导入过程中**绝不能写源库**：ZCode / opencode 可能正在跑，写一下就是数据损坏。
 * 这里三重保险——`readOnly: true`、`PRAGMA query_only = 1`、只暴露查询方法（没有 exec/run 出口）。
 *
 * `node:sqlite` 是实验特性，所以**按需**动态载入：载不进来（Node 太老）时只有 ZCode/opencode
 * 这两个来源报错，文件类的四个来源照常可用——scanAllSources 会把单来源失败隔离掉。
 */
import type { DatabaseSync } from "node:sqlite";

export interface ReadOnlyDb {
	all(sql: string, params?: Array<string | number | null>): Record<string, unknown>[];
	get(sql: string, params?: Array<string | number | null>): Record<string, unknown> | undefined;
	hasTable(name: string): boolean;
	hasColumn(table: string, column: string): boolean;
	close(): void;
}

export async function openReadOnly(file: string): Promise<ReadOnlyDb | null> {
	const DatabaseSyncClass = await loadDriver();
	if (!DatabaseSyncClass) return null;
	let db: DatabaseSync;
	try {
		db = new DatabaseSyncClass(file, { readOnly: true });
	} catch {
		return null; // 文件不存在 / 不是 SQLite / 被占用到无法只读打开
	}
	try {
		db.exec("PRAGMA query_only = 1");
	} catch {
		// 老版本不支持该 pragma：readOnly 仍然生效
	}
	const all = (sql: string, params: Array<string | number | null> = []) => {
		try {
			return db.prepare(sql).all(...params) as Record<string, unknown>[];
		} catch {
			return [];
		}
	};
	return {
		all,
		get: (sql, params) => all(sql, params)[0],
		hasTable: (name) => Boolean(all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]).length),
		hasColumn: (table, column) => {
			try {
				return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
			} catch {
				return false;
			}
		},
		close: () => {
			try {
				db.close();
			} catch {
				// 已经关了：无事可做
			}
		},
	};
}

type DatabaseSyncCtor = typeof DatabaseSync;

let cachedDriver: Promise<DatabaseSyncCtor | null> | null = null;

/** 动态载入 node:sqlite；失败只影响 ZCode/opencode 这两个来源 */
function loadDriver(): Promise<DatabaseSyncCtor | null> {
	if (!cachedDriver) {
		cachedDriver = import("node:sqlite").then(
			(module) => module.DatabaseSync,
			(error) => {
				if (process.env.PIWEB_DEBUG_PROMPT) console.warn("[piweb] node:sqlite 不可用:", error instanceof Error ? error.message : error);
				return null;
			},
		);
	}
	return cachedDriver;
}

/** data 列里的 JSON：坏行返回 null 而不是抛错 */
export function parseJsonColumn(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}
