"use client";

/**
 * 整文件 diff（文件查看器「变更」模式）：
 * - 支持「并排（Split）」与「行内（Inline）」双视图切换；
 * - 并排模式下左右双栏各自按真实行号连续排列，中间通过 SVG 贝塞尔曲线连接变更块；
 * - 支持配对行词级高亮（word diff）、按块暂存/取消暂存勾选、长段折叠与 [ / ] 快速跳转；
 * - 窗口化虚拟列表，大文件仅高亮可视窗口行，保持流畅。
 */
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { DiffLine } from "@/components/DiffView";
import { useI18n } from "@/i18n";
import { highlightLine } from "@/lib/highlight";
import { annotateHighlightedHtml, computeWordDiffLines, type DiffSegment } from "@/lib/word-diff";

const ROW_H = 20;
const OVERSCAN = 20;
const CONTEXT = 3;
const HIGHLIGHT_MAX_ROWS = 6000;
const BRIDGE_WIDTH = 46;

export type DiffLayout = "split" | "inline";

export interface DiffHunkAnchor {
	oldAnchor: number;
	newAnchor: number;
	delCount: number;
	addCount: number;
}

export interface DiffHunkAction {
	/** 按钮无障碍标签，如 "暂存此块" / "取消暂存此块" */
	label: string;
	/** 当前是否处于已暂存状态（true 时勾选显示已暂存） */
	checked: boolean;
	/** 正在提交请求中的块下标（禁用连点） */
	busyBlock?: number | null;
	onToggle: (blockIndex: number, anchor: DiffHunkAnchor) => void;
}

type Row = { kind: "line"; line: DiffLine; index: number } | { kind: "fold"; from: number; count: number };

interface SplitBlock {
	index: number;
	kind: "add" | "del" | "mod";
	anchor: DiffHunkAnchor;
	leftStartRow: number;
	leftEndRow: number;
	rightStartRow: number;
	rightEndRow: number;
}

interface ScrollAnchor {
	leftY: number;
	rightY: number;
}

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

