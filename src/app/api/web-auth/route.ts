/**
 * 网页认证：GET 状态 / POST 登录（写会话 Cookie）/ DELETE 登出（清 Cookie）。
 * 没启用认证时整体关闭（GET 返回 enabled:false，POST 404）。
 *
 * 密码登录是可选遗留路径（给 curl / 脚本的 Basic 兜底）。主路径是启动令牌换 Cookie。
 */
import { NextResponse } from "next/server";
import { configuredTrustedHosts, isSafeHost, isSafeOrigin, validBasicAuthorization } from "@/lib/auth";
import { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess, retryAfterSeconds } from "@/lib/auth-throttle";
import { authEnabled, clearSessionCookie, clearedCookieOptions, createSessionCookie, requestAuthority, safeNextPath, sessionCookieOptions, validPassword, validSessionCookie } from "@/lib/web-auth";
import { loadWebSecret } from "@/lib/web-secret";

export const dynamic = "force-dynamic";

function untrusted(request: Request): NextResponse | null {
	if (!isSafeHost(request, configuredTrustedHosts())) {
		return NextResponse.json({ success: false, error: "untrusted host" }, { status: 403 });
	}
	if (request.method !== "GET" && request.method !== "HEAD" && !isSafeOrigin(request)) {
		return NextResponse.json({ success: false, error: "cross-origin request rejected" }, { status: 403 });
	}
	return null;
}

export async function GET(request: Request) {
	const blocked = untrusted(request);
	if (blocked) return blocked;
	const password = process.env.PI_WEB_PASSWORD;
	const enabled = authEnabled();
	const authenticated = !enabled
		|| (password ? validBasicAuthorization(request.headers.get("authorization"), password) : false)
		|| validSessionCookie(request, loadWebSecret());
	return NextResponse.json({ success: true, data: { enabled, authenticated } }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	const blocked = untrusted(request);
	if (blocked) return blocked;
	const password = process.env.PI_WEB_PASSWORD;
	if (!password) return NextResponse.json({ success: false, error: "password authentication is disabled" }, { status: 404 });
	if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
		return NextResponse.json({ success: false, error: "Content-Type must be application/json" }, { status: 415 });
	}
	let body: { password?: unknown; next?: unknown };
	try {
		const reader = request.body?.getReader();
		if (!reader) return NextResponse.json({ success: false, error: "missing login payload" }, { status: 400 });
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 16 * 1024) return NextResponse.json({ success: false, error: "login payload too large" }, { status: 413 });
				chunks.push(value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { password?: unknown; next?: unknown };
	} catch {
		return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return NextResponse.json({ success: false, error: "invalid login payload" }, { status: 400 });
	}

	// 退避放在载荷校验之后、密码比对之前：畸形请求不算「猜密码」，不该计入也不该被挡住。
	const retryAfterMs = getAuthRetryAfterMs();
	if (retryAfterMs > 0) {
		return NextResponse.json({ success: false, error: "too many failed attempts" }, {
			status: 429,
			headers: { "Retry-After": String(retryAfterSeconds(retryAfterMs)), "Cache-Control": "no-store" },
		});
	}

	if (typeof body.password !== "string" || !validPassword(body.password, password)) {
		recordAuthFailure();
		return NextResponse.json({ success: false, error: "invalid password" }, { status: 401 });
	}
	recordAuthSuccess();

	const authority = requestAuthority(request);
	if (!authority) return NextResponse.json({ success: false, error: "missing host" }, { status: 400 });

	const response = NextResponse.json({ success: true, data: { next: safeNextPath(typeof body.next === "string" ? body.next : null) } }, { headers: { "Cache-Control": "no-store" } });
	const cookie = createSessionCookie(authority, loadWebSecret());
	response.cookies.set(cookie.name, cookie.value, sessionCookieOptions(request));
	return response;
}

export async function DELETE(request: Request) {
	const blocked = untrusted(request);
	if (blocked) return blocked;
	const response = NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
	const cleared = clearSessionCookie(request);
	response.cookies.set(cleared.name, cleared.value, clearedCookieOptions(request));
	return response;
}
