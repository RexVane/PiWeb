import { NextResponse } from "next/server";
import { readSystemProxy } from "../../../../scripts/system-proxy.mjs";
import { automaticProxy, detectedProxies, publicProxy, testProxyConnection } from "@/lib/proxy-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function automaticPayload() {
	const system = readSystemProxy();
	const automatic = automaticProxy(process.env, system);
	const detected = detectedProxies(process.env, system);
	return { automatic, payload: { ...publicProxy(automatic), detected } };
}

export async function GET() {
	const { payload } = automaticPayload();
	return NextResponse.json({ success: true, data: payload }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
	let body: unknown;
	try { body = await req.json(); } catch {
		return NextResponse.json({ success: false, error: "invalid" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body) || !("proxy" in body) || typeof body.proxy !== "string" || body.proxy.length > 2048 || Object.keys(body).some((key) => key !== "proxy")) {
		return NextResponse.json({ success: false, error: "invalid" }, { status: 400 });
	}
	const { automatic, payload } = automaticPayload();
	const test = await testProxyConnection(body.proxy, { automatic });
	return NextResponse.json({ success: true, data: { automatic: payload, test } }, { headers: { "Cache-Control": "no-store" } });
}
