"use client";

/**
 * Markdown 正文渲染（消息、流式回答、用户气泡共用）。
 *
 * 单独成模块是为了让它成为**懒加载分块**：react-markdown + remark-gfm + rehype-highlight
 * 带着 lowlight/highlight.js 的常用语言集，实测占首屏 JS 的 472KB（全部首屏 JS 1272KB），
 * 而 Hero 页（还没开会话）根本用不到它。ChatWindow 用 next/dynamic 引用本模块，
 * 首屏不再下载这 472KB；AppShell 在空闲时预取，真正打开会话时通常已经就绪。
 */
import { memo, useEffect, useState } from "react";
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

export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
	return (
		<div className="md">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
				components={{
					a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
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
	useEffect(() => {
		if (text === shown) return;
		const timer = setTimeout(() => setShown(text), STREAM_MARKDOWN_THROTTLE_MS);
		return () => clearTimeout(timer);
	}, [text, shown]);
	return <MarkdownBlock text={shown} />;
});

export default MarkdownBlock;
