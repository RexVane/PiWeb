/** 光标处的斜杠命令：在开头或空白之后才算，路径和 URL 不算。
 * 采纳时替换整段 token（光标停在中间也一样），前后的正文原样保留。
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
