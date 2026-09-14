"use client";

/**
 * 统一 diff 视图：对话里 edit/write 的 patch、Git 面板的文件差异与提交内容共用。
 * 解析 unified diff（含多文件 git diff / git show 输出），按行号渲染红绿；
 * 每行按文件语言做语法高亮（highlight.js），多文件 diff 跟着 +++ 头切换语言。
 */
import { useMemo } from "react";
import { highlightLine, languageForPath } from "@/lib/highlight";

export interface DiffLine {
	kind: "add" | "del" | "ctx" | "hunk" | "file";
	old?: number;
	new?: number;
	text: string;
}

export function parseUnifiedDiff(text: string): DiffLine[] | null {
	const out: DiffLine[] = [];
	const rows = text.replace(/\r\n/g, "\n").split("\n");
	let oldLine = 0;
	let newLine = 0;
	let oldLeft = 0;
	let newLeft = 0;
	let inHunk = false;
	let pendingFile: string | undefined;
	const headerPath = (row: string) => {
		const value = row.slice(4).split("\t")[0];
		if (!value.startsWith('"')) return value;
		try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
	};
	for (let index = 0; index < rows.length; index += 1) {
		const raw = rows[index];
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(raw);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[3]);
			oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
			inHunk = oldLeft > 0 || newLeft > 0;
			if (pendingFile !== undefined) {
				out.push({ kind: "file", text: pendingFile });
				pendingFile = undefined;
			} else if (out.length && out[out.length - 1].kind !== "file") out.push({ kind: "hunk", text: "…" });
			continue;
		}
		// Inside a hunk, ---/+++ are ordinary removed/added SQL or Lua comments.
		// Only the declared old/new counts can end a well-formed hunk.
		if (inHunk) {
			if (raw.startsWith("\\")) continue; // no-newline marker consumes neither side
			if (raw.startsWith("-") && oldLeft > 0) {
				out.push({ kind: "del", old: oldLine++, text: raw.slice(1) });
				oldLeft -= 1;
			} else if (raw.startsWith("+") && newLeft > 0) {
				out.push({ kind: "add", new: newLine++, text: raw.slice(1) });
				newLeft -= 1;
			} else if (raw.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
				out.push({ kind: "ctx", old: oldLine++, new: newLine++, text: raw.slice(1) });
				oldLeft -= 1;
				newLeft -= 1;
			} else {
				// Truncated/malformed input must not turn metadata into context lines.
				inHunk = false;
			}
			if (oldLeft === 0 && newLeft === 0) inHunk = false;
			if (raw[0] === "+" || raw[0] === "-" || raw[0] === " ") continue;
		}
		if (raw.startsWith("diff --git ")) pendingFile = undefined;
		// A file header is a pair, outside a hunk. Deleted files use the old path.
		if (raw.startsWith("--- ") && rows[index + 1]?.startsWith("+++ ")) {
			const oldPath = headerPath(raw);
			const newPath = headerPath(rows[++index]);
			pendingFile = newPath === "/dev/null" ? oldPath.replace(/^a\//, "") : newPath.replace(/^b\//, "");
		}
	}
	return out.some((line) => line.kind === "add" || line.kind === "del" || line.kind === "ctx") ? out : null;
}

export function diffStats(lines: DiffLine[]): { add: number; del: number } {
	let add = 0;
	let del = 0;
	for (const l of lines) {
		if (l.kind === "add") add += 1;
		else if (l.kind === "del") del += 1;
	}
	return { add, del };
}

export function DiffView({ lines, language }: { lines: DiffLine[]; language?: string }) {
	let maxNo = 1;
	for (const l of lines) {
		const n = l.new ?? l.old ?? 0;
		if (n > maxNo) maxNo = n;
	}
	const width = String(maxNo).length;
	// 逐行高亮：语言来自 prop（单文件）或 diff 里的 +++ 文件头（多文件 git show）
	const html = useMemo(() => {
		let lang = language;
		return lines.map((l) => {
			if (l.kind === "file") {
				lang = languageForPath(l.text) ?? language;
				return null;
			}
			if (l.kind === "hunk" || !lang || !l.text.trim()) return null;
			return highlightLine(l.text, lang);
		});
	}, [lines, language]);
	return (
		<pre className="hljs whitespace-pre-wrap" style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: "18px", margin: 0, background: "transparent" }}>
			{lines.map((l, i) => {
				if (l.kind === "file") {
					return (
						<div
							key={i}
							className="truncate"
							style={{ margin: i === 0 ? "0 -8px 2px" : "8px -8px 2px", padding: "2px 8px", fontSize: 11.5, fontWeight: 600, color: "var(--dsw-label-secondary)", borderBottom: "0.5px solid var(--dsw-border-l2)" }}
							title={l.text}
						>
							{l.text}
						</div>
					);
				}
				const num = l.kind === "hunk" ? "" : String(l.kind === "del" ? l.old : l.new).padStart(width);
				const signColor = l.kind === "add" ? "var(--dsw-success)" : l.kind === "del" ? "var(--dsw-danger)" : "var(--dsw-label-caption)";
				// 新增绿、删除红：底色 + 左侧 2px 色条；正文按语言着色（未高亮时用次级文字色）
				const bg = l.kind === "add" ? "rgba(34,197,94,.14)" : l.kind === "del" ? "rgba(236,19,19,.12)" : "transparent";
				const bar = l.kind === "add" ? "inset 2px 0 0 var(--dsw-success)" : l.kind === "del" ? "inset 2px 0 0 var(--dsw-danger)" : undefined;
				const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
				const h = html[i];
				return (
					<div key={i} style={{ background: bg, boxShadow: bar, color: l.kind === "hunk" ? "var(--dsw-label-caption)" : "var(--dsw-label-secondary)", padding: "0 8px", margin: "0 -8px" }}>
						<span style={{ color: signColor, userSelect: "none" }}>{num} {sign} </span>
						{h ? <span dangerouslySetInnerHTML={{ __html: h }} /> : l.text}
					</div>
				);
			})}
		</pre>
	);
}
