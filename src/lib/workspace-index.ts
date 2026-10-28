/**
 * @ 引用的候选与匹配（纯逻辑，便于单测）：照搬 pi 终端的 `@` 补全
 * （pi-tui `CombinedAutocompleteProvider.getFuzzyFileSuggestions` + `extractAtPrefix`），
 * 同一个 `@que` 在终端和网页里给出同一批、同一顺序的候选。
 *
 * pi 的做法：`@` 后的文字按最后一个 `/` 拆成「目录 + 查询」（目录存在才算），
 * 在该目录下用 fd 过滤（查询先按字面转义、smart case，默认只匹配文件名，带 `/` 时匹配整条路径），
 * 再用 scoreEntry 打分（文件名全等 100 / 前缀 80 / 包含 50 / 路径包含 30，目录 +10），
 * 按分数、层级、路径长度、字典序排，取前 20。
 *
 * 有意的差别（tests/mention-parity.test.ts 里逐条对照，差别也写在那里）：
 * - 候选来自服务端给的工作区清单（git 可见文件 + 推导出的文件夹），不现场跑 fd；
 *   pi 每次 fd 只取前 100 条再打分，这里对整份清单打分——结果是「fd 不截断时 pi 会给的」，而且稳定。
 * - 不支持 `~/`、绝对路径和跳出工作区的 `../`：引用只针对当前工作区。
 * - fd 的 `--full-path` 匹配绝对路径，这里匹配相对路径（只差在工作区自身路径恰好命中的极端情况）。
 */

export interface PathCandidate {
	/** 工作区根的相对路径（"/" 分隔），目录不带尾斜杠 */
	path: string;
	dir: boolean;
}

/** 显示用：目录带尾斜杠 */
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

export function buildCandidates(files: string[], dirs: string[]): PathCandidate[] {
	const out: PathCandidate[] = [];
	for (const dir of dirs) out.push({ path: dir, dir: true });
	for (const file of files) out.push({ path: file, dir: false });
	return out;
}

// ---------- 匹配与排序（pi-tui autocomplete.js） ----------

/** pi 一次最多列 20 条 */
export const MENTION_LIMIT = 20;

export interface MentionSuggestion {
	candidate: PathCandidate;
	/** 文件名，目录带尾斜杠（pi 的 label） */
	label: string;
	/** 路径（pi 的 description）：按用户打的目录前缀显示，如 `./src/lib` */
	description: string;
}

function toDisplayPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function baseName(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** pi 的 buildFdPathQuery：查询按字面转义，带 `/` 时段间允许 `/` 或 `\` */
function buildFdPathQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (!normalized.includes("/")) return escapeRegex(normalized);
	const trimmed = normalized.replace(/^\/+|\/+$/g, "");
	if (!trimmed) return normalized;
	const segments = trimmed.split("/").filter(Boolean).map(escapeRegex);
	if (!segments.length) return normalized;
	const separator = "[\\\\/]";
	return segments.join(separator) + (normalized.endsWith("/") ? separator : "");
}

/**
 * fd 的过滤：模式当正则，smart case（模式里有大写字母才区分大小写，转义序列如 `\W` 不算）。
 * 查询字符已转义，只保留 buildFdPathQuery 生成的路径分隔符正则。
 */
function fdFilter(pattern: string): (target: string) => boolean {
	const caseSensitive = /\p{Lu}/u.test(pattern.replace(/\\./g, ""));
	try {
		const regex = new RegExp(pattern, caseSensitive ? "" : "i");
		return (target) => regex.test(target);
	} catch {
		const literal = caseSensitive ? pattern : pattern.toLowerCase();
		return (target) => (caseSensitive ? target : target.toLowerCase()).includes(literal);
	}
}

/** pi 的 scoreEntry：文件名全等 100 / 前缀 80 / 包含 50 / 整条路径包含 30，目录命中再 +10 */
export function scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
	const lowerFileName = baseName(filePath).toLowerCase();
	const lowerQuery = query.toLowerCase();
	let score = 0;
	if (lowerFileName === lowerQuery) score = 100;
	else if (lowerFileName.startsWith(lowerQuery)) score = 80;
	else if (lowerFileName.includes(lowerQuery)) score = 50;
	else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;
	if (isDirectory && score > 0) score += 10;
	return score;
}

/**
 * pi 的 resolveScopedFuzzyQuery：最后一个 `/` 之前是目录（必须存在），之后是查询。
 * 返回 base = 工作区相对路径（"" 为根），displayBase = 用户打的原样前缀。
 */
function resolveScopedQuery(rawQuery: string, dirs: ReadonlySet<string>): { base: string; query: string; displayBase: string } | null {
	const normalized = toDisplayPath(rawQuery);
	const slash = normalized.lastIndexOf("/");
	if (slash === -1) return null;
	const displayBase = normalized.slice(0, slash + 1);
	if (displayBase.startsWith("/") || displayBase.startsWith("~/")) return null;
	const segments: string[] = [];
	for (const segment of displayBase.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (!segments.length) return null;
			segments.pop();
		} else segments.push(segment);
	}
	const base = segments.join("/");
	if (base && !dirs.has(base)) return null;
	return { base, query: normalized.slice(slash + 1), displayBase };
}

interface Entry {
	candidate: PathCandidate;
	/** 相对 fd 搜索目录的路径，目录带尾斜杠（和 fd 的输出一致，长度和字典序都按它算） */
	path: string;
	score: number;
	depth: number;
}

/**
 * 候选排序与截断，和 pi 一致：空查询全部 1 分，按层级 → 路径长度 → 字典序（先看当前目录、名字短的在前）。
 * 不在模块里缓存目录集合：调用方用 useMemo 包住整次计算。
 */
export function suggestPaths(candidates: readonly PathCandidate[], rawQuery: string, limit = MENTION_LIMIT): MentionSuggestion[] {
	const dirs = new Set<string>();
	for (const candidate of candidates) if (candidate.dir) dirs.add(candidate.path);
	const scoped = resolveScopedQuery(rawQuery, dirs);
	const query = scoped ? scoped.query : rawQuery;
	const prefix = scoped?.base ? `${scoped.base}/` : "";

	let filter: ((relative: string) => boolean) | null = null;
	if (query) {
		// 默认只拿文件名去匹配；查询带 `/` 时（目录不存在、没走上面的限定目录）匹配整条路径
		const fullPath = toDisplayPath(query).includes("/");
		const matches = fdFilter(buildFdPathQuery(query));
		filter = fullPath ? matches : (relative) => matches(baseName(relative));
	}

	const entries: Entry[] = [];
	for (const candidate of candidates) {
		if (prefix && !candidate.path.startsWith(prefix)) continue;
		const relative = candidate.path.slice(prefix.length);
		if (!relative || (filter && !filter(relative))) continue;
		const path = candidate.dir ? `${relative}/` : relative;
		const score = query ? scoreEntry(path, query, candidate.dir) : 1;
		if (score <= 0) continue;
		entries.push({ candidate, path, score, depth: relative.split("/").filter(Boolean).length });
	}
	entries.sort((a, b) => b.score - a.score || a.depth - b.depth || a.path.length - b.path.length || a.path.localeCompare(b.path));

	return entries.slice(0, limit).map(({ candidate, path }) => {
		const withoutSlash = candidate.dir ? path.slice(0, -1) : path;
		return {
			candidate,
			label: baseName(withoutSlash) + (candidate.dir ? "/" : ""),
			description: scoped ? `${scoped.displayBase}${withoutSlash}` : withoutSlash,
		};
	});
}

// ---------- @ token（pi-tui extractAtPrefix） ----------

/** pi 的 PATH_DELIMITERS */
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
/** pi-tui utils.js 的 cjkBreakRegex / cjkPunctuationRegex / autocompleteSeparatorRegex（原样抄来，测试里核对 source） */
export const CJK_BREAK_REGEX = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
const CJK_PUNCTUATION_REGEX = new RegExp(`(?:(?=\\p{Punctuation})${CJK_BREAK_REGEX.source}|[，．：；！？（）［］｛｝“”‘’…—])`, "u");
export const AUTOCOMPLETE_SEPARATOR_REGEX = new RegExp(`(?:\\s|${CJK_PUNCTUATION_REGEX.source})`, "u");
const TOKEN_START_REGEX = new RegExp(`(?:^|${AUTOCOMPLETE_SEPARATOR_REGEX.source})$`, "u");
/** 正文里路径前常见的左括号类：`(@src` 也能触发；token 里有对应的右括号就保留（`app/[slug]`） */
const PATH_WRAPPERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };

function isDelimiter(character: string): boolean {
	return PATH_DELIMITERS.has(character) || AUTOCOMPLETE_SEPARATOR_REGEX.test(character);
}

/** 最后一个分隔符的位置（按码点走，返回它最后一个 UTF-16 单元的下标），没有则 -1 */
function findLastDelimiter(text: string): number {
	let last = -1;
	let index = 0;
	for (const character of text) {
		index += character.length;
		if (isDelimiter(character)) last = index - 1;
	}
	return last;
}

function stripLeadingWrappers(token: string): string {
	let result = token;
	while (result.length > 0) {
		const closer = PATH_WRAPPERS[result[0]];
		if (!closer || result.includes(closer, 1)) break;
		result = result.slice(1);
	}
	return result;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) quoteStart = i;
		}
	}
	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	let start = index;
	while (start > 0 && PATH_WRAPPERS[text[start - 1]]) start -= 1;
	return PATH_DELIMITERS.has(text[start - 1] ?? "") || TOKEN_START_REGEX.test(text.slice(0, start));
}

/**
 * 光标前的 `@` 引用 token，规则同 pi：
 * 从最后一个分隔符（空白、`"` `'` `=`、中日韩标点）之后取一段，去掉开头的左括号类，以 `@` 开头才算
 * （`foo@bar` 这种邮箱不触发）；另支持 `@"带空格 的路径`。返回 null 表示当前不该弹候选。
 * pi 只看光标所在的那一行；光标在 token 中间时（`@lib|bar`）删除范围盖住整个 token，免得留下半截。
 */
export function atToken(text: string, caret: number): { query: string; start: number; end: number; tokenEnd: number } | null {
	const end = Math.max(0, Math.min(caret, text.length));
	const lineStart = text.lastIndexOf("\n", end - 1) + 1;
	const line = text.slice(lineStart, end);

	const quoteStart = findUnclosedQuoteStart(line);
	if (quoteStart !== null && quoteStart > 0 && line[quoteStart - 1] === "@" && isTokenStart(line, quoteStart - 1)) {
		const close = text.indexOf('"', end);
		const lineEnd = text.indexOf("\n", end);
		const closed = close !== -1 && (lineEnd === -1 || close < lineEnd);
		return { query: line.slice(quoteStart + 1), start: lineStart + quoteStart - 1, end, tokenEnd: closed ? close + 1 : end };
	}

	const tokenStart = findLastDelimiter(line) + 1;
	const raw = line.slice(tokenStart);
	const token = stripLeadingWrappers(raw);
	if (!token.startsWith("@")) return null;
	let tokenEnd = end;
	for (const character of text.slice(end)) {
		if (isDelimiter(character)) break;
		tokenEnd += character.length;
	}
	return { query: token.slice(1), start: lineStart + tokenStart + raw.length - token.length, end, tokenEnd };
}
