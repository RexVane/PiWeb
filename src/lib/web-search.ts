/**
 * 联网工具识别与来源解析（纯逻辑，供对话步骤、摘要分组与单测共用）。
 *
 * 区分本地文件搜索（grep/glob/find/ls/tool_search）与真实网络搜索/网页访问
 * （web_search、web_fetch、tavily/exa/brave/perplexity/fetch 等 MCP 或扩展工具），
 * 并从参数和结果（JSON / 截断 JSON / Markdown 链接 / 文本 URL）中提取可点击的去重站点来源。
 */

export type WebToolRole = "search" | "fetch";

export interface WebSource {
	url: string;
	domain: string;
	title?: string;
	snippet?: string;
}

const BUILTIN_LOCAL_TOOLS = new Set([
	"bash",
	"powershell",
	"pwsh",
	"shell",
	"sh",
	"cmd",
	"read",
	"edit",
	"write",
	"multiedit",
	"multi_edit",
	"grep",
	"glob",
	"find",
	"ls",
	"ask_user_question",
	"request_permission",
]);

const NON_WEB_SEARCH_TOKENS = new Set([
	"file",
	"files",
	"code",
	"symbol",
	"symbols",
	"grep",
	"glob",
	"workspace",
	"dir",
	"directory",
	"path",
	"local",
	"repo",
	"project",
	"session",
	"sessions",
	"history",
	"memory",
	"tool",
	"tools",
	"skill",
	"skills",
	"prompt",
	"prompts",
	"codemode",
]);

const WEB_FETCH_RE = /(^|[_\-./:])(web[_-]?fetch|webfetch|fetch[_-]?web|fetch[_-]?urls?|fetch[_-]?page|get[_-]?url|read[_-]?url|load[_-]?url|browse[_-]?url|open[_-]?url|visit[_-]?url|web[_-]?browse|http[_-]?fetch|url[_-]?fetch|tavily[_-]?extract|firecrawl[_-]?(scrape|crawl|extract|map)|crawling[_-]?exa|exa[_-]?(contents|get[_-]?contents|crawl)|jina[_-]?(read|reader)|browser[_-]?navigate|playwright[_-]?navigate)([_\-./:]|$)|(^|[_\-./:])fetch$/i;

const WEB_SEARCH_RE = /(^|[_\-./:])(web[_-]?search|websearch|search[_-]?web|internet[_-]?search|online[_-]?search|google[_-]?search|bing[_-]?search|ddg[_-]?search|duckduckgo|searx(ng)?|serper|serpapi|tavily([_-]?search)?|exa([_-]?search)?|brave[_-]?(web[_-]?)?search|perplexity([_-]?(ask|search|research))?|kagi[_-]?search|firecrawl[_-]?search|jina[_-]?search|xai[_-]?search|grok[_-]?search|news[_-]?search)([_\-./:]|$)/i;

const ASSET_EXTENSION_RE = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|css|map)$/i;

const TRAILING_PUNCT_RE = /[.,;:!?\s"'`<>\]}]+$/;

function trimBalancedUrl(raw: string): string {
	let s = raw.trim().replace(TRAILING_PUNCT_RE, "");
	// 平衡末尾右括号（保留 Wikipedia 等含成对括号的 URL）
	while (s.endsWith(")")) {
		let balance = 0;
		for (const ch of s) {
			if (ch === "(") balance += 1;
			else if (ch === ")") balance -= 1;
		}
		if (balance < 0) s = s.slice(0, -1).replace(TRAILING_PUNCT_RE, "");
		else break;
	}
	return s;
}

function isLocalhostName(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]";
}

/** 校验并规范化外部 http(s) URL；拒绝脚本伪协议及本机回环地址。 */
export function normalizeWebUrl(raw: string): string | null {
	if (typeof raw !== "string") return null;
	const candidate = trimBalancedUrl(raw);
	if (!candidate || candidate.length > 2048) return null;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	const host = parsed.hostname.toLowerCase();
	if (!host || isLocalhostName(host)) return null;
	// 忽略常见 SVG/XML 命名空间而非真实网页
	if (host === "www.w3.org" || host === "schemas.microsoft.com" || host === "xmlns.com") return null;
	// 统一根目录尾斜杠，避免同一首页被算作两个来源
	if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
		return `${parsed.protocol}//${parsed.host}`;
	}
	return parsed.toString();
}

