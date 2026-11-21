import { NextResponse } from "next/server";
import { readResourceAsset, RESOURCE_CSP } from "@/lib/resources/assets";
import { authEnabled, requestAuthority, sessionCookieFromRequest, validSessionCookie } from "@/lib/web-auth";
import { loadWebSecret, loadSessionRevocations } from "@/lib/web-secret";
import { createResourceAssetTicket, resourceAssetTicketView } from "@/lib/resources/asset-ticket";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ token: string; asset: string[] }> }) {
	try {
		const { token, asset } = await context.params;
		let resourceToken = token;
		let ticket: string | undefined;
		if (authEnabled()) {
			const secret = loadWebSecret(); const revocations = loadSessionRevocations();
			ticket = resourceAssetTicketView(token, requestAuthority(request), secret, revocations);
			if (ticket) resourceToken = ticket;
			else if (!validSessionCookie(request, secret, Date.now(), revocations)) return NextResponse.json({ success: false, error: "Authentication required." }, { status: 401 });
		}
		const result = await readResourceAsset(resourceToken, asset.join("/"));
		if (authEnabled() && !ticket && result.mimeType.startsWith("text/html")) {
			const cookie = sessionCookieFromRequest(request, loadWebSecret());
			if (!cookie) return NextResponse.json({ success: false, error: "Authentication required." }, { status: 401 });
			const signed = createResourceAssetTicket(resourceToken, cookie, loadWebSecret());
			// 只回相对路径的 Location：Next 的 request.url 会把主机名报成 localhost，
			// 而票据绑定的是打开页面时的 authority（如 127.0.0.1:30143），
			// 绝对 URL 跨过去就会校验失败、退化成 401 / 登录页。
			const location = `/api/resources/views/${signed}/assets/${asset.map(encodeURIComponent).join("/")}`;
			return new NextResponse(null, { status: 307, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
		}
		return new NextResponse(new Uint8Array(result.data), { headers: {
			"Content-Type": result.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": RESOURCE_CSP, "Access-Control-Allow-Origin": "*", "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
		} });
	} catch { return NextResponse.json({ success: false, error: "Resource asset is unavailable." }, { status: 404, headers: { "Cache-Control": "no-store" } }); }
}
