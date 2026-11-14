/**
 * 会话认证（服务端）：启动令牌换一个无状态令牌（HMAC 派生），存 httpOnly Cookie。
 * 这是唯一的认证路径 —— 密码登录已移除，Basic 也不再被接受。
 *
 * 设计要点（借鉴 deepseek-harness 的 browser-auth）：
 *   1. 签名密钥是独立随机值（web-secret.ts），与启动令牌无关 —— Cookie 泄露也无法离线爆破凭据；
 *   2. Cookie 载荷带上权威（host:port），Cookie 名也由权威派生 —— 令牌不能跨域名/端口复用；
 *   3. 载荷自带 issuedAt / expiresAt，服务端只验签名与时间窗，不存会话表；
 *      登出要撤回的那一张、以及「让所有设备重新登录」的时间线，由调用方传入吊销清单（web-secret.ts）。
 *
 * 纯常量与浏览器安全函数在 web-auth-shared（登录页引用，不能带上 node:crypto）。
 */
import { cookieNameForAuthority as protocolCookieName, sessionCookieId as protocolCookieId, encodeSessionCookie as protocolEncodeCookie, decodeSessionCookie as protocolDecodeCookie } from "../../scripts/web-auth-protocol.mjs";
import { randomBytes } from "node:crypto";
import { COOKIE_PREFIX, SESSION_MAX_AGE_SECONDS, readCookieHeader, safeNextPath } from "./web-auth-shared";

export { COOKIE_PREFIX, SESSION_MAX_AGE_SECONDS, readCookieHeader, safeNextPath };

const COOKIE_PAYLOAD_VERSION = 1;

export interface SessionCookiePayload {
	/** Revocation generation observed by the exchange; closes concurrent logout races. */
	revocationEpoch?: number;
	sessionId?: string;
	deviceType?: string;
	version: typeof COOKIE_PAYLOAD_VERSION;
	/** 签发时的 host:port；Cookie 名与签名都绑定它 */
	authority: string;
	issuedAt: number;
	expiresAt: number;
}

/**
 * 认证默认启用；只有 PI_WEB_AUTH=0 明确关闭。其他值与未设置均保持启用。
 * 反代后的暴露范围不能由绑定位址推断，因此不据此自动关闭认证。
 */
export function authEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const flag = (env.PI_WEB_AUTH ?? "").trim().toLowerCase();
	return flag !== "0";
}

/** 请求的权威（host:port，小写）。带用户信息或解析失败一律无效。 */
export function requestAuthority(request: Request): string | undefined {
	const host = request.headers.get("host") || new URL(request.url).host;
	if (!host) return undefined;
	try {
		const parsed = new URL(`http://${host}`);
		if (parsed.username || parsed.password) return undefined;
		return parsed.host.toLowerCase();
	} catch {
		return undefined;
	}
}

export function cookieNameForAuthority(authority: string): string {
	return protocolCookieName(authority);
}

export function encodeSessionCookie(payload: SessionCookiePayload, secret: Buffer): string {
	return protocolEncodeCookie(payload, secret);
}

export function decodeSessionCookie(value: string, secret: Buffer): SessionCookiePayload | undefined {
	return protocolDecodeCookie(value, secret);
}

/** 为一个权威签一张新 Cookie（名字、值、有效期一起给） */
export function createSessionCookie(authority: string, secret: Buffer, now = Date.now(), deviceType = "浏览器", revocationEpoch?: number) {
	const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
	const payload: SessionCookiePayload = { version: COOKIE_PAYLOAD_VERSION, authority, issuedAt: now, expiresAt, sessionId: randomBytes(16).toString("base64url"), deviceType, revocationEpoch };
	return {
		name: cookieNameForAuthority(authority),
		value: encodeSessionCookie(payload, secret),
		expiresAt,
		maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
	};
}

export function requestDeviceType(request: Request): string {
	const agent = request.headers.get("user-agent") ?? "";
	return /iPhone|iPad|Android|Mobile/i.test(agent) ? "移动设备" : /Windows|Macintosh|Linux/i.test(agent) ? "电脑浏览器" : "浏览器";
}

/** 吊销清单（由 web-secret 从磁盘读出）：notBefore 之前签发的全部作废；revoked 里是单张 Cookie 的指纹 */
export interface SessionRevocationList {
	unavailable?: boolean;
	notBefore: number;
	revoked: ReadonlyMap<string, number>;
}

/** 单张 Cookie 的指纹：吊销清单里只存它，不存 Cookie 本身 */
export function sessionCookieId(raw: string): string {
	return protocolCookieId(raw);
}

/** 请求自带的、签名与权威都对的会话 Cookie（不看时间窗与吊销）；登出时用它算出要撤的那一张 */
export function sessionCookieFromRequest(request: Request, secret: Buffer): { id: string; payload: SessionCookiePayload } | undefined {
	const authority = requestAuthority(request);
	if (!authority) return undefined;
	const raw = readCookieHeader(request.headers.get("cookie"), cookieNameForAuthority(authority));
	if (!raw) return undefined;
	const payload = decodeSessionCookie(raw, secret);
	if (!payload || payload.authority !== authority) return undefined;
	return { id: sessionCookieId(raw), payload };
}

/** 校验请求自带的会话 Cookie：签名、权威、时间窗都要对，且没被吊销 */
export function validSessionCookie(request: Request, secret: Buffer, now = Date.now(), revocations?: SessionRevocationList): boolean {
	if (revocations?.unavailable) return false;
	const cookie = sessionCookieFromRequest(request, secret);
	if (!cookie) return false;
	const { payload } = cookie;
	if (revocations && ((payload.revocationEpoch === undefined ? payload.issuedAt < revocations.notBefore : payload.revocationEpoch !== revocations.notBefore) || revocations.revoked.has(cookie.id))) return false;
	return payload.issuedAt <= now
		&& payload.expiresAt > now
		&& payload.expiresAt > payload.issuedAt
		&& payload.expiresAt - payload.issuedAt <= SESSION_MAX_AGE_SECONDS * 1000;
}

/** 清 Cookie 时要用同一个名字，否则删不掉 */
export function clearSessionCookie(request: Request) {
	const authority = requestAuthority(request);
	return { name: authority ? cookieNameForAuthority(authority) : COOKIE_PREFIX, value: "" };
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