/** 提取用于界面徽章展示的域名（去掉 www. 前缀）。 */
export function displayDomainOf(urlOrHost: string): string {
	try {
		const u = urlOrHost.includes("://") ? new URL(urlOrHost) : new URL(`https://${urlOrHost}`);
		return u.hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return urlOrHost.trim().toLowerCase().replace(/^www\./, "");
	}
}

/** 仅对公网域名允许浏览器尝试加载 /favicon.ico，避免探测内网或保留域名。 */
export function isPublicFaviconHost(domain: string): boolean {
	const d = domain.trim().toLowerCase();
	if (!d || !d.includes(".") || d.includes(":")) return false;
	if (d.endsWith(".local") || d.endsWith(".internal") || d.endsWith(".localhost") || d.endsWith(".lan") || d.endsWith(".home")) {
		return false;
	}
	const ipv4 = d.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const a = Number(ipv4[1]);
		const b = Number(ipv4[2]);
		if (a === 10 || a === 127 || a === 0) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		return false;
	}
	return /^[a-z0-9.-]+$/.test(d);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function collectArgUrls(args: unknown): string[] {
	const rec = asRecord(args);
	if (!rec) return [];
	const out: string[] = [];
	const push = (val: unknown) => {
		if (typeof val === "string") {
			const norm = normalizeWebUrl(val);
			if (norm) out.push(norm);
		}
	};
	for (const key of ["url", "uri", "href", "link"]) push(rec[key]);
	if (Array.isArray(rec.urls)) {
		for (const item of rec.urls) push(item);
	}
	return out;
}

function hasQueryArg(args: unknown): boolean {
	const rec = asRecord(args);
	if (!rec) return false;
	for (const key of ["query", "search_query", "q", "keyword", "keywords", "topic"]) {
		const val = rec[key];
		if (typeof val === "string" && val.trim()) return true;
		if (Array.isArray(val) && val.some((x) => typeof x === "string" && x.trim())) return true;
	}
	if (Array.isArray(rec.queries) && rec.queries.some((x) => typeof x === "string" && x.trim())) return true;
	return false;
}

