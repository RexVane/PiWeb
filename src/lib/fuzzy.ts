/**
 * 模糊匹配：@ 引用候选的排序规则，**照搬 pi harness 的实现**（`pi-tui/dist/fuzzy.js`）。
 *
 * 为什么照搬而不是自己写一套：用户在终端里已经习惯 pi 的匹配手感（哪个候选排前面），
 * Web 端换一套排序会让人觉得「同一个 @ 在两个地方挑出不同的文件」。
 * 移植时保留全部评分项：连续命中加成、词边界加成、跳跃惩罚、位置越靠后越扣分、
 * 完全相等额外加成，以及「字母数字互换」兜底（`py3` 也能命中 `3py`）。
 *
 * 分数越低越好。
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const matchQuery = (normalizedQuery: string): FuzzyMatch => {
		if (normalizedQuery.length === 0) return { matches: true, score: 0 };
		if (normalizedQuery.length > textLower.length) return { matches: false, score: 0 };

		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;

		while (queryIndex < normalizedQuery.length) {
			const i = textLower.indexOf(normalizedQuery[queryIndex], lastMatchIndex + 1);
			if (i === -1) break;

			const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);
			if (lastMatchIndex === i - 1) {
				// 连续命中：越连贯越靠前
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				// 跳跃要罚，跳得越远罚得越多
				if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
			}
			// 命中词首（`/`、`-`、`_` 之后）优先
			if (isWordBoundary) score -= 10;
			// 越靠后的位置越轻微扣分，避免长路径永远压过短路径
			score += i * 0.1;
			lastMatchIndex = i;
			queryIndex++;
		}

		if (queryIndex < normalizedQuery.length) return { matches: false, score: 0 };
		if (normalizedQuery === textLower) score -= 100;
		return { matches: true, score };
	};

	const primaryMatch = matchQuery(queryLower);
	if (primaryMatch.matches) return primaryMatch;

	// `py3` ↔ `3py`：文件名里数字和字母的顺序常被记反
	const alphaNumericMatch = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/.exec(queryLower);
	const numericAlphaMatch = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/.exec(queryLower);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";
	if (!swappedQuery) return primaryMatch;

	const swappedMatch = matchQuery(swappedQuery);
	if (!swappedMatch.matches) return primaryMatch;
	return { matches: true, score: swappedMatch.score + 5 };
}

/** query 按空白与 `/` 切词，**每个词都要命中**；分裂成多个词时分数相加，升序返回 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) return items;
	const tokens = query.trim().split(/[\s/]+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return items;

	const results: Array<{ item: T; score: number }> = [];
	for (const item of items) {
		const text = getText(item);
		let total = 0;
		let allMatch = true;
		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (!match.matches) {
				allMatch = false;
				break;
			}
			total += match.score;
		}
		if (allMatch) results.push({ item, score: total });
	}
	// 同分保持输入顺序（与 pi 一致，避免同等匹配时反复跳动）
	results.sort((a, b) => a.score - b.score);
	return results.map((entry) => entry.item);
}
