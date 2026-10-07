/**
 * dev-inspect-service：开发者模式的「元素 → 源码」定位。
 *
 * 输入预览页面上点击的元素信息（文本 + 构建期注入的源码属性），输出工作区内的源码候选：
 *   1. source-attr：data-source / data-insp-path 等构建期属性直读（精确到行列，需边界校验）
 *   2. text：精确文本搜索（有界 fs 遍历，跳过排除目录 / 二进制 / 超大文件）
 *   3. i18n-usage：文本只命中字典行（"key": "文本"）时，提取 key 二次搜索使用处
 * 安全：一切结果必须落在工作区根内（realpath + isPathInside 双校验）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { GROWTH_EXCLUDE_DIRS } from "./growth-tree";
import { BoundaryError, isPathInside, resolveWorkspacePath } from "./path-security";

export interface SourceHit {
	/** 相对工作区的路径（"/" 分隔） */
	path: string;
	line: number;
	/** 命中行预览（截断） */
	lineText: string;
	kind: "source-attr" | "text" | "i18n-usage";
}

export interface LocateResult {
	results: SourceHit[];
	/** 实际读过的文件数（调试用） */
	searchedFiles: number;
	/** 文件数 / 结果数达到上限 */
	truncated?: boolean;
}

/** 规范化后的搜索文本上限 */
const MAX_TEXT = 200;
const MAX_RESULTS = 20;
/** 参与搜索的单文件上限 */
const MAX_FILE_BYTES = 1024 * 1024;
/** 单次搜索最多读多少文件 */
const MAX_FILES = 5000;
const WALK_CONCURRENCY = 64;

const EXCLUDED_DIR_SET = new Set(GROWTH_EXCLUDE_DIRS.map((d) => d.toLowerCase()));
/** 只搜常见源码/文本扩展名；其余（图片、锁文件、压缩包…）直接跳过 */
const SEARCH_EXTENSIONS = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro", "mdx",
	"html", "htm", "css", "scss", "less", "styl",
	"json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "svg",
	"md", "markdown", "txt",
	"py", "rb", "php", "rs", "go", "java", "kt", "c", "h", "cc", "cpp", "cs", "swift", "sh", "bash", "ps1",
]);
/** 组件类文件：文本直中时排名靠前 */
const COMPONENT_EXTENSIONS = new Set(["tsx", "jsx", "vue", "svelte", "astro", "mdx", "html", "htm"]);

