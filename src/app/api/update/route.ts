import { NextResponse } from "next/server";
import { checkForUpdate, runUpdate, UpdateBusyError, type UpdateTarget } from "@/lib/update-service";
import { ensureStartupCheck, markUpdated, recordCheck } from "@/lib/update/startup-check";
import { activeStatus } from "@/lib/agent-manager";

export const dynamic = "force-dynamic";

/**
 * 启动时那次检查的结果（还在查就等它查完）：设置页和右下角提示条据此直接显示「可更新到 vX」。
 * 关掉启动检查时 startId 为 null、没有结果，页面退回手动「检查更新」。
 */
export async function GET() {
	const updates = await ensureStartupCheck();
	return NextResponse.json({ success: true, data: updates ?? { startId: null, results: {} } }, { headers: { "Cache-Control": "no-store" } });
}

/** Fixed targets/actions only. Runtime authorization and origin checks live in proxy. */
export async function POST(req: Request) {
	let body: unknown;
	try { body = await req.json(); }
	catch { return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400 }); }
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return NextResponse.json({ success: false, error: "expected an object body" }, { status: 400 });
	}
	const { target, action } = body as { target?: UpdateTarget; action?: string };
	if (target !== "piweb" && target !== "pi") return NextResponse.json({ success: false, error: "unknown target" }, { status: 400 });
	if (action !== "check" && action !== "update") return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
	try {
		if (action === "check") {
			const check = await checkForUpdate(target);
			recordCheck(target, check);
			return NextResponse.json({ success: true, data: check });
		}
		const assertIdle = async () => {
			if (Object.values(activeStatus()).some((session) => session.streaming)) {
				throw new UpdateBusyError("An agent session is running. Wait for it to finish and update in a maintenance window; do not start new sessions until the release is ready.");
			}
		};
		// Check before even taking a release lock; rechecked before each mutating step.
		await assertIdle();
		const result = await runUpdate(target, { assertIdle });
		markUpdated(target, result.version);
		return NextResponse.json({ success: true, data: result });
	} catch (error) {
		return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, {
			status: error instanceof UpdateBusyError ? 409 : 500,
		});
	}
}
