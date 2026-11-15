/**
 * physical-path：沙箱根目录的「物理目录」校验。
 *
 * 为什么不能比较 `path.resolve(root)` 与 `fs.realpath(root)` 的字符串：
 * Windows 的临时目录常以 8.3 短名出现（CI 上是 `C:\Users\RUNNER~1\AppData\Local\Temp`），
 * 而 `realpath` 展开成长名（`C:\Users\runneradmin\...`）。两者指向同一物理目录，字符串却不等，
 * 沙箱于是误判「不是物理目录」并整体不可用。
 *
 * 这里改为逐级 `lstat` 检查：8.3 短名仍是普通目录项，而符号链接/junction 会被 `lstat`
 * 报告为链接（Node 对 junction 的 `lstat` 同样是 symbolic link），安全语义保持不变。
 */
import fs from "node:fs/promises";
import path from "node:path";

export type PhysicalPathProblem = "missing" | "link" | "not-directory";

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * 检查 `target` 是否是一个物理目录（含所有上级目录都不是链接）。
 * 返回 null 表示通过；否则返回具体问题，由调用方决定错误文案。
 *
 * 只接受已存在的目录：不存在的路径返回 "missing"；文件返回 "not-directory"；
 * 自身或任一上级是符号链接/junction 时返回 "link"。
 */
export async function physicalPathProblem(target: string): Promise<PhysicalPathProblem | null> {
	let current = path.resolve(target);
	for (;;) {
		let stat;
		try {
			stat = await fs.lstat(current);
		} catch (error) {
			if (isMissing(error)) return "missing";
			throw error;
		}
		if (stat.isSymbolicLink()) return "link";
		if (!stat.isDirectory()) return "not-directory";
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
