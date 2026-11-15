/**
 * 就绪检查（M4）：`/api/health` 保持原样作为 liveness（不查依赖、不泄密）；
 * 这里额外检查「数据目录可写 / 模型配置可读 / 自动任务调度器在跑」，异常返回 503 + 可读原因。
 *
 * 认证：`src/proxy.ts` 只放行精确路径 `/api/health`，因此本路由默认受启动令牌/会话 Cookie
 * 保护，未认证请求在中间件层直接 401，不会到这里。
 */
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { agentDir } from "@/lib/web-secret";
import { readJsoncSettingsObjectSync } from "@/lib/jsonc-settings-storage";
import { getAutomationSchedulerStatus } from "@/lib/automations/runner";

export const dynamic = "force-dynamic";

interface CheckResult {
	ok: boolean;
	detail?: string;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 真实写一个探针文件：只读权限、满盘、目录被换成文件都能区分出来。 */
async function checkDataDirectoryWritable(directory: string): Promise<CheckResult> {
	const probe = path.join(directory, `.readiness-${process.pid}-${Date.now().toString(36)}.tmp`);
	try {
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(probe, "ok", { encoding: "utf8", flag: "wx", mode: 0o600 });
		await fs.unlink(probe);
		return { ok: true };
	} catch (error) {
		await fs.unlink(probe).catch(() => undefined);
		const code = (error as NodeJS.ErrnoException).code;
		return { ok: false, detail: `数据目录不可写${code ? ` (${code})` : ""}` };
	}
}

/** 设置/模型/凭据文件必须能解析；缺失不算异常（等于用默认配置），损坏才报。 */
function checkModelConfiguration(directory: string): CheckResult {
	try {
		readJsoncSettingsObjectSync(path.join(directory, "settings.json"));
	} catch {
		return { ok: false, detail: "settings.json 无法解析" };
	}
	for (const [name, detail] of [["models.json", "models.json 无法解析"], ["auth.json", "auth.json 无法解析"]] as const) {
		let text: string;
		try {
			text = readFileSync(path.join(directory, name), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return { ok: false, detail: `${name} 无法读取` };
		}
		try {
			const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, detail };
		} catch {
			return { ok: false, detail };
		}
	}
	return { ok: true };
}

export async function GET() {
	const directory = agentDir();
	const dataDir = await checkDataDirectoryWritable(directory);
	const modelConfig = checkModelConfiguration(directory);
	let scheduler: CheckResult & { running?: boolean; ticking?: boolean };
	try {
		const status = getAutomationSchedulerStatus();
		scheduler = {
			ok: status.running,
			running: status.running,
			ticking: status.ticking,
			...(status.running ? {} : { detail: "自动任务调度器未运行" }),
		};
	} catch {
		scheduler = { ok: false, detail: "自动任务调度器状态不可读" };
	}

	// 调度器停转只影响定时任务，不影响网页核心功能：作为 warning 报告，不把整个实例判为未就绪。
	const ready = dataDir.ok && modelConfig.ok;
	const warnings = scheduler.ok ? [] : [scheduler.detail ?? "自动任务调度器未运行"];
	const data = {
		ok: ready,
		service: "piweb",
		ready,
		checks: { dataDir, modelConfig, scheduler },
		...(warnings.length ? { warnings } : {}),
	};
	if (!ready) {
		const reason = [dataDir.ok ? "" : dataDir.detail ?? "数据目录不可写", modelConfig.ok ? "" : modelConfig.detail ?? "模型配置不可用"].filter(Boolean).join("；");
		return NextResponse.json({ success: false, error: `not ready: ${reason}`, data }, { status: 503, headers: NO_STORE });
	}
	return NextResponse.json({ success: true, data }, { headers: NO_STORE });
}
