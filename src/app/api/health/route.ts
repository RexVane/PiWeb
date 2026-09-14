import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
	return NextResponse.json({ success: true, data: { ok: true, service: "piweb" } }, { headers: { "Cache-Control": "no-store" } });
}
