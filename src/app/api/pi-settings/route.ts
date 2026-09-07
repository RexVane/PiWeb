import { NextResponse } from "next/server";
import type { CompactionSettings, RetrySettings } from "@/lib/pi-settings";
import { getPiSettings, patchPiSettings } from "@/lib/pi-settings";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		return NextResponse.json({ success: true, data: await getPiSettings() });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}

export async function PUT(req: Request) {
	try {
		const body = (await req.json()) as { compaction?: Partial<CompactionSettings>; retry?: Partial<RetrySettings> };
		await patchPiSettings(body);
		return NextResponse.json({ success: true, data: await getPiSettings() });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
	}
}
