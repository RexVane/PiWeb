/**
 * 升权工具的名字与结果文案映射（纯函数，浏览器与服务端共用）。
 *
 * 单独成文件是因为：工具定义（`permission-request-tool.ts`）引了 pi SDK，
 * 前端组件不能跟着把它打进浏览器 bundle；这里只留常量与文本判断。
 */

export const REQUEST_PERMISSION_TOOL = "request_permission";

/** 结果文本 → 一句话结论；工具输出的三种开头由 permission-request-tool 生成 */
export type PermissionOutcome = "approved" | "denied" | "unanswered" | "unknown";

export function permissionOutcomeOf(text: string, details?: unknown): PermissionOutcome {
	const outcome = (details as { permissionOutcome?: unknown } | undefined)?.permissionOutcome;
	if (outcome === "approved" || outcome === "denied" || outcome === "unanswered") return outcome;
	const head = text.trimStart();
	if (head.startsWith("Approved for one command") || head.startsWith("Approved for one action")) return "approved";
	if (head.startsWith("The user declined")) return "denied";
	if (head.startsWith("The user did not answer")) return "unanswered";
	return "unknown";
}
