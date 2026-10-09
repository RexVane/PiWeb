/**
 * 会话认证的共享部分（客户端安全，无 node 内置模块依赖）：
 * 登录页与 proxy / API 路由都用这些常量与纯函数。
 */

export const SESSION_COOKIE = "piweb_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** 登录后跳转目标白名单：仅同源相对路径，防开放重定向 */
export function safeNextPath(value: string | null | undefined): string {
	if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
	try {
		const parsed = new URL(value, "http://localhost");
		return parsed.origin === "http://localhost" ? `${parsed.pathname}${parsed.search}` : "/";
	} catch {
		return "/";
	}
}

/** 从 Cookie 请求头里取指定 cookie */
export function readCookieHeader(header: string | null, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) {
			try {
				return decodeURIComponent(part.slice(eq + 1).trim());
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}
