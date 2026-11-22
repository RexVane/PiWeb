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

/** JSON 里按字段名打码：字段名精确匹配，避免误伤 tokenCount/tokens 这类普通字段。 */
const SENSITIVE_JSON_FIELD =
	/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key|authorization|tracking[_-]?id)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

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
