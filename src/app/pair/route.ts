import { NextResponse } from "next/server";
import { verifyPairCode } from "@/lib/remote/pairing";
import { authEnabled, createSessionCookie, requestAuthority, requestDeviceType, sessionCookieOptions, sessionCookieId, decodeSessionCookie } from "@/lib/web-auth";
import { rememberWebDevice } from "@/lib/web-devices";
import { loadSessionRevocations, loadWebSecret } from "@/lib/web-secret";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/** Next 在反向代理后可能给出内部 URL；相对跳转让设备始终留在扫码时的地址。 */
function redirect(path: string) {
	return new NextResponse(null, { status: 303, headers: { ...NO_STORE, Location: path } });
}

/**
 * 手机扫码后落到这里：兑换一次性短码 → 种会话 Cookie → 回首页。
 *
 * 只在根路径种 Cookie 的那套逻辑（见 src/proxy.ts）不变；这里复用同一份 Cookie 工具，
 * 所以手机拿到的 Cookie 与“点带令牌链接”完全等价，只是凭据来源不同。
 */
/**
 * 不导出的话 Next 会拿 GET 处理器应答 HEAD：聊天软件的链接预览先发一个 HEAD，
 * 一次性配对码就被它用掉了，真正扫码的人反而进不来。
 */
export function HEAD() {
	return new NextResponse(null, { status: 405, headers: { ...NO_STORE, Allow: "GET" } });
}

export async function GET(request: Request) {
	const revocations = loadSessionRevocations();
	if (revocations.unavailable) return NextResponse.json({ success: false, error: "session authentication is temporarily unavailable" }, { status: 503, headers: NO_STORE });
	const url = new URL(request.url);
	const outcome = verifyPairCode(url.searchParams.get("code") ?? "", Date.now(), revocations.notBefore);

	if (!outcome.ok) {
		const response = outcome.reason === "rate-limited"
			? NextResponse.json({ success: false, error: "Too many pairing attempts. Please try again shortly." }, { status: 429, headers: NO_STORE })
			: redirect(`/login?${new URLSearchParams({ pair: outcome.reason })}`);
		if (outcome.retryAfterSeconds) response.headers.set("retry-after", String(outcome.retryAfterSeconds));
		return response;
	}

	if (!authEnabled()) return redirect("/");
	const authority = requestAuthority(request);
	if (!authority) return redirect("/");

	const secret = loadWebSecret();
	const cookie = createSessionCookie(authority, secret, Date.now(), requestDeviceType(request), revocations.notBefore);
	await rememberWebDevice(sessionCookieId(cookie.value), decodeSessionCookie(cookie.value, secret)!).catch((error) => console.error("[pair] Could not remember device:", error));
	const response = redirect("/");
	response.cookies.set(cookie.name, cookie.value, sessionCookieOptions(request));
	return response;
}
