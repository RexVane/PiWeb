/**
 * Surgical hunk parser & single-hunk unified patch builder for git apply --cached.
 * Preserves exact bytes (including CRLF inside file lines and "\ No newline at end of file")
 * so hunk staging/unstaging succeeds reliably on Windows and mixed-EOL repos.
 */

const CONTEXT_LINES = 3;

export interface RawHunkAnchor {
	oldAnchor: number;
	newAnchor: number;
	delCount: number;
	addCount: number;
}

interface RawEntry {
	kind: "ctx" | "del" | "add" | "hunk";
	old?: number;
	new?: number;
	raw: string;
	noNewline?: boolean;
}

export interface ParsedPatchBlocks {
	headerLines: string[];
	entries: RawEntry[];
	blocks: Array<{
		index: number;
		start: number;
		end: number;
		anchor: RawHunkAnchor;
	}>;
}

function stripTrailingCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Parse a single-file unified patch into header lines, raw body entries, and contiguous change blocks.
 */
export function parseRawPatchBlocks(rawPatch: string): ParsedPatchBlocks {
	const rawLines = rawPatch.split("\n");
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

	const headerLines: string[] = [];
	const entries: RawEntry[] = [];
	let seenHunk = false;
	let inHunk = false;
	let oldLine = 0;
	let newLine = 0;
	let oldLeft = 0;
	let newLeft = 0;

	for (let i = 0; i < rawLines.length; i += 1) {
		const raw = rawLines[i];
		const line = stripTrailingCr(raw);
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
		if (hunk) {
			if (seenHunk && entries.length > 0 && entries[entries.length - 1].kind !== "hunk") {
				entries.push({ kind: "hunk", raw: "" });
			}
			seenHunk = true;
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[3]);
			oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
			inHunk = oldLeft > 0 || newLeft > 0;
			continue;
		}
		if (!seenHunk) {
			// Skip old/new mode lines when building partial hunk patches; keep ---/+++ and file mode headers
			if (/^(?:diff --git |--- |\+\+\+ |new file mode |deleted file mode )/.test(line)) {
				headerLines.push(line);
			}
			continue;
		}
		if (inHunk) {
			if (line.startsWith("\\")) {
				if (entries.length > 0) entries[entries.length - 1].noNewline = true;
				continue;
			}
			if (raw.startsWith("-") && oldLeft > 0) {
				entries.push({ kind: "del", old: oldLine++, raw });
				oldLeft -= 1;
			} else if (raw.startsWith("+") && newLeft > 0) {
				entries.push({ kind: "add", new: newLine++, raw });
				newLeft -= 1;
			} else if (raw.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
				entries.push({ kind: "ctx", old: oldLine++, new: newLine++, raw });
				oldLeft -= 1;
				newLeft -= 1;
			} else {
				inHunk = false;
			}
			if (oldLeft === 0 && newLeft === 0) inHunk = false;
		}
	}

	const blocks: ParsedPatchBlocks["blocks"] = [];
	let i = 0;
	let lastOld = 0;
	let lastNew = 0;
	while (i < entries.length) {
		const cur = entries[i];
		if (cur.kind === "ctx") {
			if (cur.old !== undefined) lastOld = cur.old;
			if (cur.new !== undefined) lastNew = cur.new;
			i += 1;
			continue;
		}
		if (cur.kind === "hunk") {
			i += 1;
			continue;
		}
		const start = i;
		let delCount = 0;
		let addCount = 0;
		let firstOld: number | undefined;
		let firstNew: number | undefined;
		while (i < entries.length && (entries[i].kind === "del" || entries[i].kind === "add")) {
			const e = entries[i];
			if (e.kind === "del") {
				delCount += 1;
				if (firstOld === undefined && e.old !== undefined) firstOld = e.old;
				if (e.old !== undefined) lastOld = e.old;
			} else {
				addCount += 1;
				if (firstNew === undefined && e.new !== undefined) firstNew = e.new;
				if (e.new !== undefined) lastNew = e.new;
			}
			i += 1;
		}
		blocks.push({
			index: blocks.length,
			start,
			end: i,
			anchor: {
				oldAnchor: firstOld ?? lastOld,
				newAnchor: firstNew ?? lastNew,
				delCount,
				addCount,
			},
		});
	}

	return { headerLines, entries, blocks };
}

/**
 * Build a minimal valid single-hunk unified patch containing ONLY `blocks[blockIndex]`.
 */
export function buildSingleHunkPatch(parsed: ParsedPatchBlocks, blockIndex: number): string {
	const block = parsed.blocks[blockIndex];
	if (!block) throw new Error(`Hunk block ${blockIndex} not found`);

	const ctxBefore: RawEntry[] = [];
	for (let k = block.start - 1; k >= 0 && ctxBefore.length < CONTEXT_LINES; k -= 1) {
		if (parsed.entries[k].kind !== "ctx") break;
		ctxBefore.unshift(parsed.entries[k]);
	}
	const ctxAfter: RawEntry[] = [];
	for (let k = block.end; k < parsed.entries.length && ctxAfter.length < CONTEXT_LINES; k += 1) {
		if (parsed.entries[k].kind !== "ctx") break;
		ctxAfter.push(parsed.entries[k]);
	}

	const selected = [...ctxBefore, ...parsed.entries.slice(block.start, block.end), ...ctxAfter];
	let oldCount = 0;
	let newCount = 0;
	let firstOld: number | undefined;
	let firstNew: number | undefined;
	for (const e of selected) {
		if (e.kind === "ctx" || e.kind === "del") {
			oldCount += 1;
			if (firstOld === undefined && e.old !== undefined) firstOld = e.old;
		}
		if (e.kind === "ctx" || e.kind === "add") {
			newCount += 1;
			if (firstNew === undefined && e.new !== undefined) firstNew = e.new;
		}
	}

	const oldStart = oldCount === 0 ? 0 : (firstOld ?? 1);
	const newStart = newCount === 0 ? 0 : (firstNew ?? 1);
	const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;

	const out: string[] = [...parsed.headerLines, header];
	for (const e of selected) {
		out.push(e.raw);
		if (e.noNewline) out.push("\\ No newline at end of file");
	}
	return `${out.join("\n")}\n`;
}
