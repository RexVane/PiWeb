/**
 * @ 引用的候选集合（纯逻辑，便于单测）：
 * 服务端只给文件清单，文件夹在这里由文件路径推导——`src/lib/fuzzy.ts` 负责排序，
 * 本文件负责「有哪些候选」和「空 query 先看什么」。
 */
import { fuzzyFilter } from "./fuzzy";

export interface PathCandidate {
	/** 工作区根的相对路径（"/" 分隔），目录不带尾斜杠 */
	path: string;
	dir: boolean;
}

/** 匹配用的文本：目录带尾斜杠，和 pi 显示目录的方式一致（`@src/lib/` 也能命中） */
export function candidateText(candidate: PathCandidate): string {
	return candidate.dir ? `${candidate.path}/` : candidate.path;
}

/** 文件路径 → 全部父目录（去重、不含 "."） */
export function dirsOfPaths(files: string[]): string[] {
	const dirs = new Set<string>();
	for (const file of files) {
		const parts = file.split("/");
		for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
	}
	return [...dirs];
}

/** 目录在前、文件在后（同分时保持输入顺序，于是「引用整个文件夹」会排在里面的文件前面） */
export function buildCandidates(files: string[], dirs: string[]): PathCandidate[] {
	const out: PathCandidate[] = [];
	for (const dir of dirs) out.push({ path: dir, dir: true });
	for (const file of files) out.push({ path: file, dir: false });
	return out;
}

function depthOf(path: string): number {
	let depth = 0;
	for (let i = 0; i < path.length; i += 1) if (path[i] === "/") depth += 1;
	return depth;
}

/**
 * 候选排序：空 query 先列浅层（等价于「先看当前目录」，和 pi 打开 @ 时一样），
 * 有 query 交给 fuzzyFilter（与 pi 同一套评分）。limit 只影响返回条数，不影响匹配范围。
 */
export function suggestPaths(candidates: PathCandidate[], query: string, limit = 50): PathCandidate[] {
	if (!query.trim()) {
		return [...candidates]
			.sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path))
			.slice(0, limit);
	}
	return fuzzyFilter(candidates, query, candidateText).slice(0, limit);
}

const BOUNDARY_CHARS = " \t\n\"'`=,;()[]{}<>，。；：！？（）【】「」、《》";

/**
 * 光标前的 `@` 引用 token：`@` 必须落在词首（`foo@bar` 这种邮箱不触发），
 * token 从 `@` 起到光标止不能含空白。返回 null 表示当前不该弹候选。
 * 与 pi 的 `extractAtPrefix` 同一意图——pi 另外支持 `@"带空格 的路径"`；
 * 这里选中后是 chip 而不是正文文本，路径不进正文，所以不需要引号形式。
 */
export function atToken(text: string, caret: number): { query: string; start: number; end: number; tokenEnd: number } | null {
	const end = Math.max(0, Math.min(caret, text.length));
	let start = end;
	while (start > 0 && !BOUNDARY_CHARS.includes(text[start - 1])) start -= 1;
	const token = text.slice(start, end);
	if (!token.startsWith("@")) return null;
	// 光标在 token 中间时（`@lib|bar`）整段替换，只删到光标会留下半截
	let tokenEnd = end;
	while (tokenEnd < text.length && !BOUNDARY_CHARS.includes(text[tokenEnd])) tokenEnd += 1;
	return { query: token.slice(1), start, end, tokenEnd };
}
