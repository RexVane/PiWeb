/**
 * Pure diff utilities shared by inline DiffView and full-file FullDiff:
 * - Token-level word diff pairing deleted/added lines inside change blocks
 * - HTML-safe overlay of word diff highlights onto highlight.js markup
 * - Change-block extraction for hunk ribbons, navigation, and surgical staging
 */

export interface DiffSegment {
	text: string;
	changed: boolean;
}

export interface DiffLineShape {
	kind: "add" | "del" | "ctx" | "hunk" | "file";
	old?: number;
	new?: number;
	text: string;
}

export interface DiffChangeBlock {
	/** 0-based index within the file diff */
	index: number;
	/** First line index in DiffLineShape[] */
	lineStart: number;
	/** Exclusive end index in DiffLineShape[] */
	lineEnd: number;
	delCount: number;
	addCount: number;
	/** 1-based start line on the old side (or anchor line after which insertion occurs) */
	oldAnchor: number;
	/** 1-based start line on the new side (or anchor line after which deletion occurs) */
	newAnchor: number;
	/** Kind summary for ticks/ribbons */
	kind: "add" | "del" | "mod";
}

const MAX_WORD_DIFF_LINE_LEN = 1500;
const MAX_LCS_CELLS = 12_000;
const MAX_LINE_PAIR_CELLS = 256;

const TOKEN_RE = /[A-Za-z0-9_]+|[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]|\s+|[^\sA-Za-z0-9_\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g;

function tokenize(text: string): string[] {
	return text.match(TOKEN_RE) ?? [];
}

function coalesce(tokens: readonly string[], changedFlags: readonly boolean[]): DiffSegment[] {
	const out: DiffSegment[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const text = tokens[i];
		if (!text) continue;
		const changed = Boolean(changedFlags[i]);
		const prev = out[out.length - 1];
		if (prev && prev.changed === changed) prev.text += text;
		else out.push({ text, changed });
	}
	return out;
}

function nonSpaceChars(segments: readonly DiffSegment[], onlyChanged: boolean): number {
	let n = 0;
	for (const seg of segments) {
		if (seg.changed !== onlyChanged) continue;
		for (let i = 0; i < seg.text.length; i += 1) {
			if (!/\s/.test(seg.text[i])) n += 1;
		}
	}
	return n;
}

/**
 * Compute word/token diff segments for a paired (oldLine, newLine).
 * Returns null if the lines are nearly disjoint or too large, preventing noisy highlights.
 */
export function diffLinePair(oldText: string, newText: string): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } | null {
	if (!oldText || !newText || oldText === newText) return null;
	if (oldText.length > MAX_WORD_DIFF_LINE_LEN || newText.length > MAX_WORD_DIFF_LINE_LEN) return null;

	const a = tokenize(oldText);
	const b = tokenize(newText);
	if (!a.length || !b.length) return null;

	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix += 1;
	}

	const oldChanged = new Array<boolean>(a.length).fill(true);
	const newChanged = new Array<boolean>(b.length).fill(true);
	for (let i = 0; i < prefix; i += 1) {
		oldChanged[i] = false;
		newChanged[i] = false;
	}
	for (let i = 0; i < suffix; i += 1) {
		oldChanged[a.length - 1 - i] = false;
		newChanged[b.length - 1 - i] = false;
	}

	const aMidStart = prefix;
	const aMidEnd = a.length - suffix;
	const bMidStart = prefix;
	const bMidEnd = b.length - suffix;
	const m = aMidEnd - aMidStart;
	const n = bMidEnd - bMidStart;

	if (m > 0 && n > 0 && m * n <= MAX_LCS_CELLS) {
		const width = n + 1;
		const dp = new Uint16Array((m + 1) * width);
		for (let i = m - 1; i >= 0; i -= 1) {
			const row = i * width;
			const nextRow = (i + 1) * width;
			const tokA = a[aMidStart + i];
			for (let j = n - 1; j >= 0; j -= 1) {
				if (tokA === b[bMidStart + j]) dp[row + j] = dp[nextRow + j + 1] + 1;
				else dp[row + j] = dp[nextRow + j] >= dp[row + j + 1] ? dp[nextRow + j] : dp[row + j + 1];
			}
		}
		let i = 0;
		let j = 0;
		while (i < m && j < n) {
			if (a[aMidStart + i] === b[bMidStart + j]) {
				oldChanged[aMidStart + i] = false;
				newChanged[bMidStart + j] = false;
				i += 1;
				j += 1;
			} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
				i += 1;
			} else {
				j += 1;
			}
		}
	}

	const oldSegments = coalesce(a, oldChanged);
	const newSegments = coalesce(b, newChanged);

	// Skip confetti highlights on completely rewritten lines
	const unchangedOld = nonSpaceChars(oldSegments, false);
	const unchangedNew = nonSpaceChars(newSegments, false);
	const totalMin = Math.min(nonSpaceChars(oldSegments, true) + unchangedOld, nonSpaceChars(newSegments, true) + unchangedNew);
	if (totalMin > 10 && Math.min(unchangedOld, unchangedNew) / totalMin < 0.22) return null;

	return { oldSegments, newSegments };
}

