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
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { COOKIE_PREFIX, SESSION_MAX_AGE_SECONDS, readCookieHeader, safeNextPath } from "./web-auth-shared";

export { COOKIE_PREFIX, SESSION_MAX_AGE_SECONDS, readCookieHeader, safeNextPath };

const COOKIE_PAYLOAD_VERSION = 1;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export interface SessionCookiePayload {
	version: typeof COOKIE_PAYLOAD_VERSION;
	/** 签发时的 host:port；Cookie 名与签名都绑定它 */
	authority: string;
	issuedAt: number;
	expiresAt: number;
}

function encodeBase64Url(value: Buffer): string {
	return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 严格解码：字符集、长度、往返一致性都要过，避免 Buffer 宽松解码吃掉非法字符 */
function decodeBase64Url(value: string): Buffer | undefined {
	if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;
	const decoded = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
	return encodeBase64Url(decoded) === value ? decoded : undefined;
}

/**
 * 认证是否启用：只看 PI_WEB_AUTH（1 / true / on / yes）。不再有第二个开关。
 * 反代后面 PiWeb 仍绑回环，绑定位址判断不出「是否暴露」，所以这种情况必须显式打开。
 */
export function authEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const flag = (env.PI_WEB_AUTH ?? "").trim().toLowerCase();
	return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
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
	return COOKIE_PREFIX + createHash("sha256").update(authority).digest("base64url");
}

function signature(secret: Buffer, body: string): Buffer {
	return createHmac("sha256", secret).update(body).digest();
}

export function encodeSessionCookie(payload: SessionCookiePayload, secret: Buffer): string {
	const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
	return `v1.${body}.${encodeBase64Url(signature(secret, body))}`;
}

export function decodeSessionCookie(value: string, secret: Buffer): SessionCookiePayload | undefined {
	const parts = value.split(".");
	if (parts.length !== 3 || parts[0] !== "v1") return undefined;
	const body = parts[1];
	const encoded = parts[2];
	if (!body || !encoded) return undefined;
	const actual = decodeBase64Url(encoded);
	if (!actual) return undefined;
	const expected = signature(secret, body);
	if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined;
	const bodyBytes = decodeBase64Url(body);
	if (!bodyBytes) return undefined;
	let decoded: unknown;
	try {
		decoded = JSON.parse(bodyBytes.toString("utf8"));
	} catch {
		return undefined;
	}
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
	const payload = decoded as Partial<SessionCookiePayload>;
	if (payload.version !== COOKIE_PAYLOAD_VERSION) return undefined;
	if (typeof payload.authority !== "string") return undefined;
	if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)) return undefined;
	return payload as SessionCookiePayload;
}

/** 为一个权威签一张新 Cookie（名字、值、有效期一起给） */
export function createSessionCookie(authority: string, secret: Buffer, now = Date.now()) {
	const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
	const payload: SessionCookiePayload = { version: COOKIE_PAYLOAD_VERSION, authority, issuedAt: now, expiresAt };
	return {
		name: cookieNameForAuthority(authority),
		value: encodeSessionCookie(payload, secret),
		expiresAt,
		maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
	};
}

/** 吊销清单（由 web-secret 从磁盘读出）：notBefore 之前签发的全部作废；revoked 里是单张 Cookie 的指纹 */
export interface SessionRevocationList {
	notBefore: number;
	revoked: ReadonlyMap<string, number>;
}

/** 单张 Cookie 的指纹：吊销清单里只存它，不存 Cookie 本身 */
export function sessionCookieId(raw: string): string {
	return createHash("sha256").update(raw).digest("base64url");
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
	const cookie = sessionCookieFromRequest(request, secret);
	if (!cookie) return false;
	const { payload } = cookie;
	if (revocations && (payload.issuedAt < revocations.notBefore || revocations.revoked.has(cookie.id))) return false;
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
