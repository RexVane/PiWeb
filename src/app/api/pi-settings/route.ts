import { NextResponse } from "next/server";
import { applySettingsToSessions } from "@/lib/agent-manager";
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
		const patch = await patchPiSettings(body);
		// 排队投递方式 / 缓存预热只在建会话时读一次：已经开着的会话当场跟上
		applySettingsToSessions(patch);
		return NextResponse.json({ success: true, data: await getPiSettings() });
	} catch (err: any) {
		return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: err instanceof PiSettingsValidationError || err instanceof SyntaxError ? 400 : 500 });
	}
}
