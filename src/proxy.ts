import { NextResponse, type NextRequest } from "next/server";
import { configuredTrustedHosts, isSafeHost, isSafeOrigin } from "@/lib/auth";
import { authEnabled, clearSessionCookie, clearedCookieOptions, cookieNameForAuthority, createSessionCookie, decodeSessionCookie, readCookieHeader, requestAuthority, requestDeviceType, sessionCookieFromRequest, sessionCookieId, sessionCookieOptions, validSessionCookie } from "@/lib/web-auth";
import { rememberWebDevice } from "@/lib/web-devices";
import { TOKEN_QUERY, consumeLaunchToken } from "@/lib/web-launch-token";
import { loadSessionRevocations, loadWebSecret } from "@/lib/web-secret";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** 未认证也可达：登录页自身、认证接口，以及手机扫码用的配对入口（短码自己就是凭据） */
const PUBLIC_PATHS = new Set(["/login", "/api/web-auth", "/pair"]);
/** 静态资源不参与认证（dev 的 assetPrefix 是 /_piweb-dev/<id>，生产是 _next） */
const ASSET_PREFIXES = ["/_next/", "/_piweb-dev/"];
const ASSET_PATHS = new Set(["/icon.svg", "/favicon.ico"]);

/**
 * 认证网关。三件事，顺序不能换：
 *   1. Host 校验 —— 无论有没有开认证都要做（DNS rebinding 防护靠它）；
 *   2. 同源校验 —— 非只读方法必须同源；
 *   3. 凭据校验 —— 启动令牌换 Cookie / 已有 Cookie。
 */
export function proxy(request: NextRequest) {
	if (!isSafeHost(request, configuredTrustedHosts())) {
		return NextResponse.json({ success: false, error: "untrusted host" }, { status: 403 });
	}
	if (!READ_METHODS.has(request.method) && !isSafeOrigin(request)) {
		return NextResponse.json({ success: false, error: "cross-origin request rejected" }, { status: 403 });
	}

	if (!authEnabled()) return NextResponse.next();

	const pathname = request.nextUrl.pathname;
	if (pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) return NextResponse.next();
	if (ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || ASSET_PATHS.has(pathname)) return NextResponse.next();

	const secret = loadWebSecret();
	const revocations = loadSessionRevocations();
	if (revocations.unavailable) return NextResponse.json({ success: false, error: "session authentication is temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });


	// 启动令牌换 Cookie：只认根路径、只认一个 token 参数、只认 GET。
	// 令牌不接受出现在 API 路径上，也不接受走 Authorization 头。
	if (request.method === "GET" && pathname === "/") {
		const tokens = request.nextUrl.searchParams.getAll(TOKEN_QUERY);
		if (tokens.length > 0) {
			const authority = requestAuthority(request);
			if (authority && tokens.length === 1 && consumeLaunchToken(tokens[0], process.env.PI_WEB_LAUNCH_TOKEN, Date.now(), revocations.notBefore)) {
				const cookie = createSessionCookie(authority, secret, Date.now(), requestDeviceType(request), revocations.notBefore);
				void rememberWebDevice(sessionCookieId(cookie.value), decodeSessionCookie(cookie.value, secret)!).catch((error) => console.error("[auth] Could not remember device:", error));
				const response = redirectToCleanRoot(request);
				response.cookies.set(cookie.name, cookie.value, sessionCookieOptions(request));
				return response;
			}
			// 令牌无效但 Cookie 还有效：把地址栏里的令牌清掉，别让它留在浏览器历史里
			if (validSessionCookie(request, secret, Date.now(), revocations)) return redirectToCleanRoot(request);
		}
	}

	const authenticated = validSessionCookie(request, secret, Date.now(), revocations);
	if (authenticated) {
		const cookie = sessionCookieFromRequest(request, secret);
		if (cookie) void rememberWebDevice(cookie.id, cookie.payload).catch((error) => console.error("[auth] Could not remember device:", error));
		return NextResponse.next();
	}
	if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

	const authority = requestAuthority(request);
	const hasExplicitCookie = authority ? Boolean(readCookieHeader(request.headers.get("cookie"), cookieNameForAuthority(authority))) : false;

	// 页面请求 → 登录页（带返回地址）；API → 401（没有 Basic，不发挑战头）。
	if (pathname.startsWith("/api/")) {
		return new NextResponse(JSON.stringify({ success: false, error: "authentication required" }), {
			status: 401,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "no-store",
			},
		});
	}
	const login = request.nextUrl.clone();
	login.pathname = "/login";
	login.search = `?next=${encodeURIComponent(`${pathname}${request.nextUrl.search}`)}`;
	const response = NextResponse.redirect(login, 307);
	if (hasExplicitCookie) {
		const cleared = clearSessionCookie(request);
		response.cookies.set(cleared.name, cleared.value, clearedCookieOptions(request));
	}
	return response;
}

/** 去掉查询串的根地址：令牌不能留在地址栏和浏览器历史里 */
function redirectToCleanRoot(request: NextRequest): NextResponse {
	const url = request.nextUrl.clone();
	url.pathname = "/";
	url.search = "";
	const response = NextResponse.redirect(url, 303);
	response.headers.set("cache-control", "no-store");
	response.headers.set("referrer-policy", "no-referrer");
	return response;
}

export const config = {
	matcher: ["/((?!_next/|_piweb-dev/|api/files/upload$|icon\\.svg|favicon\\.ico).*)"],
};
