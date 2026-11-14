import { apiError } from "./api-error";

/** Diagnostic fields may retain their reason, but never local paths or command output. */
export function publicDiagnostic(message: string, fallback: string): string {
	const code = /\b(ENOENT|EACCES|EPERM|ELOCKED|EBUSY|ENOSPC|ETIMEDOUT)\b/.exec(message)?.[1];
	if (code) return apiError(Object.assign(new Error(), { code }), fallback).error;
	if (/command failed|\bspawn\b|\bexec(?:file)?\b/i.test(message)) return fallback;
	return apiError(new Error(message), fallback, true).error.slice(0, 2048);
}