function containsExternalUrl(text: string): boolean {
	const m = text.match(/https?:\/\/[^\s"'<>\]}]+/gi);
	if (!m) return false;
	return m.some((raw) => normalizeWebUrl(raw) !== null);
}

/** 识别工具是否属于真实联网搜索/网页访问（本地 grep/glob/file/tool_search 返回 null）。 */
export function classifyWebTool(name: string, args?: unknown, output?: string): WebToolRole | null {
	const rawName = (name ?? "").trim();
	if (!rawName) return null;
	const lower = rawName.toLowerCase();
	if (BUILTIN_LOCAL_TOOLS.has(lower)) return null;

	const tokens = lower.split(/[_\-./:]+/).filter(Boolean);
	if (WEB_FETCH_RE.test(lower)) return "fetch";
	if (WEB_SEARCH_RE.test(lower)) return "search";

	const hasLocalExclusion = tokens.some((tok) => NON_WEB_SEARCH_TOKENS.has(tok));
	const hasExplicitWebHint = tokens.some((tok) => tok === "web" || tok === "internet" || tok === "online" || tok === "http" || tok === "https");
	if (hasLocalExclusion && !hasExplicitWebHint) return null;

	// 带命名空间的 MCP 搜索工具（如 mcp__provider__search）且不是本地/内部工具搜索
	const isNamespaced = rawName.includes("__") || rawName.includes("/") || rawName.includes(":");
	if (isNamespaced && tokens.includes("search")) return "search";

	// 未知自定义联网工具兜底：按 url 参数或「查询词 + 外部网页链接返回」判断
	const argUrls = collectArgUrls(args);
	if (argUrls.length > 0 && !asString(asRecord(args)?.file_path)) {
		return "fetch";
	}
	if (hasQueryArg(args) && output && containsExternalUrl(output)) {
		return "search";
	}
	return null;
}

/** 提取搜索关键词或被访问的网页 URL，用于步骤主行展示。 */
export function extractWebQuery(_name: string, args: unknown, role: WebToolRole): string {
	const rec = asRecord(args);
	if (!rec) return "";
	if (role === "fetch") {
		for (const key of ["url", "uri", "href", "link"]) {
			const norm = normalizeWebUrl(asString(rec[key]) ?? "");
			if (norm) return norm;
		}
		if (Array.isArray(rec.urls)) {
			for (const item of rec.urls) {
				const norm = typeof item === "string" ? normalizeWebUrl(item) : null;
				if (norm) return norm;
			}
		}
		return "";
	}
	for (const key of ["query", "search_query", "q", "keyword", "topic", "prompt", "text", "input"]) {
		const s = asString(rec[key]);
		if (s) return s.replace(/\s+/g, " ").trim();
	}
	for (const key of ["queries", "keywords"]) {
		const val = rec[key];
		if (Array.isArray(val)) {
			const joined = val.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).join(", ");
			if (joined) return joined.replace(/\s+/g, " ").trim();
		} else if (typeof val === "string" && val.trim()) {
			return val.replace(/\s+/g, " ").trim();
		}
	}
	return "";
}

function cleanTitle(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const s = raw.replace(/\s+/g, " ").trim();
	if (!s || /^https?:\/\//i.test(s)) return undefined;
	return s.length > 180 ? `${s.slice(0, 179)}…` : s;
}

function addSource(map: Map<string, WebSource>, rawUrl: string, title?: string, snippet?: string): void {
	const url = normalizeWebUrl(rawUrl);
	if (!url) return;
	const domain = displayDomainOf(url);
	if (!domain) return;
	const cleanedTitle = cleanTitle(title);
	const cleanedSnippet = cleanTitle(snippet);
	const existing = map.get(url);
	if (!existing) {
		map.set(url, { url, domain, title: cleanedTitle, snippet: cleanedSnippet });
		return;
	}
	if (!existing.title && cleanedTitle) existing.title = cleanedTitle;
	if (!existing.snippet && cleanedSnippet) existing.snippet = cleanedSnippet;
}

function walkJsonSources(node: unknown, map: Map<string, WebSource>, depth = 0): void {
	if (!node || depth > 7) return;
	if (typeof node === "string") {
		const trimmed = node.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				walkJsonSources(JSON.parse(trimmed), map, depth + 1);
			} catch {
				/* 截断 JSON 由后续正则兜底 */
			}
		}
		return;
	}
	if (Array.isArray(node)) {
		for (const item of node) walkJsonSources(item, map, depth + 1);
		return;
	}
	if (typeof node !== "object") return;
	const rec = node as Record<string, unknown>;
	const rawUrl = asString(rec.url) ?? asString(rec.href) ?? asString(rec.link) ?? asString(rec.uri);
	if (rawUrl) {
		const title = asString(rec.title) ?? asString(rec.name) ?? asString(rec.headline) ?? asString(rec.site_name) ?? asString(rec.siteName);
		const snippet = asString(rec.snippet) ?? asString(rec.description) ?? asString(rec.summary) ?? asString(rec.content);
		addSource(map, rawUrl, title, snippet);
	}
	for (const key of ["results", "sources", "citations", "items", "data", "pages", "organic", "web", "content", "links"]) {
		if (key in rec) walkJsonSources(rec[key], map, depth + 1);
	}
}

function unescapeJsonLiteral(raw: string): string {
	try {
		return JSON.parse(`"${raw}"`) as string;
	} catch {
		return raw.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\");
	}
}

function scanPartialJsonPairs(text: string, map: Map<string, WebSource>): void {
	// 同时兼容截断的 JSON（如服务端 coercePartial .slice(-4000) 截掉开头的场景）
	const forward = /"(?:title|name|headline)"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}\[\]]{0,500}?"(?:url|href|link|uri)"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/gi;
	for (const m of text.matchAll(forward)) {
		addSource(map, unescapeJsonLiteral(m[2]), unescapeJsonLiteral(m[1]));
	}
	const backward = /"(?:url|href|link|uri)"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"[^{}\[\]]{0,500}?"(?:title|name|headline)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi;
	for (const m of text.matchAll(backward)) {
		addSource(map, unescapeJsonLiteral(m[1]), unescapeJsonLiteral(m[2]));
	}
	const bareJsonUrl = /"(?:url|href|link|uri)"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/gi;
	for (const m of text.matchAll(bareJsonUrl)) {
		addSource(map, unescapeJsonLiteral(m[1]));
	}
}

