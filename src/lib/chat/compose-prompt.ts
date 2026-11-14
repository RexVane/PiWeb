/** SDK skill expansion separates the name from arguments at the first ASCII space. */
export function composePrompt(base: string, additions: string[]): string {
	const suffix = additions.filter(Boolean).join("\n\n");
	if (!suffix) return base;
	if (/^\/skill:[^\s]+$/.test(base)) return `${base} ${suffix}`;
	return [base, suffix].filter(Boolean).join("\n\n");
}
