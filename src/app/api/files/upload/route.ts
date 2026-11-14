import { NextResponse } from "next/server";
import { configuredTrustedHosts, isSafeHost, isSafeOrigin } from "@/lib/auth";
import { authEnabled, validSessionCookie } from "@/lib/web-auth";
import { loadSessionRevocations, loadWebSecret } from "@/lib/web-secret";
import { BoundaryError } from "@/lib/path-security";
import { parseUploadLength, saveUploadStream } from "@/lib/files-service";

export const runtime = "nodejs";

/** This streaming route is excluded from the proxy's body cloning; authenticate here. */
export async function POST(req: Request) {
	const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
	if (!isSafeHost(req, configuredTrustedHosts()) || !isSafeOrigin(req)) return reply({ success: false, error: "request origin rejected" }, 403);
	try {
		if (authEnabled()) {
			const revocations = loadSessionRevocations();
			// 与 proxy 同一口径：吊销记录读不了是服务端暂时不可用，不是「没登录」
			if (revocations.unavailable) return reply({ success: false, error: "session authentication is temporarily unavailable" }, 503);
			if (!validSessionCookie(req, loadWebSecret(), Date.now(), revocations)) return reply({ success: false, error: "authentication required" }, 401);
		}
		const declared = req.headers.get("x-upload-size");
		const contentLength = req.headers.get("content-length");
		const expectedSize = parseUploadLength(declared ?? contentLength);
		if (declared !== null && contentLength !== null && parseUploadLength(contentLength) !== expectedSize) throw new BoundaryError("conflicting upload sizes");
		const data = await saveUploadStream(new URL(req.url).searchParams.get("name"), req.body, expectedSize);
		return reply({ success: true, data });
	} catch (error) {
		return reply({ success: false, error: error instanceof BoundaryError ? error.message : "upload failed" }, error instanceof BoundaryError ? 400 : 500);
	}
}