function tokenOverlapScore(a: string, b: string): number {
	if (!a || !b || a.length > MAX_WORD_DIFF_LINE_LEN || b.length > MAX_WORD_DIFF_LINE_LEN) return 0;
	const ta = tokenize(a).filter((t) => /\S/.test(t));
	const tb = tokenize(b).filter((t) => /\S/.test(t));
	if (!ta.length || !tb.length) return 0;
	const counts = new Map<string, number>();
	for (const tok of ta) counts.set(tok, (counts.get(tok) ?? 0) + 1);
	let shared = 0;
	for (const tok of tb) {
		const left = counts.get(tok) ?? 0;
		if (left > 0) {
			shared += 1;
			counts.set(tok, left - 1);
		}
	}
	return (2 * shared) / (ta.length + tb.length);
}

/** Pair deleted lines and added lines in order using token similarity DP. */
function pairRunIndices(dels: readonly string[], adds: readonly string[]): Array<[number, number]> {
	const m = dels.length;
	const n = adds.length;
	if (!m || !n) return [];
	if (m === 1 && n === 1) return [[0, 0]];
	if (m === n && m <= 24) {
		// Common fast path: if positional lines look paired, align 1-to-1
		const direct: Array<[number, number]> = [];
		let good = 0;
		for (let i = 0; i < m; i += 1) {
			if (tokenOverlapScore(dels[i], adds[i]) >= 0.22) {
				good += 1;
				direct.push([i, i]);
			}
		}
		if (good >= Math.ceil(m * 0.5)) return direct;
	}
	if (m * n > MAX_LINE_PAIR_CELLS) {
		const count = Math.min(m, n, 24);
		const pairs: Array<[number, number]> = [];
		for (let i = 0; i < count; i += 1) pairs.push([i, i]);
		return pairs;
	}

	const width = n + 1;
	const scores = new Float64Array((m + 1) * width);
	const sim = new Float64Array(m * n);
	for (let i = 0; i < m; i += 1) {
		for (let j = 0; j < n; j += 1) {
			const s = tokenOverlapScore(dels[i], adds[j]);
			sim[i * n + j] = s >= 0.22 ? s : 0;
		}
	}
	for (let i = m - 1; i >= 0; i -= 1) {
		for (let j = n - 1; j >= 0; j -= 1) {
			const diag = sim[i * n + j] > 0 ? sim[i * n + j] + scores[(i + 1) * width + j + 1] : -1;
			const skipA = scores[(i + 1) * width + j];
			const skipB = scores[i * width + j + 1];
			scores[i * width + j] = Math.max(diag, skipA, skipB);
		}
	}
	const pairs: Array<[number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		const s = sim[i * n + j];
		if (s > 0 && scores[i * width + j] === s + scores[(i + 1) * width + j + 1]) {
			pairs.push([i, j]);
			i += 1;
			j += 1;
		} else if (scores[(i + 1) * width + j] >= scores[i * width + j + 1]) {
			i += 1;
		} else {
			j += 1;
		}
	}
	return pairs;
}

/**
 * Compute per-line word diff segments keyed by index into `lines`.
 */
