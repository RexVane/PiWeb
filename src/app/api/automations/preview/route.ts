import { NextResponse } from "next/server";
import { computeNextRunAt, validateSchedule } from "@/lib/automations/schedule";
import type { AutomationSchedulePreview } from "@/lib/automations/types";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Preview uses the scheduler's clock and time zone without creating a task or starting it. */
export async function POST(req: Request) {
	let validating = true;
	try {
		const raw: unknown = await req.json();
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a schedule request object");
		const schedule = validateSchedule((raw as Record<string, unknown>).schedule);
		validating = false;
		const computedAt = Date.now();
		const data: AutomationSchedulePreview = {
			nextRunAt: computeNextRunAt(schedule, computedAt),
			timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
			computedAt,
		};
		return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
	} catch (error: unknown) {
		return NextResponse.json({ success: false, ...apiError(error, "无法计算执行时间，请检查计划内容后重试。", validating) }, { status: validating ? 400 : 500 });
	}
}
