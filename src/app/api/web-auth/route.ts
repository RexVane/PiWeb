/**
 * 网页认证：GET 状态 / POST 登录（写会话 Cookie）/ DELETE 登出（清 Cookie）。
 * 无密码配置时整体关闭（GET 返回 enabled:false，POST 404）。
 */
import { NextResponse } from "next/server";
import { isSafeHost, isSafeOrigin, validBasicAuthorization } from "@/lib/auth";
import { SESSION_COOKIE, clearedCookieOptions, createSessionToken, readCookieHeader, safeNextPath, sessionCookieOptions, validPassword, validSessionToken } from "@/lib/web-auth";

export const dynamic = "force-dynamic";

function untrusted(request: Request): NextResponse | null {
	const password = process.env.PI_WEB_PASSWORD;
	if (!isSafeHost(request, Boolean(password))) {
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
	const enabled = Boolean(password);
	const authenticated = !enabled
		|| validBasicAuthorization(request.headers.get("authorization"), password!)
		|| validSessionToken(readCookieHeader(request.headers.get("cookie"), SESSION_COOKIE), password!);
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
	if (typeof body.password !== "string" || !validPassword(body.password, password)) {
		return NextResponse.json({ success: false, error: "invalid password" }, { status: 401 });
	}
	const response = NextResponse.json({ success: true, data: { next: safeNextPath(typeof body.next === "string" ? body.next : null) } }, { headers: { "Cache-Control": "no-store" } });
	response.cookies.set(SESSION_COOKIE, createSessionToken(password), sessionCookieOptions(request));
	return response;
}

export async function DELETE(request: Request) {
	const blocked = untrusted(request);
	if (blocked) return blocked;
	const response = NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
	response.cookies.set(SESSION_COOKIE, "", clearedCookieOptions(request));
	return response;
}
