"use client";

/**
 * 对话视图 —— 照 dsh 会话流：思考链（◎ Think · 单行预览，点击展开）与
 * 工具调用（工具图标 + 名称 · 参数摘要，点击展开输出）内联交错；
 * 助手正文 markdown 渲染；消息操作行；统计条。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
	IconBrowseOutline14,
	IconCheckOutline14,
	IconCopyOutline16,
	IconDataOutline16,
	IconDislikeOutline16,
	IconEditOutline16,
	IconLikeOutline16,
	IconSearchOutline16,
	IconShareOutline16,
	IconTerminalOutline14,
	IconThinkOutline14,
} from "@/components/icons";
import { useI18n } from "@/i18n";
import type { ToolCardState } from "@/hooks/usePiWeb";
import type { ContextResource, WebMessage, WebStats } from "@/lib/types";

function copyText(text: string) {
	void navigator.clipboard?.writeText(text);
}

function hash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	return Math.abs(h).toString(36);
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="md">
			<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}>
				{text}
			</ReactMarkdown>
		</div>
	);
});

function MessageActions({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const [rating, setRating] = useState<"up" | "down" | null>(null);
	const { t } = useI18n();
	const key = `piweb.msg.${hash(text)}`;
	useEffect(() => {
		const v = localStorage.getItem(key);
		if (v === "up" || v === "down") setRating(v);
	}, [key]);
	const current = rating;
	return (
		<div className="msg-actions">
			<button
				className="icon-btn"
				title={t.copy}
				onClick={() => {
					copyText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				}}
			>
				{copied ? <IconCheckOutline14 size={14} /> : <IconCopyOutline16 size={14} />}
			</button>
			<button
				className="icon-btn"
				style={current === "up" ? { color: "var(--dsw-accent)" } : undefined}
				onClick={() => {
					const next = current === "up" ? null : "up";
					setRating(next);
					if (next) localStorage.setItem(key, next);
					else localStorage.removeItem(key);
				}}
			>
				<IconLikeOutline16 size={14} />
			</button>
			<button
				className="icon-btn"
				style={current === "down" ? { color: "var(--dsw-accent)" } : undefined}
				onClick={() => {
					const next = current === "down" ? null : "down";
					setRating(next);
					if (next) localStorage.setItem(key, next);
					else localStorage.removeItem(key);
				}}
			>
				<IconDislikeOutline16 size={14} />
			</button>
			<button className="icon-btn" title="share" onClick={() => copyText(text)}>
				<IconShareOutline16 size={14} />
			</button>
		</div>
	);
}

// ---------- 工具行（dsh 紧凑内联样式） ----------

function toolSummary(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	switch (name.toLowerCase()) {
		case "glob":
			return str(a.pattern) ?? "";
		case "grep":
			return [str(a.pattern), str(a.path)].filter(Boolean).join(" · ");
		case "find":
			return str(a.pattern) ?? str(a.path) ?? "";
		case "read":
		case "write":
		case "edit":
			return str(a.path) ?? str(a.file_path) ?? "";
		case "bash":
		case "powershell":
		case "pwsh":
			return (str(a.command) ?? "").split("\n")[0].slice(0, 120);
		default: {
			const first = Object.values(a).find((v) => typeof v === "string") as string | undefined;
			return (first ?? "").slice(0, 120);
		}
	}
}

function ToolIcon({ name }: { name: string }) {
	const n = name.toLowerCase();
	const props = { size: 14, style: { flex: "none" as const, color: "var(--dsw-label-tertiary)" } };
	if (n === "bash" || n === "powershell" || n === "pwsh") return <IconTerminalOutline14 {...props} />;
	if (n === "read") return <IconBrowseOutline14 {...props} />;
	if (n === "glob" || n === "grep" || n === "find" || n === "ls") return <IconSearchOutline16 {...props} />;
	if (n === "edit" || n === "write") return <IconEditOutline16 {...props} />;
	return <IconDataOutline16 {...props} />;
}

function ToolRow({ name, state }: { name: string; state?: ToolCardState }) {
	const [open, setOpen] = useState(false);
	if (!state) {
		// 参数尚未从事件到达（冷会话快照可能缺失）——仅渲染名字
		return (
			<div className="my-1 flex items-center gap-2" style={{ fontSize: 13.5 }}>
				<ToolIcon name={name} />
				<span style={{ color: "var(--dsw-label-primary)", fontWeight: 500 }}>{name}</span>
			</div>
		);
	}
	const running = state.state === "running";
	const summary = toolSummary(name, state.args);
	const output = state.result ?? state.partialResult ?? "";
	return (
		<div className="my-1">
			<button className="flex w-full items-center gap-2 py-0.5 text-left" onClick={() => output && setOpen((o) => !o)}>
				<ToolIcon name={name} />
				<span style={{ fontSize: 13.5, fontWeight: 500, color: state.isError ? "var(--dsw-danger)" : "var(--dsw-label-primary)" }}>
					{name}
				</span>
				{summary && (
					<>
						<span style={{ fontSize: 13, color: "var(--dsw-label-caption)", flex: "none" }}>·</span>
						<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, color: "var(--dsw-label-tertiary)" }}>
							{summary}
						</span>
					</>
				)}
				{running && <span className="state-dot running" style={{ width: 6, height: 6, flex: "none" }} />}
				{state.isError && !running && (
					<span style={{ fontSize: 11, color: "var(--dsw-danger)", flex: "none" }}>✕</span>
				)}
			</button>
			{open && output && (
				<pre
					className="ml-6 mt-1 max-h-64 overflow-auto rounded-xl px-3 py-2"
					style={{ background: "var(--dsw-hover)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55, color: "var(--dsw-label-secondary)" }}
				>
					{output}
				</pre>
			)}
		</div>
	);
}

// ---------- 思考行（dsh：◎ Think · 单行预览，点击展开） ----------

function ThinkRow({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const { lang } = useI18n();
	const oneLine = text.replace(/\s+/g, " ").trim();
	return (
		<div className="my-1">
			<button className="flex w-full items-baseline gap-2 py-0.5 text-left" onClick={() => setOpen((o) => !o)}>
				<IconThinkOutline14 size={13} style={{ flex: "none", color: "var(--dsw-label-tertiary)", alignSelf: "center" }} />
				<span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--dsw-label-primary)", flex: "none" }}>
					{lang === "zh" ? "思考" : "Think"}
				</span>
				<span style={{ fontSize: 13, color: "var(--dsw-label-caption)", flex: "none" }}>·</span>
				{!open && (
					<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, color: "var(--dsw-label-tertiary)" }}>
						{oneLine}
					</span>
				)}
			</button>
			{open && (
				<pre
					className="ml-6 mt-1 whitespace-pre-wrap rounded-xl px-3 py-2"
					style={{ background: "var(--dsw-hover)", fontSize: 12.5, lineHeight: 1.6, color: "var(--dsw-label-tertiary)", fontFamily: "inherit" }}
				>
					{text}
				</pre>
			)}
		</div>
	);
}

function ContextRow({ resource }: { resource: ContextResource | string }) {
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const normalized = typeof resource === "string"
		? { path: resource, content: "", source: "project" as const }
		: resource;
	return (
		<div className="my-1 min-w-0">
			<button
				type="button"
				className="flex w-full min-w-0 items-center gap-2 py-0.5 text-left"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<IconContextRow />
				<span style={{ flex: "none", fontSize: 13.5, fontWeight: 500, color: "var(--dsw-label-primary)" }}>
					{t.contextInject}
				</span>
				<span aria-hidden style={{ flex: "none", color: "var(--dsw-label-caption)", fontSize: 13 }}>·</span>
				<span
					className="min-w-0 flex-1 truncate"
					style={{ color: "var(--dsw-label-tertiary)", fontFamily: "var(--font-mono)", fontSize: 12.5 }}
					title={normalized.path}
				>
					{normalized.path}
				</span>
			</button>
			{open && normalized.content && (
				<pre
					className="ml-6 mt-1 max-h-[141px] overflow-auto whitespace-pre-wrap rounded-lg px-3 py-2.5"
					style={{
						background: "var(--dsw-markdown-code-block, var(--dsw-hover))",
						color: "var(--dsw-label-tertiary)",
						fontFamily: "var(--font-mono)",
						fontSize: 11,
						lineHeight: "16px",
					}}
				>
					{normalized.content}
				</pre>
			)}
		</div>
	);
}

function AssistantMessage({ message, tools }: { message: WebMessage; tools: Record<string, ToolCardState> }) {
	const textAll = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
	const isError = message.stopReason === "error";

	return (
		<div className="group w-full">
			{message.content.map((c, i) => {
				if (c.type === "thinking" && c.thinking.trim()) return <ThinkRow key={i} text={c.thinking} />;
				if (c.type === "toolCall") return <ToolRow key={`${c.id}-${i}`} name={c.name} state={tools[c.id]} />;
				if (c.type === "image")
					return <img key={i} src={`data:${c.mimeType};base64,${c.data}`} alt="" className="my-2 max-h-96 max-w-full rounded-2xl object-contain" />;
				if (c.type === "text" && c.text.trim())
					return (
						<div key={i} style={isError ? { color: "var(--dsw-danger)" } : undefined}>
							<Markdown text={c.text} />
						</div>
					);
				return null;
			})}
			{message.usage && (
				<div className="mt-1" style={{ fontSize: 11, color: "var(--dsw-label-caption)" }}>
					{message.provider && message.model ? `${message.provider}/${message.model} · ` : ""}
					↑{message.usage.input ?? 0} ↓{message.usage.output ?? 0}
				</div>
			)}
			{textAll && <MessageActions text={textAll} />}
		</div>
	);
}

function UserMessage({ message }: { message: WebMessage }) {
	const text = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = message.content.filter((content) => content.type === "image");
	const [copied, setCopied] = useState(false);
	return (
		<div className="group flex w-full flex-col items-end">
			{images.length > 0 && (
				<div className="mb-2 flex max-w-[85%] flex-wrap justify-end gap-2">
					{images.map((image, index) => (
						<img
							key={index}
							src={`data:${image.mimeType};base64,${image.data}`}
							alt=""
							className="max-h-72 max-w-full rounded-2xl object-contain"
							style={{ border: "0.5px solid var(--dsw-border-l2)" }}
						/>
					))}
				</div>
			)}
			{text && <div className="msg-user-bubble whitespace-pre-wrap">{text}</div>}
			{text && (
				<div className="msg-actions">
					<button
						className="icon-btn"
						onClick={() => {
							copyText(text);
							setCopied(true);
							setTimeout(() => setCopied(false), 1200);
						}}
					>
						{copied ? <IconCheckOutline14 size={14} /> : <IconCopyOutline16 size={14} />}
					</button>
				</div>
			)}
		</div>
	);
}

function fmtTok(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export function ChatWindow({
	messages,
	tools,
	stats,
	queue,
	contextFiles,
}: {
	messages: WebMessage[];
	tools: Record<string, ToolCardState>;
	stats: WebStats | null;
	queue: { steering: string[]; followUp: string[] };
	contextFiles?: Array<ContextResource | string>;
}) {
	const { t } = useI18n();
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);

	const rendered = useMemo(() => {
		const firstUser = messages.findIndex((message) => message.role === "user");
		return messages.flatMap((message, index) => {
			const row = message.role === "user"
				? <UserMessage key={`message-${index}`} message={message} />
				: message.role === "assistant"
					? <AssistantMessage key={`message-${index}`} message={message} tools={tools} />
					: null;
			if (index !== firstUser || !contextFiles?.length) return row ? [row] : [];
			return [
				...(row ? [row] : []),
				...contextFiles.map((resource, resourceIndex) => (
					<ContextRow
						key={`context-${typeof resource === "string" ? resource : `${resource.source}-${resource.path}`}-${resourceIndex}`}
						resource={resource}
					/>
				)),
			];
		});
	}, [contextFiles, messages, tools]);

	const turns = stats?.userMessages ?? 0;
	const calls = stats?.toolCalls ?? 0;
	const cost = stats?.cost ?? 0;
	const tokIn = stats?.tokens.input ?? 0;
	const tokOut = stats?.tokens.output ?? 0;
	const cache = stats?.tokens.cacheRead ?? 0;

	useEffect(() => {
		if (!stickToBottom.current) return;
		const frame = requestAnimationFrame(() => {
			const node = scrollRef.current;
			if (node) node.scrollTop = node.scrollHeight;
		});
		return () => cancelAnimationFrame(frame);
	}, [messages, tools, queue]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div
				ref={scrollRef}
				className="min-h-0 flex-1 overflow-y-auto"
				onScroll={(event) => {
					const node = event.currentTarget;
					stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
				}}
			>
				<div className="mx-auto flex w-full flex-col gap-4 px-4 py-6" style={{ maxWidth: "var(--dsh-chat-content-width)" }}>
					{rendered}
					{queue.steering.length + queue.followUp.length > 0 && (
						<div className="flex justify-end">
							<div
								className="rounded-full px-3 py-1"
								style={{ fontSize: 12, color: "var(--dsw-label-caption)", border: "0.5px dashed var(--dsw-border-l3)" }}
							>
								+{queue.steering.length + queue.followUp.length} queued
							</div>
						</div>
					)}
				</div>
			</div>
			{stats && (
				<div className="flex items-center justify-center gap-2 truncate px-4 pb-1" style={{ fontSize: 11, color: "var(--dsw-label-caption)" }}>
					<span>
						{turns} {t.turns} · {calls} {t.toolCalls}
					</span>
					<span style={{ opacity: 0.5 }}>|</span>
					<span>
						↑{fmtTok(tokIn)} tok · ↓{fmtTok(tokOut)} tok
					</span>
					<span style={{ opacity: 0.5 }}>|</span>
					<span>
						{t.cacheHits} {fmtTok(cache)}
					</span>
					<span style={{ opacity: 0.5 }}>|</span>
					<span>
						{t.cost} ${cost.toFixed(4)}
					</span>
				</div>
			)}
		</div>
	);
}

function IconContextRow() {
	return (
		<svg width={13} height={13} viewBox="0 0 16 16" fill="none" style={{ flex: "none" }}>
			<path
				d="M11.9512 1.13281C12.401 1.20666 12.8093 1.34164 13.1738 1.60645C13.4282 1.79137 13.6521 2.01609 13.8369 2.27051C14.1574 2.71187 14.2892 3.21614 14.3506 3.78223C14.4105 4.33532 14.4102 5.02658 14.4102 5.87305V10.0273C14.4102 10.8738 14.4105 11.5651 14.3506 12.1182C14.2892 12.6843 14.1574 13.1885 13.8369 13.6299C13.652 13.8843 13.4282 14.109 13.1738 14.2939C12.7324 14.6146 12.2273 14.7462 11.6611 14.8076C11.1081 14.8675 10.4166 14.8672 9.57031 14.8672H6.43164C5.58533 14.8672 4.89387 14.8675 4.34082 14.8076C3.77474 14.7463 3.27046 14.6144 2.8291 14.2939C2.57453 14.109 2.35003 13.8844 2.16504 13.6299C1.84444 13.1885 1.71272 12.6844 1.65137 12.1182C1.59147 11.5651 1.5918 10.8738 1.5918 10.0273V5.87305C1.5918 5.02655 1.59146 4.33533 1.65137 3.78223C1.71272 3.21606 1.84443 2.71191 2.16504 2.27051C2.35003 2.01596 2.57453 1.79141 2.8291 1.60645C3.19332 1.34202 3.60062 1.20669 4.0498 1.13281V2.56445C3.87191 2.61154 3.74906 2.66836 3.65137 2.73926C3.51583 2.83777 3.3964 2.95726 3.29785 3.09277C3.1794 3.25581 3.09143 3.4856 3.04297 3.93262C2.9931 4.39287 2.99219 4.99529 2.99219 5.87305V10.0273C2.99219 10.905 2.99312 11.5075 3.04297 11.9678C3.09142 12.4147 3.17943 12.6446 3.29785 12.8076C3.3964 12.9431 3.51583 13.0626 3.65137 13.1611C3.81441 13.2795 4.04437 13.3676 4.49121 13.416C4.95142 13.4658 5.55411 13.4668 6.43164 13.4668H9.57031C10.4479 13.4668 11.0505 13.4659 11.5107 13.416C11.9576 13.3675 12.1876 13.2796 12.3506 13.1611C12.4861 13.0626 12.6056 12.9431 12.7041 12.8076C12.8224 12.6446 12.9106 12.4146 12.959 11.9678C13.0088 11.5075 13.0098 10.905 13.0098 10.0273V5.87305C13.0098 4.99532 13.0088 4.39286 12.959 3.93262C12.9105 3.48579 12.8225 3.2558 12.7041 3.09277C12.6056 2.95727 12.4861 2.83778 12.3506 2.73926C12.2527 2.66816 12.1296 2.61064 11.9512 2.56348V1.13281Z"
				fill="currentColor"
			/>
			<path d="M9.32227 11.4141H4.95508V10.2148H9.32227V11.4141Z" fill="currentColor" />
			<path d="M11.0439 8.90039H4.95508V7.70117H11.0439V8.90039Z" fill="currentColor" />
			<path
				d="M8.59961 3.75781L9.70996 2.64746L10.5586 3.49609L8.49512 5.55957C8.22173 5.83266 7.77816 5.83285 7.50488 5.55957L5.44141 3.49512L6.28906 2.64746L7.40039 3.75781V1.09668H8.59961V3.75781Z"
				fill="currentColor"
			/>
		</svg>
	);
}