/** 构建期源码属性（code-inspector-plugin 等注入）：值形如 "src/App.tsx:12:5" */
const SOURCE_ATTR_KEYS = ["data-source", "data-insp-path", "data-source-loc", "data-source-location", "data-loc"];
/** 从尾部解析 :line[:col]，兼容 Windows 盘符（D:\a.tsx:12:5） */
const LOC_RE = /^(.*?)(?::(\d+)(?::(\d+))?)?$/;
/** 字典行形态："key": "文本" / 'key': `文本` / key: "文本"（i18n.tsx / *.json 通用） */
const DICT_LINE_RE = /["'`]?([\w][\w.$-]{1,})["'`]?\s*:\s*["'`]/;
/** 字典类路径：locales/i18n/lang/messages/translations 目录或文件名。只有它们命中才做两跳，避免普通对象字面量误触发 */
const DICT_PATH_RE = /(^|\/)(locales?|i18n|langs?|messages|translations)(\/|\.|_|-)/i;

function toRel(root: string, target: string): string {
	return path.relative(root, target).replace(/\\/g, "/");
}

/** DOM 文本规范化：压缩空白、截断；不足 2 字符视为不可搜索 */
export function normalizeInspectText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

// ---------- 第 1 级：构建期源码属性 ----------

async function hitsFromAttrs(root: string, attrs: Record<string, unknown>): Promise<SourceHit[]> {
	const hits: SourceHit[] = [];
	for (const key of SOURCE_ATTR_KEYS) {
		const raw = attrs[key];
		if (typeof raw !== "string" || !raw.trim()) continue;
		const m = LOC_RE.exec(raw.trim());
		if (!m || !m[1]) continue;
		const file = m[1];
		const line = m[2] ? Number(m[2]) : 1;
		if (!Number.isSafeInteger(line) || line < 1) continue;
		const target = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
		if (!isPathInside(root, target)) continue;
		const real = await fs.realpath(target).catch(() => null);
		if (!real || !isPathInside(root, real)) continue;
		const stat = await fs.stat(real).catch(() => null);
		if (!stat?.isFile()) continue;
		let lineText = "";
		if (stat.size <= MAX_FILE_BYTES) {
			const content = await fs.readFile(real, "utf8").catch(() => "");
			lineText = (content.split("\n")[line - 1] ?? "").trim().slice(0, 160);
		}
		hits.push({ path: toRel(root, real), line, lineText, kind: "source-attr" });
	}
	return hits;
}

// ---------- 第 2/3 级：文本搜索与 i18n 两跳 ----------

interface TextFileHit {
	rel: string;
	line: number;
	lineText: string;
	ext: string;
	/** 命中行是 "key": "文本" 字典形态时提取出的 key */
	dictKey?: string;
}

/** 有界遍历工作区文本文件，对每个文件逐行找 needle（区分大小写，首个命中行即止） */
async function searchTextFiles(root: string, needle: string, limit: number): Promise<{ hits: TextFileHit[]; searched: number; truncated: boolean }> {
	const hits: TextFileHit[] = [];
	let searched = 0;
	let truncated = false;

	const walk = async (dir: string): Promise<void> => {
		if (hits.length >= limit || searched >= MAX_FILES) return;
		const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
		if (!items) return;
		const subdirs: string[] = [];
		const files: string[] = [];
		for (const item of items) {
			if (item.isDirectory()) {
				if (!EXCLUDED_DIR_SET.has(item.name.toLowerCase())) subdirs.push(path.join(dir, item.name));
			} else if (item.isFile()) {
				const ext = item.name.includes(".") ? item.name.slice(item.name.lastIndexOf(".") + 1).toLowerCase() : "";
				if (SEARCH_EXTENSIONS.has(ext)) files.push(path.join(dir, item.name));
			}
		}
		for (let i = 0; i < files.length; i += WALK_CONCURRENCY) {
			if (hits.length >= limit || searched >= MAX_FILES) return;
			await Promise.all(files.slice(i, i + WALK_CONCURRENCY).map(async (file) => {
				if (hits.length >= limit || searched >= MAX_FILES) return;
				searched += 1;
				const stat = await fs.stat(file).catch(() => null);
				if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) return;
				const buf = await fs.readFile(file).catch(() => null);
				if (!buf || buf.subarray(0, Math.min(buf.length, 8000)).includes(0)) return;
				const lines = buf.toString("utf8").split("\n");
				const rel = toRel(root, file);
				const dictLike = DICT_PATH_RE.test(rel);
				for (let index = 0; index < lines.length; index += 1) {
					if (!lines[index].includes(needle)) continue;
					const lineText = lines[index].trim().slice(0, 160);
					const dict = dictLike ? DICT_LINE_RE.exec(lines[index].trim()) : null;
					hits.push({
						rel,
						line: index + 1,
						lineText,
						ext: path.extname(file).slice(1).toLowerCase(),
						dictKey: dict?.[1],
					});
					return;
				}
			}));
		}
		for (const sub of subdirs) await walk(sub);
	};

	await walk(root);
	if (searched >= MAX_FILES) truncated = true;
	return { hits, searched, truncated };
}

function rankOf(hit: SourceHit & { dictKey?: string; ext?: string }): number {
	if (hit.kind === "source-attr") return 0;
	if (hit.kind === "i18n-usage") return 1;
	if (hit.kind === "text" && hit.ext && COMPONENT_EXTENSIONS.has(hit.ext) && !hit.dictKey) return 1;
	if (hit.kind === "text" && hit.dictKey) return 3;
	return 2;
}

/**
 * 元素 → 源码定位。attrs 精确命中时直接返回；否则文本搜索，字典命中再做一轮 key 使用处搜索。
 * @param cwdValue 工作区路径（必须已存在）
 */
export async function locateSource(cwdValue: unknown, input: { text?: unknown; attrs?: unknown }): Promise<LocateResult> {
	const root = await resolveWorkspacePath(cwdValue);
	const text = normalizeInspectText(input.text);
	const attrs = input.attrs && typeof input.attrs === "object" && !Array.isArray(input.attrs) ? (input.attrs as Record<string, unknown>) : {};

	const attrHits = await hitsFromAttrs(root, attrs);
	if (attrHits.length > 0) return { results: attrHits.slice(0, MAX_RESULTS), searchedFiles: 0 };
	if (text.length < 2) throw new BoundaryError("missing usable text or source attributes");

	const { hits, searched, truncated } = await searchTextFiles(root, text, MAX_RESULTS);
	const results: (SourceHit & { dictKey?: string; ext?: string })[] = hits.map((h) => ({
		path: h.rel, line: h.line, lineText: h.lineText, kind: "text" as const, dictKey: h.dictKey, ext: h.ext,
	}));

	// i18n 两跳：字典行命中的 key → 找使用处（排除字典行自身）
	const dictKeys = [...new Set(hits.map((h) => h.dictKey).filter((k): k is string => Boolean(k && k.length >= 3)))].slice(0, 3);
	for (const key of dictKeys) {
		const usage = await searchTextFiles(root, key, MAX_RESULTS);
		for (const u of usage.hits) {
			const stillDict = u.dictKey === key || (u.dictKey && DICT_LINE_RE.test(u.lineText));
			if (stillDict) continue;
			results.push({ path: u.rel, line: u.line, lineText: u.lineText, kind: "i18n-usage", ext: u.ext });
		}
	}

	results.sort((a, b) => rankOf(a) - rankOf(b) || a.path.localeCompare(b.path));
	const seen = new Set<string>();
	const deduped = results.filter((r) => {
		const id = `${r.path}:${r.line}:${r.kind}`;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
	return {
		results: deduped.slice(0, MAX_RESULTS).map(({ dictKey, ext, ...hit }) => hit),
		searchedFiles: searched,
		truncated: truncated || deduped.length > MAX_RESULTS || undefined,
	};
}