function buildInlineRows(lines: DiffLine[], folded: boolean, unfolded: Set<number>): { rows: Row[]; blocks: number[] } {
	const rows: Row[] = [];
	const blocks: number[] = [];
	const isChange = (l: DiffLine) => l.kind === "add" || l.kind === "del";
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

function buildSplitModel(lines: DiffLine[], folded: boolean, unfolded: Set<number>): {
	leftRows: Row[];
	rightRows: Row[];
	blocks: SplitBlock[];
	anchors: ScrollAnchor[];
} {
	const leftRows: Row[] = [];
	const rightRows: Row[] = [];
	const blocks: SplitBlock[] = [];
	const anchors: ScrollAnchor[] = [{ leftY: 0, rightY: 0 }];
	const isChange = (l: DiffLine) => l.kind === "add" || l.kind === "del";

	let firstChange = -1;
	let lastChange = -1;
	for (let k = 0; k < lines.length; k += 1) {
		if (!isChange(lines[k])) continue;
		if (firstChange < 0) firstChange = k;
		lastChange = k;
	}

	let i = 0;
	let lastOld = 0;
	let lastNew = 0;
	const pushAnchor = () => {
		const leftY = leftRows.length * ROW_H;
		const rightY = rightRows.length * ROW_H;
		const prev = anchors[anchors.length - 1];
		if (!prev || prev.leftY !== leftY || prev.rightY !== rightY) {
			anchors.push({ leftY, rightY });
		}
	};

	while (i < lines.length) {
		const l = lines[i];
		if (l.kind === "hunk" || l.kind === "file") {
			i += 1;
			continue;
		}
		if (isChange(l)) {
			const leftStartRow = leftRows.length;
			const rightStartRow = rightRows.length;
			let delCount = 0;
			let addCount = 0;
			let firstOld: number | undefined;
			let firstNew: number | undefined;
			while (i < lines.length && isChange(lines[i])) {
				const cur = lines[i];
				if (cur.kind === "del") {
					delCount += 1;
					if (firstOld === undefined && cur.old !== undefined) firstOld = cur.old;
					if (cur.old !== undefined) lastOld = cur.old;
					leftRows.push({ kind: "line", line: cur, index: i });
				} else {
					addCount += 1;
					if (firstNew === undefined && cur.new !== undefined) firstNew = cur.new;
					if (cur.new !== undefined) lastNew = cur.new;
					rightRows.push({ kind: "line", line: cur, index: i });
				}
				i += 1;
			}
			const leftEndRow = leftRows.length;
			const rightEndRow = rightRows.length;
			blocks.push({
				index: blocks.length,
				kind: delCount > 0 && addCount > 0 ? "mod" : delCount > 0 ? "del" : "add",
				anchor: {
					oldAnchor: firstOld ?? lastOld,
					newAnchor: firstNew ?? lastNew,
					delCount,
					addCount,
				},
				leftStartRow,
				leftEndRow,
				rightStartRow,
				rightEndRow,
			});
			pushAnchor();
			continue;
		}

		// 未改动段：两侧同时推进相同行数
		let j = i;
		while (j < lines.length && lines[j].kind === "ctx") j += 1;
		const runLen = j - i;
		const atStart = firstChange < 0 || firstChange >= i;
		const atEnd = lastChange < j;
		const keepHead = atStart ? 0 : CONTEXT;
		const keepTail = atEnd ? 0 : CONTEXT;
		const pushCtx = (idx: number) => {
			const c = lines[idx];
			if (c.old !== undefined) lastOld = c.old;
			if (c.new !== undefined) lastNew = c.new;
			leftRows.push({ kind: "line", line: c, index: idx });
			rightRows.push({ kind: "line", line: c, index: idx });
		};
		if (!folded || unfolded.has(i) || runLen <= keepHead + keepTail + 2) {
			for (let k = i; k < j; k += 1) pushCtx(k);
		} else {
			for (let k = i; k < i + keepHead; k += 1) pushCtx(k);
			const foldCount = runLen - keepHead - keepTail;
			leftRows.push({ kind: "fold", from: i, count: foldCount });
			rightRows.push({ kind: "fold", from: i, count: foldCount });
			for (let k = j - keepTail; k < j; k += 1) pushCtx(k);
		}
		pushAnchor();
		i = j;
	}

	return { leftRows, rightRows, blocks, anchors };
}

function mapAnchorY(anchors: readonly ScrollAnchor[], sourceY: number, dir: "LtoR" | "RtoL"): number {
	if (anchors.length === 0) return sourceY;
	const srcKey = dir === "LtoR" ? "leftY" : "rightY";
	const dstKey = dir === "LtoR" ? "rightY" : "leftY";
	if (sourceY <= anchors[0][srcKey]) return anchors[0][dstKey];
	const last = anchors[anchors.length - 1];
	if (sourceY >= last[srcKey]) return last[dstKey];

	let lo = 0;
	let hi = anchors.length - 1;
	while (lo + 1 < hi) {
		const mid = (lo + hi) >> 1;
		if (anchors[mid][srcKey] <= sourceY) lo = mid;
		else hi = mid;
	}
	const a = anchors[lo];
	const b = anchors[lo + 1] ?? a;
	const span = b[srcKey] - a[srcKey];
	if (span <= 0) return b[dstKey];
	const ratio = (sourceY - a[srcKey]) / span;
	return a[dstKey] + ratio * (b[dstKey] - a[dstKey]);
}

function scrollSmoothly(el: HTMLElement, top: number): void {
	if (typeof el.scrollTo === "function") el.scrollTo({ top, behavior: "smooth" });
	else el.scrollTop = top;
}

/** 估算文本展示宽度（用于撑开虚拟滚动水平容器，避免长短行在左栏粘性行号列错位） */
function visualColumns(text: string): number {
	let col = 0;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code === 9) {
			col += 8 - (col % 8);
		} else if (code >= 0xd800 && code <= 0xdbff) {
			col += 2;
			i += 1;
		} else {
			col += code > 0xff ? 2 : 1;
		}
	}
	return col;
}

function widestRowText(rows: readonly Row[]): string {
	let best = "";
	let bestCols = 0;
	for (const r of rows) {
		if (r.kind !== "line") continue;
		const cols = visualColumns(r.line.text);
		if (cols > bestCols) {
			bestCols = cols;
			best = r.line.text;
		}
	}
	return best;
}

