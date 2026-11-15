/**
 * 网页认证：GET 状态 / POST 启动令牌或配对码换 Cookie（密码登录已永久移除，传 password 仍回 410）/ DELETE 登出。
 * DELETE 在服务端撤回本设备这张 Cookie 再清掉它（被拷走的副本同样失效）；
 * DELETE ?scope=all 让此刻之前签发的所有 Cookie 失效（所有设备都要重新认证）。
 * 没启用认证时整体关闭（GET 返回 enabled:false）。
 */
import { NextResponse } from "next/server";
import { configuredTrustedHosts, isSafeHost, isSafeOrigin } from "@/lib/auth";
import { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess, retryAfterSeconds } from "@/lib/auth-throttle";
import { authEnabled, clearSessionCookie, clearedCookieOptions, createSessionCookie, decodeSessionCookie, requestAuthority, requestDeviceType, sessionCookieFromRequest, sessionCookieId, sessionCookieOptions, validSessionCookie } from "@/lib/web-auth";
import { loadSessionRevocations, loadWebSecret, revokeAllSessions, revokeSessionCookie } from "@/lib/web-secret";
import { listWebDevices, rememberWebDevice } from "@/lib/web-devices";
import { consumeLaunchToken, invalidateLaunchTokens } from "@/lib/web-launch-token";
import { invalidatePairCodes, verifyPairCode } from "@/lib/remote/pairing";

export const dynamic = "force-dynamic";

