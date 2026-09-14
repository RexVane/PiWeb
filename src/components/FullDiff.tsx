"use client";

/**
 * 整文件行内 diff（文件查看器「变更」模式）：全文都在，改动行红绿穿插在原位；
 * 未改动的长段可折成「··· n 行未改动 ···」；双列行号；右侧刻度条标出改动位置；上一处 / 下一处跳转；
 * 行数多时窗口化渲染，只对可见行做语法高亮。
 */
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { DiffLine } from "@/components/DiffView";
import { useI18n } from "@/i18n";
import { highlightLine } from "@/lib/highlight";

const ROW_H = 20;
const OVERSCAN = 20;
const CONTEXT = 3;
const HIGHLIGHT_MAX_ROWS = 6000;

type Row = { kind: "line"; line: DiffLine; index: number } | { kind: "fold"; from: number; count: number };

/** 行号栏宽度用的最大行号；不能用 Math.max(...spread)，十几万行的 patch 会把实参展开撑爆调用栈 */
export function maxLineNumber(lines: DiffLine[]): number {
	let max = 1;
	for (const l of lines) {
		const n = l.new ?? l.old ?? 0;
		if (n > max) max = n;
	}
	return max;
}

export interface FullDiffHandle {
	nextChange(): void;
	prevChange(): void;
}

function buildRows(lines: DiffLine[], folded: boolean, unfolded: Set<number>): { rows: Row[]; blocks: number[] } {
	const rows: Row[] = [];
	const blocks: number[] = [];
	const isChange = (l: DiffLine) => l.kind === "add" || l.kind === "del";
	// 首尾改动行的位置只算一次：原来每个未改动段都扫一遍前后缀，大文件上是 O(行数 × 段数)
	let firstChange = -1;
	let lastChange = -1;
	for (let k = 0; k < lines.length; k += 1) {
		if (!isChange(lines[k])) continue;
		if (firstChange < 0) firstChange = k;
		lastChange = k;
	}
	let i = 0;
	let prevChange = false;
	while (i < lines.length) {
		const l = lines[i];
		if (l.kind === "hunk" || l.kind === "file") {
			i += 1;
			continue;
		}
		if (isChange(l)) {
			if (!prevChange) blocks.push(rows.length);
			rows.push({ kind: "line", line: l, index: i });
			prevChange = true;
			i += 1;
			continue;
		}
		prevChange = false;
		// 一段连续未改动行
		let j = i;
		while (j < lines.length && lines[j].kind === "ctx") j += 1;
		const runLen = j - i;
		const atStart = firstChange < 0 || firstChange >= i;
		const atEnd = lastChange < j;
		const keepHead = atStart ? 0 : CONTEXT;
		const keepTail = atEnd ? 0 : CONTEXT;
		if (!folded || unfolded.has(i) || runLen <= keepHead + keepTail + 2) {
			for (let k = i; k < j; k += 1) rows.push({ kind: "line", line: lines[k], index: k });
		} else {
			for (let k = i; k < i + keepHead; k += 1) rows.push({ kind: "line", line: lines[k], index: k });
			rows.push({ kind: "fold", from: i, count: runLen - keepHead - keepTail });
			for (let k = j - keepTail; k < j; k += 1) rows.push({ kind: "line", line: lines[k], index: k });
		}
		i = j;
	}
	return { rows, blocks };
}