function scanMarkdownAndTextSources(text: string, map: Map<string, WebSource>): void {
	// Markdown 链接 [title](https://...)，跳过图片语法 ![alt](url)
	const mdLinks = /(^|[^!])\[([^\]\r\n]{1,220})\]\((https?:\/\/[^\s)]+)\)/g;
	for (const m of text.matchAll(mdLinks)) {
		addSource(map, m[3], m[2]);
	}
	// 引用式链接 [ref]: https://...
	const refLinks = /^\s*\[[^\]\r\n]+\]:\s*(https?:\/\/\S+)/gm;
	for (const m of text.matchAll(refLinks)) {
		addSource(map, m[1]);
	}
	// 成对文本格式：Title: ... \n URL: https://...
	const lines = text.split(/\r?\n/);
	let pendingTitle = "";
	for (const line of lines) {
		const tMatch = line.match(/^\s*(?:Title|标题)\s*[:：]\s*(.+)$/i);
		if (tMatch) {
			pendingTitle = tMatch[1].trim();
			continue;
		}
		const uMatch = line.match(/^\s*(?:URL|Url|Link|链接|网址)\s*[:：]\s*(https?:\/\/\S+)/i);
		if (uMatch) {
			addSource(map, uMatch[1], pendingTitle || undefined);
			pendingTitle = "";
			continue;
		}
		if (!line.trim()) pendingTitle = "";
	}
	// 裸 URL 兜底
	const bareUrls = text.match(/https?:\/\/[^\s"'<>`\]}]+/gi) ?? [];
	const candidates = bareUrls.filter((raw) => {
		const norm = normalizeWebUrl(raw);
		if (!norm) return false;
		try {
			const p = new URL(norm).pathname;
			return !ASSET_EXTENSION_RE.test(p);
		} catch {
			return false;
		}
	});
	const sourceList = candidates.length > 0 ? candidates : bareUrls;
	for (const raw of sourceList) addSource(map, raw);
}

/** 从联网工具的返回结果和参数中提取去重站点来源（保证每个来源均可安全外链打开）。 */
export function extractWebSources(args: unknown, output?: string, role?: WebToolRole | null): WebSource[] {
	const map = new Map<string, WebSource>();
	if (typeof output === "string" && output.trim()) {
		const trimmed = output.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				walkJsonSources(JSON.parse(trimmed), map);
			} catch {
				/* 走部分 JSON 与文本解析 */
			}
		}
		for (const fence of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
			const inner = fence[1]?.trim();
			if (inner && (inner.startsWith("{") || inner.startsWith("["))) {
				try {
					walkJsonSources(JSON.parse(inner), map);
				} catch {
					/* ignore */
				}
			}
		}
		scanPartialJsonPairs(output, map);
		scanMarkdownAndTextSources(output, map);
	}
	// 对于网页抓取工具，即使返回值里没有重复携带自身 URL，也要保证目标网页本身可点击查看
	if (role === "fetch") {
		for (const url of collectArgUrls(args)) {
			addSource(map, url);
		}
	}
	return [...map.values()];
}

/** 合并多次联网调用的来源并按规范化 URL 去重，保留首次出现顺序与更完整的标题。 */
export function mergeWebSources(batches: ReadonlyArray<ReadonlyArray<WebSource>>): WebSource[] {
	const map = new Map<string, WebSource>();
	for (const list of batches) {
		for (const src of list) {
			addSource(map, src.url, src.title, src.snippet);
		}
	}
	return [...map.values()];
}

/** 按出现频次选出最具代表性的前 N 个域名，用于折叠/步骤行站点图标堆叠。 */
export function topWebDomains(sources: ReadonlyArray<WebSource>, limit = 4): string[] {
	if (sources.length === 0 || limit <= 0) return [];
	const counts = new Map<string, number>();
	for (const s of sources) counts.set(s.domain, (counts.get(s.domain) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([domain]) => domain);
}

/** 将完整 URL 格式化为紧凑可读的路径展示。 */
export function formatWebUrlLabel(rawUrl: string): string {
	try {
		const u = new URL(rawUrl);
		const host = u.hostname.toLowerCase().replace(/^www\./, "");
		const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}`;
		const full = `${host}${rest}`;
		return full.length > 72 ? `${full.slice(0, 71)}…` : full;
	} catch {
		return rawUrl;
	}
}
