/**
 * 会话/工作区路径工具。
 *
 * 会话列表里的 `cwd` 可能缺失（自动化会话、导入会话），而设置里的旧工作区列表也可能
 * 残留非字符串条目。UI 的路径归一化必须容忍这些值，不能在首屏 useMemo 里直接
 * `value.replace(...)`，否则整个页面会落到 Next 的错误页。
 */

/** 归一化路径用于比较；非字符串（undefined/null/对象/数字）一律返回空串。 */
export function canonicalDraftPath(value: unknown): string {
	if (typeof value !== "string") return "";
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

/** 两个路径是否指向同一位置；任一方不是有效字符串时返回 false。 */
export function sameWorkspacePath(a: unknown, b: unknown): boolean {
	const left = canonicalDraftPath(a);
	return Boolean(left) && left === canonicalDraftPath(b);
}

/**
 * 已知工作区的 cwd 列表：按“最近添加在前”的顺序去重，跳过缺失/非字符串 cwd
 * 与已删除的工作区（比较时忽略分隔符和 Windows 大小写）。
 */
export function knownWorkspaceCwds(
	addedWorkspaces: readonly unknown[],
	removedWorkspaces: readonly unknown[],
	sessionCwds: readonly unknown[],
): string[] {
	const removed = new Set(removedWorkspaces.map(canonicalDraftPath).filter(Boolean));
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of [...addedWorkspaces].reverse().concat(sessionCwds)) {
		const normalized = canonicalDraftPath(value);
		if (!normalized || removed.has(normalized) || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(value as string);
	}
	return result;
}