export function computeWordDiffLines(lines: readonly DiffLineShape[]): Map<number, DiffSegment[]> {
	const result = new Map<number, DiffSegment[]>();
	let i = 0;
	while (i < lines.length) {
		if (lines[i].kind !== "del") {
			i += 1;
			continue;
		}
		const delStart = i;
		while (i < lines.length && lines[i].kind === "del") i += 1;
		const delEnd = i;
		const addStart = i;
		while (i < lines.length && lines[i].kind === "add") i += 1;
		const addEnd = i;
		if (addStart === addEnd) continue;

		const delTexts = lines.slice(delStart, delEnd).map((l) => l.text);
		const addTexts = lines.slice(addStart, addEnd).map((l) => l.text);
		for (const [dIdx, aIdx] of pairRunIndices(delTexts, addTexts)) {
			const pair = diffLinePair(delTexts[dIdx], addTexts[aIdx]);
			if (!pair) continue;
			result.set(delStart + dIdx, pair.oldSegments);
			result.set(addStart + aIdx, pair.newSegments);
		}
	}
	return result;
}

/**
 * Overlay `<mark class="pw-diff-word" data-kind="...">` highlights cleanly onto highlight.js HTML
 * without splitting HTML tags or altering syntax span nesting.
 */
export function annotateHighlightedHtml(
	html: string,
	segments: readonly DiffSegment[],
	kind: "add" | "del",
): string {
	if (!segments.some((seg) => seg.changed)) return html;

	// Build a character-level lookup boolean array from segments
	let totalLen = 0;
	for (const seg of segments) totalLen += seg.text.length;
	const changedAt = new Uint8Array(totalLen);
	let offset = 0;
	for (const seg of segments) {
		if (seg.changed) changedAt.fill(1, offset, offset + seg.text.length);
		offset += seg.text.length;
	}

	let out = "";
	let pos = 0;
	let inMark = false;
	let cursor = 0;

	const closeMark = () => {
		if (inMark) {
			out += "</mark>";
			inMark = false;
		}
	};
	const setMark = (want: boolean) => {
		if (want === inMark) return;
		if (want) out += `<mark class="pw-diff-word" data-kind="${kind}">`;
		else out += "</mark>";
		inMark = want;
	};

	while (pos < html.length) {
		const ch = html[pos];
		if (ch === "<") {
			const end = html.indexOf(">", pos);
			if (end < 0) return html;
			// Never leave <mark> dangling across an open/close tag
			closeMark();
			out += html.slice(pos, end + 1);
			pos = end + 1;
			continue;
		}
		let raw = ch;
		let advance = 1;
		if (ch === "&") {
			const semi = html.indexOf(";", pos);
			if (semi > pos && semi - pos <= 12) {
				raw = html.slice(pos, semi + 1);
				advance = semi - pos + 1;
			}
		}
		if (cursor >= totalLen) return html;
		setMark(changedAt[cursor] === 1);
		out += raw;
		pos += advance;
		cursor += 1;
	}

	closeMark();
	return cursor === totalLen ? out : html;
}

/** Extract contiguous change blocks (`del` / `add` runs) from parsed diff lines. */
export function extractDiffBlocks(lines: readonly DiffLineShape[]): DiffChangeBlock[] {
	const blocks: DiffChangeBlock[] = [];
	let i = 0;
	let lastOld = 0;
	let lastNew = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.kind === "ctx") {
			if (line.old !== undefined) lastOld = line.old;
			if (line.new !== undefined) lastNew = line.new;
			i += 1;
			continue;
		}
		if (line.kind === "hunk" || line.kind === "file") {
			i += 1;
			continue;
		}
		const lineStart = i;
		let delCount = 0;
		let addCount = 0;
		let firstOld: number | undefined;
		let firstNew: number | undefined;
		while (i < lines.length && (lines[i].kind === "del" || lines[i].kind === "add")) {
			const cur = lines[i];
			if (cur.kind === "del") {
				delCount += 1;
				if (firstOld === undefined && cur.old !== undefined) firstOld = cur.old;
				if (cur.old !== undefined) lastOld = cur.old;
			} else {
				addCount += 1;
				if (firstNew === undefined && cur.new !== undefined) firstNew = cur.new;
				if (cur.new !== undefined) lastNew = cur.new;
			}
			i += 1;
		}
		blocks.push({
			index: blocks.length,
			lineStart,
			lineEnd: i,
			delCount,
			addCount,
			oldAnchor: firstOld ?? lastOld,
			newAnchor: firstNew ?? lastNew,
			kind: delCount > 0 && addCount > 0 ? "mod" : delCount > 0 ? "del" : "add",
		});
	}
	return blocks;
}
