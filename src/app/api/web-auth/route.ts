/**
 * 网页认证：GET 状态 / POST 已废弃（密码登录移除）/ DELETE 登出。
 * DELETE 在服务端撤回本设备这张 Cookie 再清掉它（被拷走的副本同样失效）；
 * DELETE ?scope=all 让此刻之前签发的所有 Cookie 失效（所有设备都要重新用启动令牌登录）。
 * 没启用认证时整体关闭（GET 返回 enabled:false）。
 *
 * 唯一的登录路径是启动令牌换 Cookie（见 src/proxy.ts）：根路径的 GET 带上 ?token=…
 * 换一张签名 Cookie，之后带着 Cookie 请求即可。这里不再收任何凭据。
 */
import { NextResponse } from "next/server";
import { configuredTrustedHosts, isSafeHost, isSafeOrigin } from "@/lib/auth";
import { authEnabled, clearSessionCookie, clearedCookieOptions, sessionCookieFromRequest, validSessionCookie } from "@/lib/web-auth";
import { loadSessionRevocations, loadWebSecret, revokeAllSessions, revokeSessionCookie } from "@/lib/web-secret";

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
	const enabled = authEnabled();
	const authenticated = !enabled || validSessionCookie(request, loadWebSecret(), Date.now(), loadSessionRevocations());
	return NextResponse.json(
		{ success: true, data: { enabled, authenticated } },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

/** 密码登录已移除：这里曾经用密码换会话 Cookie，现在只回答「此路已废」。 */
export async function POST(request: Request) {
	const blocked = untrusted(request);
	if (blocked) return blocked;
	return NextResponse.json(
		{ success: false, error: "password login has been removed; use the launch token link printed at startup" },
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}

export async function DELETE(request: Request) {
	const blocked = untrusted(request);
	if (blocked) return blocked;
	if (authEnabled()) {
		const secret = loadWebSecret();
		const all = new URL(request.url).searchParams.get("scope") === "all";
		// 「所有设备」只能由一个仍然有效的会话发起（DELETE 走不到 proxy 的拦截：/api/web-auth 是公开路径）
		if (all && !validSessionCookie(request, secret, Date.now(), loadSessionRevocations())) {
			return NextResponse.json({ success: false, error: "authentication required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
		}
		try {
			if (all) revokeAllSessions();
			else {
				const cookie = sessionCookieFromRequest(request, secret);
				if (cookie && cookie.payload.expiresAt > Date.now()) revokeSessionCookie(cookie.id, cookie.payload.expiresAt);
			}
		} catch (error) {
			// 吊销没记下来就别报「已退出」：Cookie 的副本还能用
			return NextResponse.json(
				{ success: false, error: `could not revoke the session: ${error instanceof Error ? error.message : String(error)}` },
				{ status: 500, headers: { "Cache-Control": "no-store" } },
			);
		}
	}
	const response = NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
	const cleared = clearSessionCookie(request);
	response.cookies.set(cleared.name, cleared.value, clearedCookieOptions(request));
	return response;
}
