"use client";

/**
 * 统一 diff 视图：对话里 edit/write 的 patch、Git 面板的文件差异与提交内容共用。
 * 解析 unified diff（含多文件 git diff / git show 输出），按行号渲染红绿；
 * 每行按文件语言做语法高亮（highlight.js），多文件 diff 跟着 +++ 头切换语言。
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
	const viewport = useRef<HTMLPreElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const rowHeight = 18;
	const virtual = lines.length > 400;
	const windowSize = Math.ceil(400 / rowHeight) + 40;
	const from = virtual ? Math.min(Math.max(0, lines.length - windowSize), Math.max(0, Math.floor(scrollTop / rowHeight) - 20)) : 0;
	const to = virtual ? Math.min(lines.length, from + windowSize) : lines.length;
	useEffect(() => { setScrollTop(0); if (viewport.current) viewport.current.scrollTop = 0; }, [lines]);
	const width = useMemo(() => {
		let maximum = 1;
		for (const line of lines) maximum = Math.max(maximum, line.new ?? line.old ?? 0);
		return String(maximum).length;
	}, [lines]);
	const languages = useMemo(() => {
		let current = language;
		return lines.map((line) => {
			if (line.kind === "file") current = languageForPath(line.text) ?? language;
			return current;
		});
	}, [lines, language]);
	const html = useMemo(() => lines.slice(from, to).map((line, index) => {
		const current = languages[from + index];
		return line.kind !== "file" && line.kind !== "hunk" && current ? highlightLine(line.text, current) : null;
	}), [lines, languages, from, to]);
	return (
		<pre ref={viewport} className="hljs whitespace-pre" data-testid="diff-viewport"
			onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
			style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: rowHeight + "px", margin: 0, background: "transparent", overflow: "auto", maxHeight: virtual ? 400 : undefined, whiteSpace: "pre" }}>
			<div style={{ position: "relative", height: lines.length * rowHeight, minWidth: "max-content" }}>
				{lines.slice(from, to).map((line, index) => {
					const at = from + index;
					const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
					const changed = line.kind === "add" || line.kind === "del";
					const color = line.kind === "add" ? "var(--dsw-success)" : line.kind === "del" ? "var(--dsw-danger)" : "var(--dsw-label-caption)";
					return (
						<div key={at} className="pw-diff-row" data-kind={line.kind}
							style={{ position: "absolute", top: at * rowHeight, height: rowHeight, minWidth: "100%", width: "max-content", padding: "0 8px",
								color: "var(--dsw-label-secondary)", background: changed ? line.kind === "add" ? "rgba(34,197,94,.14)" : "rgba(236,19,19,.12)" : "transparent",
								boxShadow: changed ? "inset 2px 0 0 " + color : undefined }}>
							{line.kind === "file" ? <strong title={line.text}>{line.text}</strong> : <>
								<span aria-hidden style={{ color, userSelect: "none" }}>{line.kind === "hunk" ? "" : String(line.kind === "del" ? line.old ?? "" : line.new ?? "").padStart(width)} </span>
								<span style={{ color, userSelect: "text" }}>{sign}</span>
								{html[index] ? <span dangerouslySetInnerHTML={{ __html: html[index]! }} /> : line.text}
							</>}
						</div>
					);
				})}
			</div>
		</pre>
	);
}
