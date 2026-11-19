/**
 * path-boundary：路径边界判定的最小工具集（无依赖的叶子模块）。
 *
 * 这里刻意不 import 任何 PiWeb 模块：`jsonc-settings-storage` 只需要错误类型和
 * 「同一个路径」比较，但从 `path-security` 拿会把 `pi → jsonc → path-security → pi`
 * 连成循环依赖。共享常量/工具下沉到本文件后，依赖方向是单向的：
 *   pi ↑ jsonc-settings-storage ↑ path-boundary（叶子）
 *   path-security → path-boundary（复用）
 */
import path from "node:path";

/**
 * 路径越界/格式不合法：路由层据此回 4xx，而不是 500。
 * 可选 code 让客户端区分「越界」和「不存在」这类不同性质的问题（api-error 会原样透传）。
 */
export class BoundaryError extends Error {
	/** 机器可读的错误码（如 OUT_OF_WORKSPACE / NOT_FOUND），缺省 VALIDATION_ERROR */
	code?: string;
	constructor(message: string, code?: string) {
		super(message);
		this.name = "BoundaryError";
		if (code) this.code = code;
	}
}

/** 比较用的规范写法：Windows 不区分大小写。 */
export function comparable(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** candidate 是否等于 root 或位于其内部（按规范化后的路径比较，不是字符串前缀）。 */
export function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(comparable(root), comparable(candidate));
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** 两个路径是否指向同一个位置（规范化后逐字比较）。 */
export function samePath(left: string, right: string): boolean {
	return comparable(left) === comparable(right);
}
