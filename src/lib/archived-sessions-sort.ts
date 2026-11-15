/**
 * 按最近归档时间倒序排列已归档会话（纯函数，前后端共用）。
 */

export interface ArchivedSortableSession {
	path: string;
	modified?: string;
}

export function archivedSessionPathKey(filePath: string): string {
	if (!filePath) return "";
	const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
		? normalized.toLowerCase()
		: normalized;
}

/**
 * 1) 优先按 `archivedAt` 有效时间戳降序（最近归档排最前，缺失时间戳的旧记录排后）；
 * 2) 同毫秒或都缺失 `archivedAt` 时，按 `archivedPaths` 末尾写入顺序倒序（后归档排前）；
 * 3) 仍相同时按 `modified` 降序兜底。
 */
export function sortArchivedSessions<T extends ArchivedSortableSession>(
	sessions: readonly T[],
	archivedAt: Record<string, number> = {},
	archivedPaths: readonly string[] = [],
): T[] {
	if (sessions.length <= 1) return [...sessions];

	const timeByKey = new Map<string, number>();
	for (const [key, value] of Object.entries(archivedAt)) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			const norm = archivedSessionPathKey(key);
			timeByKey.set(norm, Math.max(timeByKey.get(norm) ?? 0, value));
		}
	}

	const indexByKey = new Map<string, number>();
	archivedPaths.forEach((p, idx) => {
		indexByKey.set(archivedSessionPathKey(p), idx);
	});

	return [...sessions].sort((a, b) => {
		const keyA = archivedSessionPathKey(a.path);
		const keyB = archivedSessionPathKey(b.path);
		const tA = timeByKey.get(keyA);
		const tB = timeByKey.get(keyB);
		if (tA !== tB) {
			if (tA === undefined) return 1;
			if (tB === undefined) return -1;
			return tB - tA;
		}
		const idxA = indexByKey.get(keyA) ?? -1;
		const idxB = indexByKey.get(keyB) ?? -1;
		if (idxA !== idxB) return idxB - idxA;
		const mA = a.modified ? Date.parse(a.modified) : Number.NaN;
		const mB = b.modified ? Date.parse(b.modified) : Number.NaN;
		const validA = Number.isFinite(mA);
		const validB = Number.isFinite(mB);
		if (validA !== validB) return validB ? 1 : -1;
		if (validA && validB && mA !== mB) return mB - mA;
		return (b.modified ?? "").localeCompare(a.modified ?? "");
	});
}
