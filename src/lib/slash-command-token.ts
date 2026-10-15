/** A slash command at the caret, at the start of input or after whitespace.
 * Paths and URLs are not command tokens. The full token range is replaced on adoption,
 * even when the caret is in its middle; all surrounding prose is preserved.
 */
export function slashCommandToken(text: string, caret: number | null): { start: number; tokenEnd: number; query: string } | null {
	if (caret === null || caret < 0 || caret > text.length) return null;
	const match = /(?:^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret));
	if (!match) return null;
	const query = match[1];
	const start = caret - query.length - 1;
	let tokenEnd = caret;
	while (tokenEnd < text.length && !/\s/.test(text[tokenEnd])) tokenEnd += 1;
	if (text.slice(start + 1, tokenEnd).includes("/")) return null;
	return { start, tokenEnd, query };
}
