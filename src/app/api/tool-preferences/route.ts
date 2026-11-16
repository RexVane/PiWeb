import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { BoundaryError } from "@/lib/path-security";
import { SettingsWriteBusyError } from "@/lib/settings-write-lock";
import {
	readDefaultToolPreset,
	saveDefaultToolPreset,
	ToolPreferencesValidationError,
} from "@/lib/tool-preferences";
import { normalizeToolPreset } from "@/lib/tool-preset";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
	try {
		return NextResponse.json({ success: true, data: await readDefaultToolPreset() }, { headers });
	} catch (error) {
		return NextResponse.json(
			{ success: false, ...apiError(error, "默认权限读取失败，请重试。", error instanceof ToolPreferencesValidationError) },
			{ status: error instanceof ToolPreferencesValidationError ? 400 : 500, headers },
		);
	}
}

export async function PUT(req: Request) {
	try {
		const body = (await req.json()) as { toolPreset?: unknown };
		const preset = normalizeToolPreset(body?.toolPreset);
		if (!preset) throw new BoundaryError("请提供有效的权限预设。");
		await saveDefaultToolPreset(preset);
		return NextResponse.json({ success: true, data: { toolPreset: preset, saved: true } }, { headers });
	} catch (error) {
		if (error instanceof SettingsWriteBusyError) {
			return NextResponse.json(
				{ success: false, error: error.message, errorCode: "SETTINGS_BUSY", retryAfterSeconds: error.retryAfterSeconds },
				{ status: 409, headers: { ...headers, "Retry-After": String(error.retryAfterSeconds) } },
			);
		}
		const badInput =
			error instanceof BoundaryError || error instanceof ToolPreferencesValidationError || error instanceof SyntaxError;
		return NextResponse.json(
			{ success: false, ...apiError(error, "默认权限保存失败，请重试。", badInput) },
			{ status: badInput ? 400 : 500, headers },
		);
	}
}
