import { NextResponse } from "next/server";
import { checkForUpdate, runUpdate, UpdateBusyError, type UpdateTarget } from "@/lib/update-service";
import { ensureStartupCheck, markUpdated, recordCheck } from "@/lib/update/startup-check";
import { activeStatus } from "@/lib/agent-manager";
import { apiError } from "@/lib/api-error";
import { runShutdownHooks } from "@/lib/graceful-shutdown";

/** 与 scripts/launcher.mjs 中的 RESTART_EXIT_CODE 保持一致，避免 Next 路由打包启动器代码 */
const RESTART_EXIT_CODE = 75;

export const dynamic = "force-dynamic";

function json(body: unknown, init: ResponseInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("Cache-Control", "no-store");
	return NextResponse.json(body, { ...init, headers });
}

/**
 * 启动时那次检查的结果（还在查就等它查完）：设置页和右下角提示条据此直接显示「可更新到 vX」。
 * 关掉启动检查时 startId 为 null、没有结果，页面退回手动「检查更新」。
 */
export async function GET() {
	try {
		const updates = await ensureStartupCheck();
		return json({ success: true, data: updates ?? { startId: null, results: {} } });
	} catch (error) {
		return json({ success: false, ...apiError(error, "更新状态暂时无法读取，请稍后重试。") }, { status: 500 });
	}
}

/** Fixed targets/actions only. Runtime authorization and origin checks live in proxy. */
export async function POST(req: Request) {
	let body: unknown;
	try { body = await req.json(); }
	catch { return json({ success: false, error: "invalid JSON body" }, { status: 400 }); }
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return json({ success: false, error: "expected an object body" }, { status: 400 });
	}
	const { target, action } = body as { target?: UpdateTarget; action?: string };
	if (target !== "piweb" && target !== "pi") return json({ success: false, error: "unknown target" }, { status: 400 });
	if (action !== "check" && action !== "update") return json({ success: false, error: "unknown action" }, { status: 400 });
	try {
		if (action === "check") {
			const check = await checkForUpdate(target);
			recordCheck(target, check);
			return json({ success: true, data: check });
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
		const restarting = target === "piweb" && Boolean(result.needsRestart) && process.env.PIWEB_RESTART_SUPPORTED === "1" && !process.env.VITEST;
		if (restarting) {
			const timer = setTimeout(() => {
				void runShutdownHooks("update-restart").finally(() => {
					process.exit(RESTART_EXIT_CODE);
				});
			}, 250);
			timer.unref?.();
		}
		return json({ success: true, data: { ...result, ...(restarting ? { restarting: true } : {}) } });
	} catch (error) {
		const busy = error instanceof UpdateBusyError;
		return json({ success: false, ...apiError(error, busy ? "更新暂时无法开始，请等待现有更新或会话结束后重试。" : "更新失败，请检查网络和安装状态后重试。"), ...(busy ? { errorCode: "UPDATE_BUSY" } : {}) }, {
			status: busy ? 409 : 500,
		});
	}
}
