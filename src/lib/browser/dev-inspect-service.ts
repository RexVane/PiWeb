/**
 * dev-inspect-service：开发者模式的「元素 → 源码」定位。
 *
 * 输入预览页面上点击的元素信息（文本 + 构建期注入的源码属性），输出工作区内的源码候选：
 *   1. source-attr：data-source / data-insp-path 等构建期属性直读（精确到行列，需边界校验）；
 *      相对路径对不上工作区根时（monorepo 子包的 dev server），按路径后缀在工作区里找回
 *   2. text：精确文本搜索（有界 fs 遍历，源码目录优先，跳过排除目录 / 二进制 / 超大文件）
 *   3. i18n-usage：文本只命中字典行（"key": "文本"）时，提取 key 二次搜索使用处
 * 安全：一切结果必须落在工作区根内（realpath + isPathInside 双校验）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { GROWTH_EXCLUDE_DIRS } from "../growth/growth-tree";
import { BoundaryError, isPathInside, resolveWorkspacePath } from "../security/path-security";
import { COMPONENT_FILE_KEY, FRAMEWORK_SOURCE_KEYS } from "./source-hint-keys";

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
/** 单次搜索最多枚举多少文件 */
const MAX_FILES = 5000;
/** 单次搜索最多进入多少目录（只有目录没有可搜文件的巨型数据目录也不能拖死请求） */
const MAX_DIRS = 20_000;
const READ_CONCURRENCY = 64;
/** 源码属性按路径后缀找回时最多保留的候选 */
const MAX_SUFFIX_MATCHES = 5;

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
/** 遍历时优先进入的目录（按此顺序）：大仓库里文件额度先花在源码上；其余目录按名称，隐藏目录殿后 */
const PRIORITY_DIRS = ["src", "app", "pages", "components", "lib", "packages", "apps", "client", "frontend", "web", "ui", "views", "layouts", "locales", "i18n"];

/** 构建期源码属性（code-inspector-plugin 等注入）：值形如 "src/App.tsx:12:5" / "src/App.vue:12:5:div" */
const SOURCE_ATTR_KEYS = ["data-source", "data-insp-path", "data-source-loc", "data-source-location", "data-loc"];
/**
 * 从尾部解析 :line[:col][:tag]，兼容 Windows 盘符（D:\a.tsx:12:5）。
 * code-inspector-plugin 的 data-insp-path 末段是标签名（file:line:col:tagName）。
 */
