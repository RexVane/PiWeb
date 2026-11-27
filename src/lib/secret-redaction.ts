/**
 * 导出/回显脱敏。
 *
 * 会话 JSONL、settings.json、HTML 导出都是“原样内容”，里面可能带着用户真实用过的
 * provider key、代理口令、Authorization 头。默认出口在这里统一打码：
 *   - URL userinfo 里的密码（http(s)/socks 代理、带凭据的链接）
 *   - `sk-…` 一类 API key（含 sk-proj-、GitHub/Slack/AWS/Google 常见前缀）
 *   - `Authorization: Bearer …`
 *   - JSON 字段 apiKey/token/password/secret/trackingId 等的字符串值
 *
 * 打码只动确定是凭据的片段：普通文本、普通 URL、数字、中文都不会被改写；
 * 打码后的文本仍然是合法 JSON/JSONL（替换值都放在原有引号内）。
 */

const SENSITIVE_FIELD_NAMES =
	"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key|authorization|tracking[_-]?id)";

/** JSON 里按字段名打码：字段名精确匹配，避免误伤 tokenCount/tokens 这类普通字段。 */
const SENSITIVE_KEY_EXACT = new RegExp(`^${SENSITIVE_FIELD_NAMES}$`, "i");
const SENSITIVE_JSON_FIELD = new RegExp(`("${SENSITIVE_FIELD_NAMES}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi");
/** 嵌入在 JSON 字符串值里的转义 JSON 字段（如 `\"apiKey\":\"...\"`）。 */
const SENSITIVE_ESCAPED_JSON_FIELD = new RegExp(
	`(\\\\"${SENSITIVE_FIELD_NAMES}\\\\"\\s*:\\s*\\\\")(?:[^"\\\\]|\\\\\\\\(?:\\\\\\\\|\\\\"|[^"\\\\])|\\\\[^"\\\\])*\\\\"`,
	"gi",
);

/** URL userinfo 密码：`scheme://user:password@host` → `scheme://user:***@host`。 */
const URL_USERINFO_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s]+)@(?=[^/\s@]+)/gi;

/** 常见 API key 前缀：`sk-`/`sk-proj-`/`pk-`/`rk-`，以及 GitHub/Slack/AWS/Google 的固定前缀。 */
const API_KEY_PATTERNS: readonly RegExp[] = [
	/\b(?:sk|pk|rk)-(?:proj-|ant-|or-|svcacct-)?[A-Za-z0-9_-]{8,}\b/gi,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}\b/g,
	/\bxai-[A-Za-z0-9_-]{16,}\b/g,
];

/** `Authorization: Bearer <token>`（普通请求头文本、或日志里的一行）。 */
const BEARER_TOKEN = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;

/** 只给 URL 用：把 userinfo 密码打码，普通 URL 原样返回。 */
export function redactUrlCredentials(text: string): string {
	return text.replace(URL_USERINFO_PASSWORD, "$1$2:***@");
}

/**
 * 对普通文本脱敏。幂等：已经打码的文本再跑一遍结果不变。
 */
export function redactSecrets(text: string): string {
	if (!text) return text;
	let result = text;
	result = result.replace(URL_USERINFO_PASSWORD, "$1$2:***@");
	for (const pattern of API_KEY_PATTERNS) result = result.replace(pattern, (match) => {
		// 保留原始前缀（sk-/ghp_/AKIA…），只把密钥主体换掉，方便排查“哪一类凭据泄露”
		const prefix = /^([A-Za-z]+[-_]?(?:proj-|ant-|or-|svcacct-)?)/.exec(match)?.[1] ?? match.slice(0, 3);
		return `${prefix}***`;
	});
	result = result.replace(BEARER_TOKEN, "$1***");
	result = result.replace(SENSITIVE_JSON_FIELD, "$1\"***\"");
	result = result.replace(SENSITIVE_ESCAPED_JSON_FIELD, "$1***\\\"");
	return result;
}

/**
 * 逐行脱敏 JSONL。保持行边界与行序（含 CRLF），空行原样保留。
 * 每一行仍是合法 JSON；JSONL 里不在敏感字段/URL/key 里的普通内容不动。
 */
export function redactJsonl(text: string): string {
	if (!text) return text;
	return text.split("\n").map((line) => (line ? redactSecrets(line) : line)).join("\n");
}

const ASCII_HTML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