function parseLoginCredential(raw: string): { kind: "token" | "pair" | "either"; value: string } {
	const trimmed = raw.trim();
	try {
		const parsed = trimmed.startsWith("/") ? new URL(trimmed, "http://piweb.local") : new URL(trimmed);
		const token = parsed.searchParams.get("token")?.trim();
		if (token) return { kind: "token", value: token };
		const code = parsed.searchParams.get("code")?.trim();
		if (code) return { kind: "pair", value: code };
	} catch {
		/* pure token or pairing code */
	}
	return { kind: "either", value: trimmed };
}

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
	if (new URL(request.url).searchParams.get("devices") === "1") {
		if (!authenticated || !enabled) return NextResponse.json({ success: false, error: "authentication required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
		const current = sessionCookieFromRequest(request, loadWebSecret())?.id;
		return NextResponse.json({ success: true, data: { enabled, authenticated, devices: (await listWebDevices()).map((device) => ({ ...device, current: device.id === current })) } }, { headers: { "Cache-Control": "no-store" } });
	}
	return NextResponse.json(
		{ success: true, data: { enabled, authenticated } },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

/** 启动令牌或配对码登录；密码登录已永久移除（提交 password 字段仍返回 410 Gone）。 */
export async function POST(request: Request) {
	const blocked = untrusted(request);
	if (blocked) return blocked;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400, headers: { "Cache-Control": "no-store" } });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return NextResponse.json({ success: false, error: "invalid request body" }, { status: 400, headers: { "Cache-Control": "no-store" } });
	}
	const record = body as Record<string, unknown>;
	if ("password" in record) {
		return NextResponse.json(
			{ success: false, error: "password login has been removed; run the PiWeb launcher on its host to open the login page" },
			{ status: 410, headers: { "Cache-Control": "no-store" } },
		);
	}
	if (!authEnabled()) {
		return NextResponse.json({ success: true, data: { enabled: false, authenticated: true } }, { headers: { "Cache-Control": "no-store" } });
	}
	const raw = record.credential ?? record.token ?? record.pairCode ?? record.code;
	if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 2048) {
		return NextResponse.json({ success: false, error: "launch token or pairing code is required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
	}
	const retryAfterMs = getAuthRetryAfterMs();
	if (retryAfterMs > 0) {
		const seconds = retryAfterSeconds(retryAfterMs);
		return NextResponse.json(
			{ success: false, error: "too many login attempts; please try again shortly", retryAfterSeconds: seconds },
			{ status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(seconds) } },
		);
	}
	const revocations = loadSessionRevocations();
	if (revocations.unavailable) {
		return NextResponse.json({ success: false, error: "session authentication is temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
	}
	const parsed = parseLoginCredential(raw);
	let ok = false;
	let pairFailure: "expired" | "unknown" | "rate-limited" | undefined;
	let pairRetrySeconds: number | undefined;
	if (parsed.kind === "token" || parsed.kind === "either") {
		ok = consumeLaunchToken(parsed.value, process.env.PI_WEB_LAUNCH_TOKEN, Date.now(), revocations.notBefore);
	}
	if (!ok && (parsed.kind === "pair" || parsed.kind === "either")) {
		const outcome = verifyPairCode(parsed.value, Date.now(), revocations.notBefore);
		if (outcome.ok) ok = true;
		else {
			pairFailure = outcome.reason;
			pairRetrySeconds = outcome.retryAfterSeconds;
		}
	}
	if (pairFailure === "rate-limited") {
		const seconds = pairRetrySeconds ?? 60;
		return NextResponse.json(
			{ success: false, error: "too many pairing attempts; please try again shortly", retryAfterSeconds: seconds },
			{ status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(seconds) } },
		);
	}
	if (!ok) {
		const delay = recordAuthFailure();
		return NextResponse.json(
			{
				success: false,
				error: pairFailure === "expired" ? "pairing code expired" : "invalid launch token or pairing code",
				retryAfterSeconds: retryAfterSeconds(delay),
			},
			{ status: 401, headers: { "Cache-Control": "no-store" } },
		);
	}
	recordAuthSuccess();
	const authority = requestAuthority(request);
	if (!authority) {
		return NextResponse.json({ success: false, error: "invalid request authority" }, { status: 400, headers: { "Cache-Control": "no-store" } });
	}
	const secret = loadWebSecret();
	const cookie = createSessionCookie(authority, secret, Date.now(), requestDeviceType(request), revocations.notBefore);
	await rememberWebDevice(sessionCookieId(cookie.value), decodeSessionCookie(cookie.value, secret)!).catch((error) => console.error("[web-auth] Could not remember device:", error));
	const response = NextResponse.json({ success: true, data: { enabled: true, authenticated: true } }, { headers: { "Cache-Control": "no-store" } });
	response.cookies.set(cookie.name, cookie.value, sessionCookieOptions(request));
	return response;
}

export async function DELETE(request: Request) {
	const blocked = untrusted(request);
	if (blocked) return blocked;
	if (authEnabled()) {
		const secret = loadWebSecret();
		const all = new URL(request.url).searchParams.get("scope") === "all";
		const deviceId = new URL(request.url).searchParams.get("device");
		// 「所有设备」只能由一个仍然有效的会话发起（DELETE 走不到 proxy 的拦截：/api/web-auth 是公开路径）
		if ((all || deviceId) && !validSessionCookie(request, secret, Date.now(), loadSessionRevocations())) {
			return NextResponse.json({ success: false, error: "authentication required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
		}
		try {
			if (deviceId) {
				const device = (await listWebDevices()).find((entry) => entry.id === deviceId);
				if (!device) return NextResponse.json({ success: false, error: "device not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
				await revokeSessionCookie(device.id, device.expiresAt);
				const current = sessionCookieFromRequest(request, secret)?.id;
				if (current !== device.id) return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
			}
			if (all) { await revokeAllSessions(); invalidatePairCodes(); invalidateLaunchTokens(loadSessionRevocations().notBefore); }
			else if (!deviceId) {
				const cookie = sessionCookieFromRequest(request, secret);
				if (cookie && cookie.payload.expiresAt > Date.now()) await revokeSessionCookie(cookie.id, cookie.payload.expiresAt);
			}
		} catch (error) {
			// 吊销没记下来就别报「已退出」：Cookie 的副本还能用
			return NextResponse.json(
				{ success: false, error: "could not revoke the session; please try again" },
				{ status: 500, headers: { "Cache-Control": "no-store" } },
			);
		}
	}
	const response = NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
	const cleared = clearSessionCookie(request);
	response.cookies.set(cleared.name, cleared.value, clearedCookieOptions(request));
	return response;
}
