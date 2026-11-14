import { BoundaryError } from "./path-security";

function validationMessage(message: string): string {
	return message.replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/g, "[local path]")
		.replace(/\\\\[^\r\n"'<>]*/g, "[local path]")
		.replace(/(^|[\s'"])(\/[^\s"'<>]*)/g, "$1[local path]");
}

/** Preserve validation and OS error categories without returning process commands or server paths. */
export function apiError(error: unknown, fallback = "请求失败，请重试。", validation = false): { error: string; errorCode: string } {
	if (error instanceof SyntaxError) return { error: "请求内容不是有效的 JSON。", errorCode: "INVALID_JSON" };
	if (validation || error instanceof BoundaryError) {
		return { error: validationMessage(error instanceof Error ? error.message : fallback), errorCode: "VALIDATION_ERROR" };
	}
	const rawCode = (error as NodeJS.ErrnoException | undefined)?.code;
	// SDK storage adapters may wrap an OS failure without copying Error.code.
	const wrappedCode = error instanceof Error ? /\b(ENOENT|EACCES|EPERM|ELOCKED|EBUSY|ENOSPC|ETIMEDOUT)\b/.exec(error.message)?.[1] : undefined;
	const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(rawCode) ? rawCode : wrappedCode ?? "REQUEST_FAILED";
	const known: Record<string, string> = {
		ENOENT: "请求的资源不存在。", EACCES: "没有权限访问请求的资源。", EPERM: "没有权限完成这次操作。",
		ELOCKED: "资源正在被其他操作使用，请稍后重试。", EBUSY: "资源正在使用，请稍后重试。",
		ENOSPC: "磁盘空间不足，无法完成操作。", ETIMEDOUT: "操作超时，请重试。",
	};
	return { error: known[code] ?? fallback, errorCode: code };
}