export const FullDiff = memo(function FullDiff({
	lines,
	language,
	folded,
	handle,
	initialChange,
}: {
	lines: DiffLine[];
	language?: string;
	folded: boolean;
	handle?: Ref<FullDiffHandle>;
	/** 首次渲染滚到第一处改动 */
	initialChange?: boolean;
}) {
	const { t } = useI18n();
	const [unfolded, setUnfolded] = useState<Set<number>>(() => new Set());
	const scrollRef = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState({ top: 0, height: 800 });
	const [current, setCurrent] = useState(-1);
	const cache = useRef(new Map<string, string | null>());

	useEffect(() => setUnfolded(new Set()), [lines]);
	const { rows, blocks } = useMemo(() => buildRows(lines, folded, unfolded), [lines, folded, unfolded]);
	const width = useMemo(() => String(maxLineNumber(lines)).length, [lines]);
	const canHighlight = Boolean(language) && rows.length <= HIGHLIGHT_MAX_ROWS;

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
		update();
		el.addEventListener("scroll", update, { passive: true });
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => {
			el.removeEventListener("scroll", update);
			ro.disconnect();
		};
	}, []);

	const scrollToBlock = useCallback(
		(b: number) => {
			const el = scrollRef.current;
			const rowIndex = blocks[b];
			if (!el || rowIndex === undefined) return;
			setCurrent(b);
			el.scrollTo({ top: Math.max(0, rowIndex * ROW_H - el.clientHeight / 3), behavior: "smooth" });
		},
		[blocks],
	);
	useImperativeHandle(handle, () => ({
		nextChange: () => scrollToBlock(Math.min(blocks.length - 1, current + 1)),
		prevChange: () => scrollToBlock(Math.max(0, current - 1)),
	}), [blocks.length, current, scrollToBlock]);

	// 首次：滚到第一处改动
	const initialDone = useRef(false);
	useEffect(() => {
		initialDone.current = false;
	}, [lines]);
	useEffect(() => {
		if (initialDone.current || !initialChange || !blocks.length) return;
		initialDone.current = true;
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = Math.max(0, blocks[0] * ROW_H - el.clientHeight / 3);
		setCurrent(0);
	}, [blocks, initialChange, rows]);

	const start = Math.max(0, Math.floor(viewport.top / ROW_H) - OVERSCAN);
	const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_H) + OVERSCAN);
	const html = (text: string): string | null => {
		if (!canHighlight || !text.trim()) return null;
		const k = text;
		const cached = cache.current.get(k);
		if (cached !== undefined) return cached;
		const h = highlightLine(text, language!);
		if (cache.current.size > 5000) cache.current.clear();
		cache.current.set(k, h);
		return h;
	};

	return (
		<div className="pw-fdiff relative min-h-0 flex-1">
			<div ref={scrollRef} className="pw-fdiff-scroll h-full overflow-auto">
				<div style={{ height: rows.length * ROW_H, position: "relative", minWidth: "100%" }}>
					{rows.slice(start, end).map((row, i) => {
						const top = (start + i) * ROW_H;
						if (row.kind === "fold") {
							return (
								<button
									key={`f${row.from}`}
									type="button"
									className="pw-fdiff-fold"
									style={{ top }}
									onClick={() => setUnfolded((s) => new Set(s).add(row.from))}
								>
									{t.viewerFoldedLines.replace("{n}", String(row.count))}
								</button>
							);
						}
						const l = row.line;
						const h = html(l.text);
						return (
							<div key={row.index} className="pw-fdiff-row" data-kind={l.kind} style={{ top }}>
								<span className="pw-fdiff-gutter" style={{ width: `${width * 2 + 3}ch` }}>
									<span>{l.kind === "add" ? "" : String(l.old ?? "").padStart(width)}</span>
									<span>{l.kind === "del" ? "" : String(l.new ?? "").padStart(width)}</span>
								</span>
								<span className="pw-fdiff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
								<span className="pw-fdiff-text hljs">{h ? <span dangerouslySetInnerHTML={{ __html: h }} /> : l.text}</span>
							</div>
						);
					})}
				</div>
			</div>
			{/* 改动位置刻度条 */}
			{rows.length > 0 && blocks.length > 0 && (
				<div className="pw-fdiff-ticks" aria-hidden>
					{blocks.map((rowIndex, b) => {
						const line = rows[rowIndex];
						const kind = line?.kind === "line" ? line.line.kind : "add";
						return (
							<span
								key={b}
								className="pw-fdiff-tick"
								data-kind={kind}
								data-current={b === current || undefined}
								style={{ top: `${(rowIndex / rows.length) * 100}%` }}
								onClick={() => scrollToBlock(b)}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
});
