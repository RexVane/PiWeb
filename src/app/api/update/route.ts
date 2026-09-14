import { NextResponse } from "next/server";
import { checkForUpdate, runUpdate, UpdateBusyError, type UpdateTarget } from "@/lib/update-service";
import { activeStatus } from "@/lib/agent-manager";

export const dynamic = "force-dynamic";

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
		if (action === "check") return NextResponse.json({ success: true, data: await checkForUpdate(target) });
		const assertIdle = async () => {
			if (Object.values(activeStatus()).some((session) => session.streaming)) {
				throw new UpdateBusyError("An agent session is running. Wait for it to finish and update in a maintenance window; do not start new sessions until the release is ready.");
			}
		};
		// Check before even taking a release lock; rechecked before each mutating step.
		await assertIdle();
		return NextResponse.json({ success: true, data: await runUpdate(target, { assertIdle }) });
	} catch (error) {
		return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, {
			status: error instanceof UpdateBusyError ? 409 : 500,
		});
	}
}
