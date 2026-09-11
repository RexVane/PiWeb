"use client";

/**
 * 统一 diff 视图：对话里 edit/write 的 patch、Git 面板的文件差异与提交内容共用。
 * 解析 unified diff（含多文件 git diff / git show 输出），按行号渲染红绿。
 */

export interface DiffLine {
	kind: "add" | "del" | "ctx" | "hunk" | "file";
	old?: number;
	new?: number;
	text: string;
}

export function parseUnifiedDiff(text: string): DiffLine[] | null {
	if (!/^@@ -\d+/m.test(text)) return null;
	const out: DiffLine[] = [];
	let o = 0;
	let n = 0;
	let inHunk = false;
	for (const raw of text.replace(/\r/g, "").split("\n")) {
		// 多文件 diff：以 +++ b/path 作为文件分隔行
		const file = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
		if (file && !inHunk) {
			if (file[1] !== "/dev/null") out.push({ kind: "file", text: file[1] });
			continue;
		}
		const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (h) {
			o = Number(h[1]);
			n = Number(h[2]);
			inHunk = true;
			if (out.length && out[out.length - 1].kind !== "file") out.push({ kind: "hunk", text: "…" });
			continue;
		}
		if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity") || raw.startsWith("rename ")) {
			inHunk = false;
			continue;
		}
		if (!inHunk) continue;
		if (raw.startsWith("+")) out.push({ kind: "add", new: n++, text: raw.slice(1) });
		else if (raw.startsWith("-")) out.push({ kind: "del", old: o++, text: raw.slice(1) });
		else if (raw.startsWith("\\")) continue;
		else out.push({ kind: "ctx", old: o++, new: n++, text: raw.slice(1) });
	}
	return out.some((l) => l.kind !== "file") ? out : null;
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

export function DiffView({ lines }: { lines: DiffLine[] }) {
	const width = String(Math.max(1, ...lines.map((l) => l.new ?? l.old ?? 0))).length;
	return (
		<pre className="whitespace-pre-wrap" style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: "18px", margin: 0 }}>
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
				const color = l.kind === "add" ? "var(--dsw-success)" : l.kind === "del" ? "var(--dsw-danger)" : "var(--dsw-label-tertiary)";
				const bg = l.kind === "add" ? "rgba(34,197,94,.10)" : l.kind === "del" ? "rgba(236,19,19,.10)" : "transparent";
				const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
				return (
					<div key={i} style={{ background: bg, color: l.kind === "ctx" ? "var(--dsw-label-secondary)" : color, padding: "0 8px", margin: "0 -8px" }}>
						<span style={{ color: "var(--dsw-label-caption)", userSelect: "none" }}>{num} {sign} </span>
						{l.text}
					</div>
				);
			})}
		</pre>
	);
}
