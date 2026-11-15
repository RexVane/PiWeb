import { NextResponse } from "next/server";
import { applySettingsToSessions } from "@/lib/agent-manager";
import { getPiSettings, patchPiSettings, PiSettingsValidationError, PiSettingsRefreshError, redactPiSettingsForRead, type PiSettingsPatch } from "@/lib/pi-settings";
import { SettingsWriteBusyError } from "@/lib/settings-write-lock";
import { apiError } from "@/lib/api-error";
import { BoundaryError } from "@/lib/path-security";
import { applyRuntimeProxy } from "@/lib/runtime-proxy";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
	try {
		const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
		// 回显脱敏：httpProxy 里的 userinfo 密码打码；写回时仍用请求里的原值。
		return NextResponse.json({ success: true, data: redactPiSettingsForRead(await getPiSettings(cwd)) }, { headers });
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
		// 并发写锁冲突：可重试，不是内部错误。回 409 + Retry-After，客户端退避后重试。
		if (error instanceof SettingsWriteBusyError) {
			return NextResponse.json(
				{ success: false, error: error.message, errorCode: "SETTINGS_BUSY", retryAfterSeconds: error.retryAfterSeconds },
				{ status: 409, headers: { ...headers, "Retry-After": String(error.retryAfterSeconds) } },
			);
		}
		if (error instanceof PiSettingsRefreshError) { patch = error.patch; warning = error.message; }
		else return NextResponse.json({ success: false, ...apiError(error, "设置保存失败，请重试。", error instanceof PiSettingsValidationError) }, { status: error instanceof BoundaryError || error instanceof PiSettingsValidationError || error instanceof SyntaxError ? 400 : 500, headers });
	}
	try { applySettingsToSessions(patch, cwd); }
	catch { warning = "设置已保存，但部分活动会话未能刷新。"; }
	let restartRequired = false;
	if (typeof patch.httpProxy === "string") {
		try {
			const runtime = applyRuntimeProxy(patch.httpProxy);
			if (runtime.proxy && !runtime.activeInProcess) {
				restartRequired = true;
				const proxyNote = runtime.supported
					? "新网络代理未能在线生效，重启 PiWeb 后生效。"
					: "当前 Node 版本不支持内置代理，重启或升级 Node 后生效。";
				warning = warning ? `${warning}；${proxyNote}` : `设置已保存，但${proxyNote}`;
			}
		} catch {
			restartRequired = true;
			warning = warning
				? `${warning}；新网络代理未能在线生效，重启 PiWeb 后生效。`
				: "设置已保存，但新网络代理未能在线生效，重启 PiWeb 后生效。";
		}
	}
	const result = { success: true, applied: true, restartRequired };
	try {
		return NextResponse.json({ ...result, data: redactPiSettingsForRead(await getPiSettings(cwd)), ...(warning ? { warning } : {}) }, { headers });
	} catch (error) {
		// The write already completed. Keep that fact separate from a later read
		// failure so clients retain their editor state and can retry loading.
		return NextResponse.json({ ...result, warning: "设置已保存，但无法重新读取最新配置。请刷新设置。", readError: apiError(error, "设置读取失败。", error instanceof PiSettingsValidationError).error }, { headers });
	}
}