/** 根据滚动位置平顺选取读取基线：顶对齐 0、中间对齐视口 1/3、底对齐底端 */
function syncAnchorOffset(scrollTop: number, maxScroll: number, srcHeight: number, dstHeight = srcHeight): { src: number; dst: number } {
	if (maxScroll <= 0 || srcHeight <= 0) return { src: 0, dst: 0 };
	const midOffset = srcHeight / 3;
	if (scrollTop <= midOffset) return { src: scrollTop, dst: scrollTop };
	const tailZone = Math.max(1, srcHeight - midOffset);
	const remaining = maxScroll - scrollTop;
	if (remaining < tailZone) {
		const t = 1 - remaining / tailZone;
		return {
			src: midOffset + t * (srcHeight - midOffset),
			dst: midOffset + t * Math.max(0, dstHeight - midOffset),
		};
	}
	return { src: midOffset, dst: midOffset };
}

function renderLineContent(
	text: string,
	kind: DiffLine["kind"],
	highlighted: string | null,
	segments: readonly DiffSegment[] | undefined,
) {
	if (highlighted) {
		const finalHtml = segments && (kind === "add" || kind === "del")
			? annotateHighlightedHtml(highlighted, segments, kind)
			: highlighted;
		return <span dangerouslySetInnerHTML={{ __html: finalHtml }} />;
	}
	if (segments && (kind === "add" || kind === "del")) {
		return (
			<span>
				{segments.map((seg, i) =>
					seg.changed ? <mark key={i} className="pw-diff-word" data-kind={kind}>{seg.text}</mark> : seg.text,
				)}
			</span>
		);
	}
	return text;
}