const HTML_ENTITY_TOKEN = /&([a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/g;
const HTML_TAG_OR_COMMENT = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?>|<!--[\s\S]*?-->|<![A-Z][^>]*>/g;
const HTML_ATTRIBUTE = /(\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*\s*=\s*)(?:"([^"]*)"|'([^']*)')/g;
const SCRIPT_OR_STYLE_BLOCK = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const SESSION_DATA_SCRIPT_ATTR = /(?:^|\s)(?:id\s*=\s*(?:"session-data"|'session-data'|session-data\b)|type\s*=\s*(?:"application\/(?:ld\+)?json"|'application\/(?:ld\+)?json'|application\/(?:ld\+)?json\b))/i;
const DATA_URI_BASE64 = /\bdata:((?:application\/json|text\/[a-z0-9.+-]+)(?:;[^;,]+)*);base64,([A-Za-z0-9+/=]+)/gi;
const INLINE_ATOB_BASE64 = /\batob\(\s*(["'])([A-Za-z0-9+/=\s]{8,})\1\s*\)/g;
const BASE64_CANDIDATE = /^[A-Za-z0-9+/=\s]{8,}$/;

/** Decode an HTML entity only when it represents an ASCII structural character (`0x20..0x7E`). */
function decodeAsciiHtmlEntity(entity: string): string | undefined {
	const named = ASCII_HTML_ENTITIES[entity.toLowerCase()];
	if (named !== undefined) return named;
	let codePoint = Number.NaN;
	if (entity.startsWith("#x") || entity.startsWith("#X")) codePoint = Number.parseInt(entity.slice(2), 16);
	else if (entity.startsWith("#")) codePoint = Number.parseInt(entity.slice(1), 10);
	if (!Number.isInteger(codePoint) || codePoint < 0x20 || codePoint > 0x7e) return undefined;
	return String.fromCharCode(codePoint);
}

/** Escape HTML special characters so re-encoded text cannot inject markup or break attribute quotes. */
function escapeHtmlSpecials(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/** Return a collision-free placeholder prefix for preserving non-ASCII HTML entities across decode/re-encode. */
function entitySentinelPrefix(text: string): string {
	let prefix = "\uE000PIENT";
	while (text.includes(prefix)) prefix += "_";
	return prefix;
}

/** Redact plain secrets and HTML-entity-encoded secrets within HTML text without altering unrelated entities. */
function redactHtmlText(text: string): string {
	const plainRedacted = redactSecrets(text);
	if (!plainRedacted.includes("&")) return plainRedacted;

	const prefix = entitySentinelPrefix(plainRedacted);
	const preserved: string[] = [];
	const decoded = plainRedacted.replace(HTML_ENTITY_TOKEN, (full, entity: string) => {
		const ascii = decodeAsciiHtmlEntity(entity);
		if (ascii !== undefined) return ascii;
		const id = preserved.length;
		preserved.push(full);
		return `${prefix}${id}\uE001`;
	});

	const decodedRedacted = redactSecrets(decoded);
	if (decodedRedacted === decoded) return plainRedacted;

	const escaped = escapeHtmlSpecials(decodedRedacted);
	if (preserved.length === 0) return escaped;
	return escaped.replace(new RegExp(`${prefix}(\\d+)\uE001`, "g"), (_, index: string) => preserved[Number(index)] ?? "");
}

/** Parse JSON only when the trimmed text starts like an object or array, returning `undefined` otherwise. */
function tryParseJsonContainer(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

/** Decode and redact Base64-encoded UTF-8 JSON payloads (preserving outer whitespace), or return `null`. */
function redactBase64Json(text: string): string | null {
	const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
	if (!match) return null;
	const [, leading, core, trailing] = match;
	if (!BASE64_CANDIDATE.test(core)) return null;
	const compact = core.replace(/\s+/g, "");
	if (compact.length < 8) return null;

	let decoded: string;
	try {
		decoded = Buffer.from(compact, "base64").toString("utf8");
	} catch {
		return null;
	}
	const parsed = tryParseJsonContainer(decoded);
	if (parsed === undefined) return null;

	const redacted = redactJsonValue(parsed);
	const reencoded = Buffer.from(JSON.stringify(redacted), "utf8").toString("base64");
	return `${leading}${reencoded}${trailing}`;
}

/** Redact `data:application/json;base64,...` and `data:text/...;base64,...` URIs without touching binary data URIs. */
function redactDataUris(text: string): string {
	return text.replace(DATA_URI_BASE64, (full, mime: string, base64Body: string) => {
		let decoded: string;
		try {
			decoded = Buffer.from(base64Body, "base64").toString("utf8");
		} catch {
			return full;
		}
		const parsed = tryParseJsonContainer(decoded);
		const redactedText = parsed !== undefined ? JSON.stringify(redactJsonValue(parsed)) : redactSecrets(decoded);
		if (redactedText === decoded) return full;
		return `data:${mime};base64,${Buffer.from(redactedText, "utf8").toString("base64")}`;
	});
}

/** Redact a string found inside a parsed JSON structure (handles nested JSON, Base64 JSON, data URIs, and HTML). */
function redactJsonString(text: string): string {
	const parsed = tryParseJsonContainer(text);
	if (parsed !== undefined) {
		const redactedValue = redactJsonValue(parsed);
		const reserialized = JSON.stringify(redactedValue);
		// Keep original formatting when the inner JSON had no secrets to redact.
		if (reserialized === JSON.stringify(parsed)) return text;
		return reserialized;
	}

	const redactedBase64 = redactBase64Json(text);
	if (redactedBase64 !== null) return redactedBase64;

	const withDataUris = redactDataUris(text);
	if (HTML_TAG_OR_COMMENT.test(withDataUris)) {
		HTML_TAG_OR_COMMENT.lastIndex = 0;
		return redactHtmlFragment(withDataUris);
	}
	HTML_TAG_OR_COMMENT.lastIndex = 0;
	return redactHtmlText(withDataUris);
}

/** Recursively redact sensitive object properties and string values across a parsed JSON value. */
function redactJsonValue(value: unknown): unknown {
	if (typeof value === "string") return redactJsonString(value);
	if (Array.isArray(value)) return value.map((item) => redactJsonValue(item));
	if (!value || typeof value !== "object") return value;

	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (SENSITIVE_KEY_EXACT.test(key) && typeof item === "string") {
			out[key] = "***";
		} else {
			out[key] = redactJsonValue(item);
		}
	}
	return out;
}

/** Redact a single HTML attribute value (Base64 JSON, data URIs, entity-encoded JSON, and plain secrets). */
function redactAttributeValue(value: string): string {
	const withDataUris = redactDataUris(value);
	const redactedBase64 = redactBase64Json(withDataUris);
	if (redactedBase64 !== null) return redactedBase64;
	return redactHtmlText(withDataUris);
}

/** Redact an HTML fragment outside `<script>` and `<style>` blocks, preserving tags and structure. */
function redactHtmlFragment(html: string): string {
	let result = "";
	let lastIndex = 0;
	HTML_TAG_OR_COMMENT.lastIndex = 0;
	let match = HTML_TAG_OR_COMMENT.exec(html);
	while (match !== null) {
		if (match.index > lastIndex) {
			result += redactHtmlText(redactDataUris(html.slice(lastIndex, match.index)));
		}
		const tag = match[0];
		if (tag.startsWith("<!--") || tag.startsWith("<!") || tag.startsWith("</")) {
			result += tag.startsWith("<!--") ? redactHtmlText(tag) : tag;
		} else {
			result += tag.replace(HTML_ATTRIBUTE, (_attr, prefix: string, dq: string | undefined, sq: string | undefined) => {
				const quote = dq !== undefined ? '"' : "'";
				const rawVal = dq ?? sq ?? "";
				return `${prefix}${quote}${redactAttributeValue(rawVal)}${quote}`;
			});
		}
		lastIndex = match.index + tag.length;
		match = HTML_TAG_OR_COMMENT.exec(html);
	}
	if (lastIndex < html.length) {
		result += redactHtmlText(redactDataUris(html.slice(lastIndex)));
	}
	return result;
}

/** Redact the body of a `<script>` element (`session-data` / JSON / Base64 JSON / inline `atob` / plain secrets). */
function redactScriptBody(attrs: string, body: string): string {
	if (SESSION_DATA_SCRIPT_ATTR.test(attrs)) {
		const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(body);
		if (match) {
			const [, leading, core, trailing] = match;
			const parsed = tryParseJsonContainer(core);
			if (parsed !== undefined) {
				const safeJson = JSON.stringify(redactJsonValue(parsed)).replace(/<\//g, "<\\/");
				return `${leading}${safeJson}${trailing}`;
			}
			const redactedBase64 = redactBase64Json(body);
			if (redactedBase64 !== null) return redactedBase64;
		}
	}
	const withAtob = body.replace(INLINE_ATOB_BASE64, (full, quote: string, b64: string) => {
		const redacted = redactBase64Json(b64);
		return redacted !== null ? `atob(${quote}${redacted}${quote})` : full;
	});
	return redactSecrets(redactDataUris(withAtob));
}

/**
 * 对导出的 HTML 会话文件脱敏，保持 HTML 结构与前端渲染脚本可用。
 * 会同时清理：
 *   - Pi SDK `<script id="session-data" type="application/json">` 中的 Base64/JSON 会话载荷（含内嵌 JSON 与 `renderedTools` HTML）
 *   - 其他内联 JSON / `atob(...)` / `data-*` / `data:...;base64,...` 载荷
 *   - 正文及属性中的明文或 HTML 实体编码凭据
 */
export function redactExportedHtml(html: string): string {
	if (!html) return html;
	let result = "";
	let lastIndex = 0;
	SCRIPT_OR_STYLE_BLOCK.lastIndex = 0;
	let match = SCRIPT_OR_STYLE_BLOCK.exec(html);
	while (match !== null) {
		if (match.index > lastIndex) {
			result += redactHtmlFragment(html.slice(lastIndex, match.index));
		}
		const [full, tagName, attrs, body] = match;
		if (tagName.toLowerCase() === "style") {
			result += full;
		} else {
			result += `<${tagName}${attrs}>${redactScriptBody(attrs, body)}</${tagName}>`;
		}
		lastIndex = match.index + full.length;
		match = SCRIPT_OR_STYLE_BLOCK.exec(html);
	}
	if (lastIndex < html.length) {
		result += redactHtmlFragment(html.slice(lastIndex));
	}
	return result;
}
