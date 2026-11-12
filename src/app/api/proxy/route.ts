import { NextResponse } from "next/server";
import { automaticProxy, publicProxy, testProxyConnection } from "@/lib/proxy-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
	return NextResponse.json({ success: true, data: publicProxy(automaticProxy()) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
	let body: unknown;
	try { body = await req.json(); } catch {
		return NextResponse.json({ success: false, error: "invalid" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body) || !("proxy" in body) || typeof body.proxy !== "string" || body.proxy.length > 2048 || Object.keys(body).some((key) => key !== "proxy")) {
		return NextResponse.json({ success: false, error: "invalid" }, { status: 400 });
	}
	const automatic = automaticProxy();
	const test = await testProxyConnection(body.proxy, { automatic });
	return NextResponse.json({ success: true, data: { automatic: publicProxy(automatic), test } }, { headers: { "Cache-Control": "no-store" } });
}
