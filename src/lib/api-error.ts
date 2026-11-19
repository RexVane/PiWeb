import { BoundaryError } from "./path-security";

function validationMessage(message: string): string {
	return message.replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/g, "[local path]")
		.replace(/\\\\[^\r\n"'<>]*/g, "[local path]")
		.replace(/(^|[\s'"])(\/[^\s"'<>]*)/g, "$1[local path]");
}

/**
 * Stable errorCode → client dictionary key names.
 *
 * The client localizes by `errorCode` first (`localizeApiError` in `src/i18n.tsx`)
 * and only falls back to the server message when a code has no mapping. The
 * mapping lives here as plain strings because this module is server-only
 * (`path-security` loads Node built-ins) and `src/i18n.tsx` is a client bundle;
 * keep both tables in sync — `tests/lib/api-error.test.ts` and
 * `tests/i18n.test.ts` assert every key exists in both dictionaries.
 */
export const API_ERROR_I18N_KEYS: Readonly<Record<string, string>> = {
	INVALID_JSON: "apiErrorInvalidJson",
	VALIDATION_ERROR: "apiErrorValidation",
	OUT_OF_WORKSPACE: "apiErrorOutOfWorkspace",
	NOT_FOUND: "apiErrorEnoent",
	NOT_A_FILE: "apiErrorNotAFile",
	FILE_NOT_FOUND: "apiErrorEnoent",
	IS_DIRECTORY: "apiErrorNotAFile",
	ENOENT: "apiErrorEnoent",
	EACCES: "apiErrorEacces",
	EPERM: "apiErrorEperm",
	ELOCKED: "apiErrorElocked",
	EBUSY: "apiErrorEbusy",
	ENOSPC: "apiErrorEnospc",
	ETIMEDOUT: "apiErrorEtimedout",
	REQUEST_FAILED: "apiErrorRequestFailed",
};

/** Dictionary key for an errorCode, or undefined when the client has no translation. */
export function apiErrorI18nKey(errorCode: string | undefined): string | undefined {
	return errorCode ? API_ERROR_I18N_KEYS[errorCode] : undefined;
}

/** Preserve validation and OS error categories without returning process commands or server paths. */
export function apiError(error: unknown, fallback = "请求失败，请重试。", validation = false): { error: string; errorCode: string } {
	if (error instanceof SyntaxError) return { error: "请求内容不是有效的 JSON。", errorCode: "INVALID_JSON" };
	if (validation || error instanceof BoundaryError) {
		// BoundaryError 自带的 code 优先（如 OUT_OF_WORKSPACE / NOT_FOUND），让客户端区分性质
		const specific = error instanceof BoundaryError && error.code && /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined;
		return { error: validationMessage(error instanceof Error ? error.message : fallback), errorCode: specific ?? "VALIDATION_ERROR" };
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