const LOC_RE = /^(.*?)(?::(\d+)(?::(\d+))?(?::[A-Za-z_$][\w.:$-]*)?)?$/;
/** 字典行形态："key": "文本" / 'key': `文本` / key: "文本"（i18n.tsx / *.json 通用） */
const DICT_LINE_RE = /["'`]?([\w][\w.$-]{1,})["'`]?\s*:\s*["'`]/;
/** 字典类路径：locales/i18n/lang/messages/translations 目录或文件名。只有它们命中才做两跳，避免普通对象字面量误触发 */
const DICT_PATH_RE = /(^|\/)(locales?|i18n|langs?|messages|translations)(\/|\.|_|-)/i;

function toRel(root: string, target: string): string {
	return path.relative(root, target).replace(/\\/g, "/");
}

function extOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function dirOrder(name: string): number {
	const rank = PRIORITY_DIRS.indexOf(name.toLowerCase());
	if (rank >= 0) return rank;
	return name.startsWith(".") ? PRIORITY_DIRS.length + 1 : PRIORITY_DIRS.length;
}

/** DOM 文本规范化：压缩空白、截断；不足 2 字符视为不可搜索 */
export function normalizeInspectText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

// ---------- 工作区枚举 ----------

interface WorkspaceFile {
	abs: string;
	/** 相对工作区的路径（"/" 分隔） */
	rel: string;
	ext: string;
}

/**
 * 有界枚举工作区里可搜索的文本文件（只 readdir，不读内容）。
 * 同层先收文件，再按 dirOrder 深入子目录；跳过排除目录，不跟随符号链接（Dirent 对链接既非目录也非文件）。
 */
export async function listSearchableFiles(root: string, maxFiles = MAX_FILES): Promise<{ files: WorkspaceFile[]; truncated: boolean }> {
	const files: WorkspaceFile[] = [];
	let dirs = 0;
	let truncated = false;
	const walk = async (dir: string): Promise<void> => {
		if (++dirs > MAX_DIRS) {
			truncated = true;
			return;
		}
		const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
		if (!items) return;
		const subdirs: string[] = [];
		for (const item of items) {
			if (item.isDirectory()) {
				if (!EXCLUDED_DIR_SET.has(item.name.toLowerCase())) subdirs.push(item.name);
			} else if (item.isFile() && SEARCH_EXTENSIONS.has(extOf(item.name))) {
				if (files.length >= maxFiles) {
					truncated = true;
					return;
				}
				const abs = path.join(dir, item.name);
				files.push({ abs, rel: toRel(root, abs), ext: extOf(item.name) });
			}
		}
		subdirs.sort((a, b) => dirOrder(a) - dirOrder(b) || a.localeCompare(b));
		for (const name of subdirs) {
			if (truncated) return;
			await walk(path.join(dir, name));
		}
	};
	await walk(root);
	return { files, truncated };
}

/** 文本文件内容；超限、读失败或疑似二进制（前 8000 字节含 NUL）返回 null */
async function readTextFile(file: string): Promise<string | null> {
	const stat = await fs.stat(file).catch(() => null);
	if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
	const buf = await fs.readFile(file).catch(() => null);
	if (!buf || buf.subarray(0, Math.min(buf.length, 8000)).includes(0)) return null;
	return buf.toString("utf8");
}

// ---------- 第 1 级：构建期源码属性 ----------

/**
 * target 解析符号链接后必须在工作区内且是真实文件。
 * 只校验 realpath：root 本身是 realpath，未解析的同一路径另一种拼法（Windows 8.3 短名、链接别名）不能误判越界。
 */
async function resolveInsideFile(root: string, target: string): Promise<string | null> {
	const real = await fs.realpath(target).catch(() => null);
	if (!real || !isPathInside(root, real)) return null;
	const stat = await fs.stat(real).catch(() => null);
	return stat?.isFile() ? real : null;
}

async function readLineText(file: string, line: number): Promise<string> {
	const content = await readTextFile(file);
	return content === null ? "" : (content.split("\n")[line - 1] ?? "").trim().slice(0, 160);
}

/** 可做后缀找回的相对路径（规范成 "/" 分隔）；绝对路径、含 .. 的路径不找回 */
function relativeSuffix(file: string): string | null {
	if (path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) return null;
	const segments = file.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== ".");
	if (segments.length === 0 || segments.includes("..")) return null;
	return segments.join("/");
}

function endsWithSegments(rel: string, suffix: string): boolean {
	const a = process.platform === "win32" ? rel.toLowerCase() : rel;
	const b = process.platform === "win32" ? suffix.toLowerCase() : suffix;
	return a === b || a.endsWith(`/${b}`);
}

/**
 * 线索里的文件路径 → 工作区内的真实文件：先按原样（绝对路径或相对工作区根）找；
 * 对不上时（dev server 跑在 monorepo 子包里，apps/web 下的 "src/App.tsx"）按路径后缀找回。
 */
async function resolveHintFile(root: string, file: string, listFiles: () => Promise<{ files: WorkspaceFile[] }>): Promise<string[]> {
	const exact = await resolveInsideFile(root, path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file));
	if (exact) return [exact];
	const suffix = relativeSuffix(file);
	if (!suffix) return [];
	const { files } = await listFiles();
	const matches = files
		.filter((candidate) => endsWithSegments(candidate.rel, suffix))
		.sort((a, b) => a.rel.length - b.rel.length || a.rel.localeCompare(b.rel))
		.slice(0, MAX_SUFFIX_MATCHES);
	const found: string[] = [];
	for (const match of matches) {
		const real = await resolveInsideFile(root, match.abs);
		if (real) found.push(real);
	}
	return found;
}

async function hitsFromAttrs(
	root: string,
	attrs: Record<string, unknown>,
	listFiles: () => Promise<{ files: WorkspaceFile[] }>,
): Promise<SourceHit[]> {
	const hits: SourceHit[] = [];
	const seen = new Set<string>();
	const push = async (real: string, line: number) => {
		const rel = toRel(root, real);
		if (seen.has(`${rel}:${line}`)) return;
		seen.add(`${rel}:${line}`);
		hits.push({ path: rel, line, lineText: await readLineText(real, line), kind: "source-attr" });
	};
	for (const key of [...SOURCE_ATTR_KEYS, ...FRAMEWORK_SOURCE_KEYS]) {
		const raw = attrs[key];
		if (typeof raw !== "string" || !raw.trim()) continue;
		const m = LOC_RE.exec(raw.trim());
		if (!m || !m[1]) continue;
		const line = m[2] ? Number(m[2]) : 1;
		if (!Number.isSafeInteger(line) || line < 1) continue;
		for (const real of await resolveHintFile(root, m[1], listFiles)) await push(real, line);
	}
	return hits;
}

/** vue-file 线索 → 工作区内的组件文件（相对路径）；值只取文件部分，带 ?query 的去掉 */
async function componentFilesFromAttrs(root: string, attrs: Record<string, unknown>, listFiles: () => Promise<{ files: WorkspaceFile[] }>): Promise<string[]> {
	const raw = attrs[COMPONENT_FILE_KEY];
	if (typeof raw !== "string" || !raw.trim()) return [];
	const file = raw.trim().replace(/\?.*$/, "");
	return (await resolveHintFile(root, file, listFiles)).map((real) => toRel(root, real));
}

// ---------- 第 2/3 级：文本搜索与 i18n 两跳 ----------

interface LineHit {
	file: WorkspaceFile;
	line: number;
	lineText: string;
	/** 命中行是 "key": "文本" 字典形态时提取出的 key */
	dictKey?: string;
}

/**
 * 按枚举顺序读文件，每个 needle 在每个文件里只记首个命中行（区分大小写）。
 * 多个 needle 共用一轮读盘（i18n 两跳的多个 key 不再各自全量遍历）；全部攒够 limit 条即停。
 */
async function scanFiles(files: WorkspaceFile[], needles: string[], limit: number): Promise<{ hits: Map<string, LineHit[]>; read: number }> {
	const hits = new Map(needles.map((needle) => [needle, [] as LineHit[]]));
	const full = () => needles.every((needle) => hits.get(needle)!.length >= limit);
	let read = 0;
	for (let i = 0; i < files.length && !full(); i += READ_CONCURRENCY) {
		const batch = files.slice(i, i + READ_CONCURRENCY);
		const found = await Promise.all(batch.map(async (file) => {
			const content = await readTextFile(file.abs);
			const out: [string, LineHit][] = [];
			if (content === null) return out;
			const wanted = needles.filter((needle) => content.includes(needle));
			if (wanted.length === 0) return out;
			const lines = content.split("\n");
			const dictLike = DICT_PATH_RE.test(file.rel);
			for (const needle of wanted) {
				const index = lines.findIndex((text) => text.includes(needle));
				if (index < 0) continue;
				const dict = dictLike ? DICT_LINE_RE.exec(lines[index].trim()) : null;
				out.push([needle, { file, line: index + 1, lineText: lines[index].trim().slice(0, 160), dictKey: dict?.[1] }]);
			}
			return out;
		}));
		read += batch.length;
		// 批内按枚举顺序归并，结果与并发完成次序无关
		for (const list of found) {
			for (const [needle, hit] of list) {
				const bucket = hits.get(needle)!;
				if (bucket.length < limit) bucket.push(hit);
			}
		}
	}
	return { hits, read };
}

type RankedHit = SourceHit & { dictKey?: string; ext?: string; inComponent?: boolean };

function rankOf(hit: RankedHit): number {
	if (hit.kind === "source-attr") return 0;
	if (hit.inComponent) return 0;
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
	// 枚举一次，属性找回、文本搜索、两跳共用
	let listing: Promise<{ files: WorkspaceFile[]; truncated: boolean }> | null = null;
	const listFiles = () => (listing ??= listSearchableFiles(root));

	const attrHits = await hitsFromAttrs(root, attrs, listFiles);
	if (attrHits.length > 0) return { results: attrHits.slice(0, MAX_RESULTS), searchedFiles: 0 };
	// 只知道所在组件文件（Vue）：文本命中落在这些文件里的排最前；文本找不到时退回组件文件本身
	const componentFiles = await componentFilesFromAttrs(root, attrs, listFiles);
	const componentHits = async (): Promise<SourceHit[]> =>
		Promise.all(componentFiles.map(async (rel) => ({ path: rel, line: 1, lineText: await readLineText(path.join(root, rel), 1), kind: "source-attr" as const })));
	if (text.length < 2) {
		if (componentFiles.length > 0) return { results: await componentHits(), searchedFiles: 0 };
		throw new BoundaryError("missing usable text or source attributes");
	}

	const { files, truncated } = await listFiles();
	const first = await scanFiles(files, [text], MAX_RESULTS);
	const textHits = first.hits.get(text)!;
	const results: RankedHit[] = textHits.map((h) => ({
		path: h.file.rel, line: h.line, lineText: h.lineText, kind: "text" as const, dictKey: h.dictKey, ext: h.file.ext,
		inComponent: componentFiles.includes(h.file.rel),
	}));
	if (results.length === 0 && componentFiles.length > 0) {
		return { results: await componentHits(), searchedFiles: first.read, truncated: truncated || undefined };
	}

	// i18n 两跳：字典行命中的 key → 找使用处（各语言字典里同 key 的行不算使用处）
	const dictKeys = [...new Set(textHits.map((h) => h.dictKey).filter((k): k is string => Boolean(k && k.length >= 3)))].slice(0, 3);
	if (dictKeys.length > 0) {
		const usage = await scanFiles(files, dictKeys, MAX_RESULTS);
		for (const key of dictKeys) {
			for (const u of usage.hits.get(key)!) {
				if (u.dictKey) continue;
				results.push({ path: u.file.rel, line: u.line, lineText: u.lineText, kind: "i18n-usage", ext: u.file.ext });
			}
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
		results: deduped.slice(0, MAX_RESULTS).map(({ dictKey, ext, inComponent, ...hit }) => hit),
		searchedFiles: first.read,
		truncated: truncated || deduped.length > MAX_RESULTS || undefined,
	};
}