export const FullDiff = memo(function FullDiff({
	lines,
	language,
	folded,
	layout = "split",
	leftLabel,
	rightLabel,
	hunkAction,
	handle,
	initialChange,
}: {
	lines: DiffLine[];
	language?: string;
	folded: boolean;
	layout?: DiffLayout;
	leftLabel?: string;
	rightLabel?: string;
	hunkAction?: DiffHunkAction;
	handle?: Ref<FullDiffHandle>;
	/** 首次渲染滚到第一处改动 */
	initialChange?: boolean;
}) {
	const { t } = useI18n();
	const [unfolded, setUnfolded] = useState<Set<number>>(() => new Set());
	const inlineScrollRef = useRef<HTMLDivElement>(null);
	const leftScrollRef = useRef<HTMLDivElement>(null);
	const rightScrollRef = useRef<HTMLDivElement>(null);
	const bridgeRef = useRef<HTMLDivElement>(null);
	const syncSourceRef = useRef<"left" | "right" | null>(null);
	const syncTimerRef = useRef<number | null>(null);
	const expectedEchoRef = useRef<{ left: number | null; right: number | null }>({ left: null, right: null });
	const programmaticUntilRef = useRef<number>(0);

	const [inlineVp, setInlineVp] = useState({ top: 0, height: 800 });
	const [splitVp, setSplitVp] = useState({ leftTop: 0, rightTop: 0, width: BRIDGE_WIDTH - 2, height: 800 });
	const [current, setCurrent] = useState(-1);
	const cache = useRef(new Map<string, string | null>());

	const getBridgeSize = useCallback(
		() => ({
			width: bridgeRef.current?.clientWidth || BRIDGE_WIDTH - 2,
			height: bridgeRef.current?.clientHeight || rightScrollRef.current?.clientHeight || leftScrollRef.current?.clientHeight || 800,
		}),
		[],
	);

	useEffect(() => setUnfolded(new Set()), [lines]);
	useEffect(() => () => { if (syncTimerRef.current !== null) cancelAnimationFrame(syncTimerRef.current); }, []);

	const wordDiff = useMemo(() => computeWordDiffLines(lines), [lines]);
	const inlineModel = useMemo(
		() => (layout === "inline" ? buildInlineRows(lines, folded, unfolded) : null),
		[layout, lines, folded, unfolded],
	);
	const splitModel = useMemo(
		() => (layout === "split" ? buildSplitModel(lines, folded, unfolded) : null),
		[layout, lines, folded, unfolded],
	);
	const widestInline = useMemo(() => (inlineModel ? widestRowText(inlineModel.rows) : ""), [inlineModel]);
	const widestLeft = useMemo(() => (splitModel ? widestRowText(splitModel.leftRows) : ""), [splitModel]);
	const widestRight = useMemo(() => (splitModel ? widestRowText(splitModel.rightRows) : ""), [splitModel]);

	const width = useMemo(() => String(maxLineNumber(lines)).length, [lines]);
	const totalRows = layout === "inline" ? (inlineModel?.rows.length ?? 0) : (splitModel?.rightRows.length ?? 0);
	const canHighlight = Boolean(language) && totalRows <= HIGHLIGHT_MAX_ROWS;
	const blockCount = layout === "inline" ? (inlineModel?.blocks.length ?? 0) : (splitModel?.blocks.length ?? 0);

	// 监听行内滚动容器大小与位置
	useEffect(() => {
		if (layout !== "inline") return;
		const el = inlineScrollRef.current;
		if (!el) return;
		const update = () => {
			el.style.setProperty("--pw-pane-w", `${el.clientWidth}px`);
			setInlineVp({ top: el.scrollTop, height: el.clientHeight });
		};
		update();
		el.addEventListener("scroll", update, { passive: true });
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => {
			el.removeEventListener("scroll", update);
			ro.disconnect();
		};
	}, [layout]);

	// 监听并排双栏高度变化与滚动位置（严格以 bridgeRef 内盒宽高为 1:1 SVG 坐标基准，避免边框或单侧水平滚动条触发任何缩放）
	useEffect(() => {
		if (layout !== "split") return;
		const leftEl = leftScrollRef.current;
		const rightEl = rightScrollRef.current;
		const bridgeEl = bridgeRef.current;
		if (!leftEl || !rightEl) return;
		const measure = () => {
			leftEl.style.setProperty("--pw-pane-w", `${leftEl.clientWidth}px`);
			rightEl.style.setProperty("--pw-pane-w", `${rightEl.clientWidth}px`);
			const { width: vpWidth, height: vpHeight } = getBridgeSize();
			setSplitVp({
				leftTop: leftEl.scrollTop,
				rightTop: rightEl.scrollTop,
				width: vpWidth,
				height: vpHeight,
			});
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(leftEl);
		ro.observe(rightEl);
		if (bridgeEl) ro.observe(bridgeEl);
		return () => ro.disconnect();
	}, [layout, getBridgeSize]);

	const handleSplitScroll = useCallback((side: "left" | "right") => {
		if (!splitModel) return;
		const leftEl = leftScrollRef.current;
		const rightEl = rightScrollRef.current;
		if (!leftEl || !rightEl) return;
		const { width: vpWidth, height: vpHeight } = getBridgeSize();

		const srcEl = side === "left" ? leftEl : rightEl;
		const expected = expectedEchoRef.current[side];
		if (expected !== null && Math.abs(srcEl.scrollTop - expected) < 2) {
			expectedEchoRef.current[side] = null;
			setSplitVp({ leftTop: leftEl.scrollTop, rightTop: rightEl.scrollTop, width: vpWidth, height: vpHeight });
			return;
		}
		if (performance.now() < programmaticUntilRef.current || (syncSourceRef.current && syncSourceRef.current !== side)) {
			setSplitVp({ leftTop: leftEl.scrollTop, rightTop: rightEl.scrollTop, width: vpWidth, height: vpHeight });
			return;
		}
		syncSourceRef.current = side;
		if (syncTimerRef.current !== null) cancelAnimationFrame(syncTimerRef.current);
		syncTimerRef.current = requestAnimationFrame(() => {
			syncSourceRef.current = null;
			expectedEchoRef.current.left = null;
			expectedEchoRef.current.right = null;
		});

		const dstEl = side === "left" ? rightEl : leftEl;
		const dstSide: "left" | "right" = side === "left" ? "right" : "left";
		const maxSrc = Math.max(0, srcEl.scrollHeight - srcEl.clientHeight);
		const maxDst = Math.max(0, dstEl.scrollHeight - dstEl.clientHeight);
		const offset = syncAnchorOffset(srcEl.scrollTop, maxSrc, srcEl.clientHeight, dstEl.clientHeight);
		const mapped = mapAnchorY(splitModel.anchors, srcEl.scrollTop + offset.src, side === "left" ? "LtoR" : "RtoL");
		const nextDstTop = Math.max(0, Math.min(maxDst, mapped - offset.dst));
		if (Math.abs(dstEl.scrollTop - nextDstTop) >= 0.5) {
			expectedEchoRef.current[dstSide] = nextDstTop;
			dstEl.scrollTop = nextDstTop;
		}
		setSplitVp({ leftTop: leftEl.scrollTop, rightTop: rightEl.scrollTop, width: vpWidth, height: vpHeight });
	}, [getBridgeSize, splitModel]);

	const scrollToBlock = useCallback(
		(b: number) => {
			if (layout === "inline" && inlineModel) {
				const el = inlineScrollRef.current;
				const rowIndex = inlineModel.blocks[b];
				if (!el || rowIndex === undefined) return;
				setCurrent(b);
				scrollSmoothly(el, Math.max(0, rowIndex * ROW_H - el.clientHeight / 3));
				return;
			}
			if (layout === "split" && splitModel) {
				const leftEl = leftScrollRef.current;
				const rightEl = rightScrollRef.current;
				const blk = splitModel.blocks[b];
				if (!leftEl || !rightEl || !blk) return;
				setCurrent(b);
				const anchorY = Math.round(getBridgeSize().height / 3);
				programmaticUntilRef.current = performance.now() + 650;
				syncSourceRef.current = null;
				const leftTarget = Math.max(0, blk.leftStartRow * ROW_H - anchorY);
				const rightTarget = Math.max(0, blk.rightStartRow * ROW_H - anchorY);
				scrollSmoothly(leftEl, leftTarget);
				scrollSmoothly(rightEl, rightTarget);
			}
		},
		[getBridgeSize, layout, inlineModel, splitModel],
	);

	useImperativeHandle(handle, () => ({
		nextChange: () => { if (blockCount > 0) scrollToBlock(Math.min(blockCount - 1, current + 1)); },
		prevChange: () => { if (blockCount > 0) scrollToBlock(Math.max(0, current - 1)); },
	}), [blockCount, current, scrollToBlock]);

	// 首次：滚到第一处改动
	const initialDone = useRef(false);
	useEffect(() => {
		initialDone.current = false;
	}, [lines, layout]);
	useEffect(() => {
		if (initialDone.current || !initialChange || blockCount === 0) return;
		initialDone.current = true;
		if (layout === "inline" && inlineModel) {
			const el = inlineScrollRef.current;
			if (!el) return;
			el.scrollTop = Math.max(0, inlineModel.blocks[0] * ROW_H - el.clientHeight / 3);
			setCurrent(0);
			return;
		}
		if (layout === "split" && splitModel) {
			const leftEl = leftScrollRef.current;
			const rightEl = rightScrollRef.current;
			const blk = splitModel.blocks[0];
			if (!leftEl || !rightEl || !blk) return;
			const { width: vpWidth, height: vpHeight } = getBridgeSize();
			const anchorY = Math.round(vpHeight / 3);
			const lt = Math.max(0, blk.leftStartRow * ROW_H - anchorY);
			const rt = Math.max(0, blk.rightStartRow * ROW_H - anchorY);
			programmaticUntilRef.current = 0;
			syncSourceRef.current = "left";
			leftEl.scrollTop = lt;
			rightEl.scrollTop = rt;
			setSplitVp({ leftTop: leftEl.scrollTop, rightTop: rightEl.scrollTop, width: vpWidth, height: vpHeight });
			syncSourceRef.current = null;
			setCurrent(0);
		}
	}, [getBridgeSize, layout, inlineModel, splitModel, blockCount, initialChange]);

	const html = useCallback((text: string): string | null => {
		if (!canHighlight || !text.trim()) return null;
		const cached = cache.current.get(text);
		if (cached !== undefined) return cached;
		const h = highlightLine(text, language!);
		if (cache.current.size > 5000) cache.current.clear();
		cache.current.set(text, h);
		return h;
	}, [canHighlight, language]);

	// 清理高亮缓存（语言切换时）
	useEffect(() => { cache.current.clear(); }, [language]);

	if (layout === "inline" && inlineModel) {
		const { rows, blocks } = inlineModel;
		const blockByStartRow = new Map<number, { index: number; anchor: DiffHunkAnchor }>();
		if (hunkAction) {
			// 提取每块对应的块坐标以便在行内视图也挂出按钮
			let prevIdx = -1;
			let curDel = 0;
			let curAdd = 0;
			let firstOld = 0;
			let firstNew = 0;
			for (let b = 0; b < blocks.length; b += 1) {
				const rStart = blocks[b];
				curDel = 0;
				curAdd = 0;
				firstOld = 0;
				firstNew = 0;
				for (let r = rStart; r < rows.length; r += 1) {
					const row = rows[r];
					if (row.kind !== "line" || (row.line.kind !== "add" && row.line.kind !== "del")) break;
					if (row.line.kind === "del") {
						curDel += 1;
						if (!firstOld && row.line.old) firstOld = row.line.old;
					} else {
						curAdd += 1;
						if (!firstNew && row.line.new) firstNew = row.line.new;
					}
					prevIdx = row.line.old ?? prevIdx;
				}
				blockByStartRow.set(rStart, {
					index: b,
					anchor: { oldAnchor: firstOld || prevIdx, newAnchor: firstNew, delCount: curDel, addCount: curAdd },
				});
			}
		}
		const start = Math.max(0, Math.floor(inlineVp.top / ROW_H) - OVERSCAN);
		const end = Math.min(rows.length, Math.ceil((inlineVp.top + inlineVp.height) / ROW_H) + OVERSCAN);

		return (
			<div className="pw-fdiff relative min-h-0 flex-1" data-layout="inline">
				<div ref={inlineScrollRef} className="pw-fdiff-scroll h-full overflow-auto">
					<div style={{ height: rows.length * ROW_H, position: "relative", minWidth: "100%", width: "max-content" }}>
						{widestInline && (
							<div className="pw-sdiff-sizer" aria-hidden>
								<span className="pw-fdiff-gutter" style={{ width: `${width * 2 + 3}ch` }} />
								<span className="pw-fdiff-sign">+</span>
								<span className="pw-fdiff-text">{`${widestInline}    `}</span>
							</div>
						)}
						{rows.slice(start, end).map((row, i) => {
							const rowIndex = start + i;
							const top = rowIndex * ROW_H;
							if (row.kind === "fold") {
								return (
									<button
										key={`f${row.from}`}
										type="button"
										className="pw-fdiff-fold"
										style={{ top }}
										onClick={() => setUnfolded((s) => new Set(s).add(row.from))}
									>
										<span className="pw-fdiff-fold-label">{t.viewerFoldedLines.replace("{n}", String(row.count))}</span>
									</button>
								);
							}
							const l = row.line;
							const h = html(l.text);
							const hunkStart = blockByStartRow.get(rowIndex);
							const segs = wordDiff.get(row.index);
							return (
								<div key={row.index} className="pw-fdiff-row" data-kind={l.kind} style={{ top }}>
									<span className="pw-fdiff-gutter" style={{ width: `${width * 2 + 3}ch` }}>
										<span>{l.kind === "add" ? "" : String(l.old ?? "").padStart(width)}</span>
										<span>{l.kind === "del" ? "" : String(l.new ?? "").padStart(width)}</span>
									</span>
									<span className="pw-fdiff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
									<span className="pw-fdiff-text hljs">{renderLineContent(l.text, l.kind, h, segs)}</span>
									{hunkStart && hunkAction && (
										<button
											type="button"
											className="pw-hunk-check pw-hunk-check-inline"
											data-checked={hunkAction.checked || undefined}
											disabled={hunkAction.busyBlock === hunkStart.index}
											aria-label={`${hunkAction.label} #${hunkStart.index + 1}`}
											title={hunkAction.label}
											onClick={() => hunkAction.onToggle(hunkStart.index, hunkStart.anchor)}
										>
											{hunkAction.checked ? "✓" : ""}
										</button>
									)}
								</div>
							);
						})}
					</div>
				</div>
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
	}

	// 并排（Split）双栏模式
	const { leftRows, rightRows, blocks } = splitModel!;
	const leftStart = Math.max(0, Math.floor(splitVp.leftTop / ROW_H) - OVERSCAN);
	const leftEnd = Math.min(leftRows.length, Math.ceil((splitVp.leftTop + splitVp.height) / ROW_H) + OVERSCAN);
	const rightStart = Math.max(0, Math.floor(splitVp.rightTop / ROW_H) - OVERSCAN);
	const rightEnd = Math.min(rightRows.length, Math.ceil((splitVp.rightTop + splitVp.height) / ROW_H) + OVERSCAN);

	const blockEnds = (b: SplitBlock) => {
		const rawL = b.leftStartRow * ROW_H - splitVp.leftTop;
		const rawR = b.rightStartRow * ROW_H - splitVp.rightTop;
		const yL1 = b.anchor.delCount === 0 && b.leftStartRow > 0 ? rawL - 1 : rawL;
		const yL2 = b.anchor.delCount === 0 ? yL1 + 2 : b.leftEndRow * ROW_H - splitVp.leftTop;
		const yR1 = b.anchor.addCount === 0 && b.rightStartRow > 0 ? rawR - 1 : rawR;
		const yR2 = b.anchor.addCount === 0 ? yR1 + 2 : b.rightEndRow * ROW_H - splitVp.rightTop;
		return { yL1, yL2, yR1, yR2 };
	};
	const fmt = (n: number) => Number(n.toFixed(2));
	const visibleBlocks = blocks.filter((b) => {
		const { yL1, yL2, yR1, yR2 } = blockEnds(b);
		const minY = Math.min(yL1, yR1);
		const maxY = Math.max(yL2, yR2);
		return maxY >= -40 && minY <= splitVp.height + 40;
	});
	const cancelProgrammaticLock = () => { programmaticUntilRef.current = 0; };

	return (
		<div className="pw-fdiff pw-sdiff relative flex min-h-0 flex-1 flex-col" data-layout="split" data-testid="split-diff">
			{(leftLabel || rightLabel) && (
				<div className="pw-sdiff-head hairline-b">
					<div className="pw-sdiff-head-side">{leftLabel}</div>
					<div className="pw-sdiff-head-bridge" style={{ width: BRIDGE_WIDTH }} />
					<div className="pw-sdiff-head-side">{rightLabel}</div>
				</div>
			)}
			<div className="relative flex min-h-0 flex-1">
				{/* 左侧：旧版本，行号贴近中间连接槽 */}
				<div
					ref={leftScrollRef}
					className="pw-sdiff-pane pw-sdiff-left min-w-0 flex-1 overflow-auto"
					onWheel={cancelProgrammaticLock}
					onPointerDown={cancelProgrammaticLock}
					onScroll={() => handleSplitScroll("left")}
				>
					<div style={{ height: leftRows.length * ROW_H, position: "relative", minWidth: "100%", width: "max-content" }}>
						{widestLeft && (
							<div className="pw-sdiff-sizer" aria-hidden>
								<span className="pw-fdiff-sign pw-sdiff-sign"> </span>
								<span className="pw-fdiff-text">{`${widestLeft}    `}</span>
								<span className="pw-sdiff-num pw-sdiff-num-left" style={{ width: `${width + 2}ch` }} />
							</div>
						)}
						{leftRows.slice(leftStart, leftEnd).map((row, i) => {
							const top = (leftStart + i) * ROW_H;
							if (row.kind === "fold") {
								return (
									<button
										key={`lf${row.from}`}
										type="button"
										className="pw-fdiff-fold"
										style={{ top }}
										onClick={() => setUnfolded((s) => new Set(s).add(row.from))}
									>
										<span className="pw-fdiff-fold-label">{t.viewerFoldedLines.replace("{n}", String(row.count))}</span>
									</button>
								);
							}
							const l = row.line;
							const h = html(l.text);
							const segs = wordDiff.get(row.index);
							return (
								<div key={`l${row.index}`} className="pw-fdiff-row pw-sdiff-row" data-kind={l.kind} style={{ top }}>
									<span className="pw-fdiff-sign pw-sdiff-sign">{l.kind === "del" ? "-" : " "}</span>
									<span className="pw-fdiff-text hljs">{renderLineContent(l.text, l.kind, h, segs)}</span>
									<span className="pw-sdiff-num pw-sdiff-num-left" style={{ width: `${width + 2}ch` }}>
										{String(l.old ?? "").padStart(width)}
									</span>
								</div>
							);
						})}
					</div>
				</div>

				{/* 中间连接桥：SVG 贝塞尔曲线 + 块级勾选控件 */}
				<div ref={bridgeRef} className="pw-sdiff-bridge relative flex-none select-none overflow-hidden" style={{ width: BRIDGE_WIDTH }}>
					<svg
						className="pw-sdiff-svg"
						width={Math.max(1, splitVp.width)}
						height={Math.max(1, splitVp.height)}
						viewBox={`0 0 ${Math.max(1, splitVp.width)} ${Math.max(1, splitVp.height)}`}
						preserveAspectRatio="none"
						aria-hidden
					>
						{visibleBlocks.map((b) => {
							const { yL1, yL2, yR1, yR2 } = blockEnds(b);
							const svgW = Math.max(1, splitVp.width);
							const c1 = fmt(svgW * 0.45);
							const c2 = fmt(svgW * 0.55);
							const d = `M 0 ${fmt(yL1)} C ${c1} ${fmt(yL1)}, ${c2} ${fmt(yR1)}, ${svgW} ${fmt(yR1)} L ${svgW} ${fmt(yR2)} C ${c2} ${fmt(yR2)}, ${c1} ${fmt(yL2)}, 0 ${fmt(yL2)} Z`;
							return (
								<path
									key={b.index}
									d={d}
									className="pw-sdiff-ribbon"
									data-kind={b.kind}
									data-current={b.index === current || undefined}
								/>
							);
						})}
					</svg>
					{hunkAction && visibleBlocks.map((b) => {
						const { yL1, yL2, yR1, yR2 } = blockEnds(b);
						if (Math.max(yL2, yR2) < 10 || Math.min(yL1, yR1) > splitVp.height - 6) return null;
						const midTop = (yL1 + yR1) / 2;
						const midBot = (yL2 + yR2) / 2;
						const idealTop = midBot - midTop <= 36 ? Math.round((midTop + midBot) / 2 - 9) : Math.round(midTop + 2);
						const maxTop = Math.max(2, Math.min(splitVp.height - 20, Math.round(Math.max(yL2, yR2) - 18)));
						const top = Math.max(2, Math.min(maxTop, idealTop));
						return (
							<button
								key={`h${b.index}`}
								type="button"
								className="pw-hunk-check"
								data-checked={hunkAction.checked || undefined}
								disabled={hunkAction.busyBlock === b.index}
								style={{ top }}
								aria-label={`${hunkAction.label} #${b.index + 1}`}
								title={hunkAction.label}
								onClick={() => hunkAction.onToggle(b.index, b.anchor)}
							>
								{hunkAction.checked ? "✓" : ""}
							</button>
						);
					})}
				</div>

				{/* 右侧：新版本，行号贴近中间连接槽 */}
				<div
					ref={rightScrollRef}
					className="pw-sdiff-pane pw-sdiff-right min-w-0 flex-1 overflow-auto"
					onWheel={cancelProgrammaticLock}
					onPointerDown={cancelProgrammaticLock}
					onScroll={() => handleSplitScroll("right")}
				>
					<div style={{ height: rightRows.length * ROW_H, position: "relative", minWidth: "100%", width: "max-content" }}>
						{widestRight && (
							<div className="pw-sdiff-sizer" aria-hidden>
								<span className="pw-sdiff-num pw-sdiff-num-right" style={{ width: `${width + 2}ch` }} />
								<span className="pw-fdiff-sign pw-sdiff-sign">+</span>
								<span className="pw-fdiff-text">{`${widestRight}    `}</span>
							</div>
						)}
						{rightRows.slice(rightStart, rightEnd).map((row, i) => {
							const top = (rightStart + i) * ROW_H;
							if (row.kind === "fold") {
								return (
									<button
										key={`rf${row.from}`}
										type="button"
										className="pw-fdiff-fold"
										style={{ top }}
										onClick={() => setUnfolded((s) => new Set(s).add(row.from))}
									>
										<span className="pw-fdiff-fold-label">{t.viewerFoldedLines.replace("{n}", String(row.count))}</span>
									</button>
								);
							}
							const l = row.line;
							const h = html(l.text);
							const segs = wordDiff.get(row.index);
							return (
								<div key={`r${row.index}`} className="pw-fdiff-row pw-sdiff-row" data-kind={l.kind} style={{ top }}>
									<span className="pw-sdiff-num pw-sdiff-num-right" style={{ width: `${width + 2}ch` }}>
										{String(l.new ?? "").padStart(width)}
									</span>
									<span className="pw-fdiff-sign pw-sdiff-sign">{l.kind === "add" ? "+" : " "}</span>
									<span className="pw-fdiff-text hljs">{renderLineContent(l.text, l.kind, h, segs)}</span>
								</div>
							);
						})}
					</div>
				</div>

				{/* 改动位置刻度条 */}
				{rightRows.length > 0 && blocks.length > 0 && (
					<div className="pw-fdiff-ticks" aria-hidden>
						{blocks.map((blk, b) => (
							<span
								key={b}
								className="pw-fdiff-tick"
								data-kind={blk.kind === "mod" ? "add" : blk.kind}
								data-current={b === current || undefined}
								style={{ top: `${(blk.rightStartRow / rightRows.length) * 100}%` }}
								onClick={() => scrollToBlock(b)}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
});
