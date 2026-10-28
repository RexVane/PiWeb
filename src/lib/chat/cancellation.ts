/** SDK/provider cancellation strings are not model failures; keep timeout and upstream errors distinct. */
export function isAbortMessage(value: unknown): boolean {
	if (typeof value !== "string") return false;
	return /^(?:AbortError(?::\s*)?)?(?:(?:this|the) operation was aborted[.!]?|the user aborted a request[.!]?)$/i.test(value.trim()) || value.trim() === "AbortError";
}

export function isCancellationError(error: unknown): boolean {
	if (error && typeof error === "object" && "name" in error && error.name === "AbortError") return true;
	return isAbortMessage(error && typeof error === "object" && "message" in error ? error.message : error);
}

export function isCancelledTool(name: string, isError: boolean | undefined, result: string | undefined): boolean {
	if (!isError || !result) return false;
	return isAbortMessage(result) || (name.toLowerCase() === "bash" && /(?:^|\n)Command aborted\s*$/.test(result));
}
