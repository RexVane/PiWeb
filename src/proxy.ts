import { NextResponse, type NextRequest } from "next/server";
import { isSafeHost, isSafeOrigin, validBasicAuthorization } from "@/lib/auth";
import { SESSION_COOKIE, readCookieHeader, validSessionToken } from "@/lib/web-auth";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** 未认证也可达：登录页自身与认证接口 */
const PUBLIC_PATHS = new Set(["/login", "/api/web-auth"]);
/** 静态资源不参与认证（dev 的 assetPrefix 是 /_piweb-dev/<id>，生产是 /_next） */
const ASSET_PREFIXES = ["/_next/", "/_piweb-dev/"];
const ASSET_PATHS = new Set(["/icon.svg", "/favicon.ico"]);

export function proxy(request: NextRequest) {
	const password = process.env.PI_WEB_PASSWORD;
	if (!isSafeHost(request, Boolean(password))) {
		return NextResponse.json({ success: false, error: "untrusted host" }, { status: 403 });
	}
	if (!READ_METHODS.has(request.method) && !isSafeOrigin(request)) {
		return NextResponse.json({ success: false, error: "cross-origin request rejected" }, { status: 403 });
	}

	if (!password) return NextResponse.next();

	const pathname = request.nextUrl.pathname;
	if (pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) return NextResponse.next();
	if (ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || ASSET_PATHS.has(pathname)) return NextResponse.next();

	const authenticated =
		validBasicAuthorization(request.headers.get("authorization"), password) ||
		validSessionToken(readCookieHeader(request.headers.get("cookie"), SESSION_COOKIE), password);
	if (authenticated) return NextResponse.next();

	if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

	// 页面请求 → 登录页（带返回地址）；API → 401，保留脚本客户端的 Basic 挑战。
	if (pathname.startsWith("/api/")) {
		return new NextResponse(JSON.stringify({ success: false, error: "authentication required" }), {
			status: 401,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"WWW-Authenticate": 'Basic realm="PiWeb", charset="UTF-8"',
				"Cache-Control": "no-store",
			},
		});
	}
	const login = request.nextUrl.clone();
	login.pathname = "/login";
	login.search = `?next=${encodeURIComponent(`${pathname}${request.nextUrl.search}`)}`;
	return NextResponse.redirect(login, 307);
}

export const config = {
	matcher: ["/((?!_next/|_piweb-dev/|icon\\.svg|favicon\\.ico).*)"],
};
