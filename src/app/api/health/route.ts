import { NextResponse } from "next/server";
import { getRuntimeVersions } from "@/lib/version";

export const dynamic = "force-dynamic";

export async function GET() {
	const versions = await getRuntimeVersions();
	return NextResponse.json({
		success: true,
		data: { ok: true, ...versions, node: process.version, ts: Date.now() },
	});
}
