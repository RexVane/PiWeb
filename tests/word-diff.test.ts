import { describe, expect, it } from "vitest";
import { annotateHighlightedHtml, computeWordDiffLines, diffLinePair, extractDiffBlocks } from "../src/lib/word-diff";

describe("word diff engine", () => {
	it("highlights only changed identifier and CJK tokens without noise", () => {
		const code = diffLinePair("const oldValue = computeTotal(items);", "const newValue = computeTotal(items);");
		expect(code).not.toBeNull();
		expect(code!.oldSegments).toEqual([
			{ text: "const ", changed: false },
			{ text: "oldValue", changed: true },
			{ text: " = computeTotal(items);", changed: false },
		]);
		expect(code!.newSegments).toEqual([
			{ text: "const ", changed: false },
			{ text: "newValue", changed: true },
			{ text: " = computeTotal(items);", changed: false },
		]);

		const zh = diffLinePair("桌面编辑器。", "更轻、更快、更顺手的桌面编辑器。");
		expect(zh).not.toBeNull();
		expect(zh!.oldSegments).toEqual([{ text: "桌面编辑器。", changed: false }]);
		expect(zh!.newSegments).toEqual([
			{ text: "更轻、更快、更顺手的", changed: true },
			{ text: "桌面编辑器。", changed: false },
		]);
	});

	it("suppresses fragmented highlights when lines are nearly disjoint", () => {
		const res = diffLinePair("import fs from 'node:fs/promises';", "export const MAX_RETRY_COUNT = 42;");
		expect(res).toBeNull();
	});

	it("pairs lines cleanly inside uneven del/add runs", () => {
		const lines = [
			{ kind: "del" as const, old: 1, text: "return alpha + beta;" },
			{ kind: "add" as const, new: 1, text: "// comment above" },
			{ kind: "add" as const, new: 2, text: "return alpha + gamma;" },
		];
		const map = computeWordDiffLines(lines);
		expect(map.has(0)).toBe(true);
		expect(map.has(1)).toBe(false);
		expect(map.has(2)).toBe(true);
		expect(map.get(2)).toContainEqual({ text: "gamma", changed: true });
	});

	it("overlays <mark> highlights on hljs HTML cleanly across tags and entities", () => {
		const html = '<span class="hljs-keyword">const</span> title = <span class="hljs-string">&quot;old&quot;</span>;';
		const plain = 'const title = "old";';
		const pair = diffLinePair(plain, 'const title = "new";');
		expect(pair).not.toBeNull();
		const out = annotateHighlightedHtml(html, pair!.oldSegments, "del");
		expect(out).toBe('<span class="hljs-keyword">const</span> title = <span class="hljs-string">&quot;<mark class="pw-diff-word" data-kind="del">old</mark>&quot;</span>;');
	});

	it("extracts contiguous change blocks with accurate anchors", () => {
		const blocks = extractDiffBlocks([
			{ kind: "ctx", old: 1, new: 1, text: "head" },
			{ kind: "del", old: 2, text: "a" },
			{ kind: "add", new: 2, text: "b" },
			{ kind: "add", new: 3, text: "c" },
			{ kind: "ctx", old: 3, new: 4, text: "mid" },
			{ kind: "del", old: 4, text: "only-del" },
		]);
		expect(blocks).toEqual([
			{ index: 0, lineStart: 1, lineEnd: 4, delCount: 1, addCount: 2, oldAnchor: 2, newAnchor: 2, kind: "mod" },
			{ index: 1, lineStart: 5, lineEnd: 6, delCount: 1, addCount: 0, oldAnchor: 4, newAnchor: 4, kind: "del" },
		]);
	});
});
