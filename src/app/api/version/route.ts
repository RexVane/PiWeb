import { NextResponse } from "next/server";
import { getRuntimeVersions } from "@/lib/system/version";

export const dynamic = "force-dynamic";

export async function GET() {
	return NextResponse.json({ success: true, data: { ...await getRuntimeVersions(), node: process.version } }, { headers: { "Cache-Control": "no-store" } });
}
