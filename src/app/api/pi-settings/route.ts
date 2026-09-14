import { NextResponse } from "next/server";
import { getPiSettings, patchPiSettings, PiSettingsValidationError } from "@/lib/pi-settings";

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
		const body = await req.json();
		await patchPiSettings(body);
		return NextResponse.json({ success: true, data: await getPiSettings() });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: err instanceof PiSettingsValidationError || err instanceof SyntaxError ? 400 : 500 });
	}
}
