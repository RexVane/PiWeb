import { NextResponse } from "next/server";
import { applySettingsToSessions } from "@/lib/agent-manager";
import { getPiSettings, patchPiSettings, PiSettingsValidationError, PiSettingsRefreshError, type PiSettingsPatch } from "@/lib/pi-settings";
import { apiError } from "@/lib/api-error";
import { BoundaryError } from "@/lib/path-security";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
	try {
		const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
		return NextResponse.json({ success: true, data: await getPiSettings(cwd) }, { headers });
	} catch (error) {
		return NextResponse.json({ success: false, ...apiError(error, "设置读取失败，请重试。", error instanceof PiSettingsValidationError) }, { status: error instanceof BoundaryError ? 400 : 500, headers });
	}
}

export async function PUT(req: Request) {
	const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
	let patch: PiSettingsPatch;
	let warning: string | undefined;
	try {
		patch = await patchPiSettings(await req.json(), cwd);
	} catch (error) {
		if (error instanceof PiSettingsRefreshError) { patch = error.patch; warning = error.message; }
		else return NextResponse.json({ success: false, ...apiError(error, "设置保存失败，请重试。", error instanceof PiSettingsValidationError) }, { status: error instanceof BoundaryError || error instanceof PiSettingsValidationError || error instanceof SyntaxError ? 400 : 500, headers });
	}
	try { applySettingsToSessions(patch, cwd); }
	catch { warning = "设置已保存，但部分活动会话未能刷新。"; }
	const result = { success: true, applied: true, restartRequired: Object.hasOwn(patch, "httpProxy") };
	try {
		return NextResponse.json({ ...result, data: await getPiSettings(cwd), ...(warning ? { warning } : {}) }, { headers });
	} catch (error) {
		// The write already completed. Keep that fact separate from a later read
		// failure so clients retain their editor state and can retry loading.
		return NextResponse.json({ ...result, warning: "设置已保存，但无法重新读取最新配置。请刷新设置。", readError: apiError(error, "设置读取失败。", error instanceof PiSettingsValidationError).error }, { headers });
	}
}
