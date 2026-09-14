/**
 * 会话认证（服务端）：登录页用密码换一个无状态令牌（HMAC 派生），存 httpOnly Cookie。
 * Basic 认证保留为 API / 脚本兜底（bin/piweb.js 探活与 curl 依赖它）。
 * 纯常量与浏览器安全函数在 web-auth-shared（登录页引用，不能带上 node:crypto）。
 */
import { createHmac } from "node:crypto";
import { equalText } from "./auth";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, readCookieHeader, safeNextPath } from "./web-auth-shared";

export { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, readCookieHeader, safeNextPath };

/** 校验登录密码（恒定时间比较） */
export function validPassword(candidate: string, password: string): boolean {
	return equalText(candidate, password);
}

/** 令牌 = 过期时间戳 + 以密码为密钥的 HMAC。密码变更即全部令牌失效。 */
export function createSessionToken(password: string, now = Date.now()): string {
	const expires = now + SESSION_MAX_AGE_SECONDS * 1000;
	return `${expires}.${sign(password, String(expires))}`;
}

export function validSessionToken(token: string | undefined | null, password: string, now = Date.now()): boolean {
	if (!token) return false;
	const separator = token.indexOf(".");
	if (separator <= 0) return false;
	const expires = Number(token.slice(0, separator));
	if (!Number.isSafeInteger(expires) || expires <= now) return false;
	return equalText(token.slice(separator + 1), sign(password, String(expires)));
}

function sign(password: string, payload: string): string {
	return createHmac("sha256", `piweb-session:${password}`).update(payload).digest("base64url");
}

export function isSecureRequest(request: Request): boolean {
	if (new URL(request.url).protocol === "https:") return true;
	return (request.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
}

export function sessionCookieOptions(request: Request) {
	return {
		httpOnly: true,
		sameSite: "strict" as const,
		secure: isSecureRequest(request),
		path: "/",
		maxAge: SESSION_MAX_AGE_SECONDS,
	};
}

export function clearedCookieOptions(request: Request) {
	return { ...sessionCookieOptions(request), maxAge: 0 };
}
