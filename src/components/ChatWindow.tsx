"use client";

/**
 * 对话视图 —— 过程步骤。
 * 每个回合 = 用户消息 → 过程（叙述句是阶段标题，其下是带图标的步骤列表）→ 最终回答。
 * 进行中的思考 / 命令用闪光渐变的英文状态词；回合结束后思考与命令折成一行摘要，编辑保留 diff。
 */
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
	IconBranchOutline16,
	IconBrowseOutline14,
	IconCheckOutline14,
	IconChevronRight14,
	IconClockOutline16,
	IconCloseOutline14,
	IconCopyOutline16,
	IconDataOutline16,
	IconEditOutline16,
	IconFileOutline16,
	IconRefreshOutline14,
	IconSearchOutline16,
	IconSendArrowUp14,
	IconTerminalOutline14,
	IconThinkOutline14,
	IconWarningOutline16,
} from "@/components/icons";
import { DiffView, type DiffLine, parseUnifiedDiff } from "@/components/DiffView";
import { languageForPath } from "@/lib/highlight";
import { copyText } from "@/lib/clipboard";
import { OutlineRail } from "@/components/OutlineRail";
import { useI18n } from "@/i18n";
import type { ToolCardState } from "@/hooks/usePiWeb";
import type { ContextResource, TrajEntry, TrajTokens, WebContent, WebMessage, WebStats } from "@/lib/types";
import {
	classifyModelError,
	cleanCommand,
	deleteTargetOf,
	displayToolName,
	firstSentence,
	isDeleteCommand,
	langOfPath,
	previewSide,
	relativizeInText,
	relativizePath,
	splitLines,
	toolKind,
	trimNoiseTail,
	type ModelErrorKind,
	type ToolKind,
} from "@/lib/process-format";

type Dict = Record<string, string>;
type ToolCallContent = Extract<WebContent, { type: "toolCall" }>;


/** dsh message-chrome formatRunDuration：整秒，分钟档秒数补零 */
function formatRunDuration(ms: number, t: Dict): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes > 0
		? t.durationMinutes.replace("{minutes}", String(minutes)).replace("{seconds}", String(seconds).padStart(2, "0"))
		: t.durationSeconds.replace("{seconds}", String(seconds));
}

/** dsh message-chrome formatMessageClock 的月日精度版：恒显示 M月d日，跨年补年 */
function formatMessageClock(time: number, t: Dict): string {
	const d = new Date(time);
	const n = new Date();
	const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	const md = d.getFullYear() === n.getFullYear()
		? t.clockMd.replace("{m}", String(d.getMonth() + 1)).replace("{d}", String(d.getDate()))
		: t.clockYmd.replace("{y}", String(d.getFullYear())).replace("{m}", String(d.getMonth() + 1)).replace("{d}", String(d.getDate()));
	return `${md} ${clock}`;
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="md">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
				components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});


/**
 * 流式正文：边流边按 Markdown 渲染（标题/列表/代码块在生成过程中就成形）。
 *
 * 不是每个 delta 都重解析整段——那样会随回答变长线性变慢；这里按 ~100ms 节流，
 * 只在最新文本稳定下来时才交给 Markdown，回合结束时外层会切到精确的最终渲染。
 */
const STREAM_MARKDOWN_THROTTLE_MS = 100;

const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
	const [shown, setShown] = useState(text);
	useEffect(() => {
		if (text === shown) return;
		const timer = setTimeout(() => setShown(text), STREAM_MARKDOWN_THROTTLE_MS);
		return () => clearTimeout(timer);
	}, [text, shown]);
	return <Markdown text={shown} />;
});

/** dsh TurnTimePanel 的简化版：耗时胶囊常驻，点击弹层看本回合 token 用量 */
function TurnMetaPill({ durationMs, usage, t }: { durationMs: number; usage?: TrajTokens & { cost?: { total?: number } }; t: Dict }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const h = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [open]);
	const billed = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
	const hasUsage = usage != null && (billed > 0 || (usage.output ?? 0) > 0);
	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				className="flex items-center gap-1 rounded-full px-2"
				style={{ height: 22, fontSize: "var(--piweb-chat-font-xs)", color: "var(--dsw-label-caption)" }}
				title={t.turnUsageTitle}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<IconClockOutline16 size={13} style={{ flex: "none" }} />
				<span style={{ whiteSpace: "nowrap" }}>{t.turnRanFor.replace("{duration}", formatRunDuration(durationMs, t))}</span>
			</button>
			{open && (
				<div className="popover absolute left-0 top-full z-50 mt-1.5 w-44 p-3" role="dialog" aria-label={t.turnUsageTitle}>
					<div className="flex flex-col gap-1" style={{ fontSize: "var(--piweb-chat-font-t)", color: "var(--dsw-label-secondary)" }}>
						<div className="flex items-center justify-between gap-2">
							<span style={{ color: "var(--dsw-label-caption)" }}>{t.duration}</span>
							<span>{formatRunDuration(durationMs, t)}</span>
						</div>
						{hasUsage && (
							<>
								<div className="flex items-center justify-between gap-2">
									<span style={{ color: "var(--dsw-label-caption)" }}>{t.inputTokens}</span>
									<span>{fmtTok(billed)}</span>
								</div>
								<div className="flex items-center justify-between gap-2">
									<span style={{ color: "var(--dsw-label-caption)" }}>{t.outputTokens}</span>
									<span>{fmtTok(usage.output ?? 0)}</span>
								</div>
								{(usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0 && (
									<div className="flex items-center justify-between gap-2">
										<span style={{ color: "var(--dsw-label-caption)" }}>{t.cacheHits}</span>
										<span>{Math.round(((usage.cacheRead ?? 0) / Math.max(billed, 1)) * 100)}%</span>
									</div>
								)}
							</>
						)}
						{usage?.cost?.total != null && usage.cost.total > 0 && (
							<div className="flex items-center justify-between gap-2">
								<span style={{ color: "var(--dsw-label-caption)" }}>{t.cost}</span>
								<span>${usage.cost.total.toFixed(4)}</span>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function MessageActions({
	text,
	onFork,
	onEdit,
	durationMs,
	usage,
	time,
	clockStart = false,
}: {
	text: string;
	onFork?: () => void | Promise<unknown>;
	/** 用户消息：原地编辑后重新发送（模型从这条消息重新回答） */
	onEdit?: () => void;
	/** 回合墙钟耗时（最终回答时间戳 − 回合首条用户消息时间戳），dsh runMs 的对应物 */
	durationMs?: number;
	usage?: TrajTokens & { cost?: { total?: number } };
	/** 消息时间戳，驱动时钟；undefined 时不显示时钟 */
	time?: number;
	/** 用户消息时钟在图标左侧（dsh clock=start），助手在行尾（clock=end） */
	clockStart?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);
	const [forking, setForking] = useState(false);
	const { t } = useI18n();
	const clock = time === undefined ? null : (
		<span className={`msg-clock ${clockStart ? "msg-clock-start" : ""}`} style={{ whiteSpace: "nowrap" }} suppressHydrationWarning>
			{formatMessageClock(time, t)}
		</span>
	);
	return (
		<div className="msg-actions">
			{clockStart && clock}
			<button
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
			{onEdit && (
				<button className="icon-btn" title={t.editMessage} aria-label={t.editMessage} onClick={onEdit}>
					<IconEditOutline16 size={14} />
				</button>
			)}
			{onFork && (
				<button
					className="icon-btn"
					title={t.forkSession}
					aria-label={t.forkSession}
					disabled={forking}
					style={{ opacity: forking ? 0.6 : undefined }}
					onClick={() => {
						if (forking) return;
						// 分支要等服务端建新会话再切换，进行中旋转反馈并防重复点击
						setForking(true);
						void Promise.resolve(onFork()).finally(() => setForking(false));
					}}
				>
					<span className={forking ? "piweb-spin" : undefined} style={{ display: "inline-flex" }}>
						<IconBranchOutline16 size={14} />
					</span>
				</button>
			)}
			{durationMs !== undefined && <TurnMetaPill durationMs={durationMs} usage={usage} t={t} />}
			{!clockStart && clock}
		</div>
	);
}

// ---------- 过程步骤（Pi 版）----------
// 叙述句是阶段标题（基线对齐，主色），其下是带图标的步骤列表（Grok 的图标步骤 + Codex 的一行一命令）；
// 进行中的思考 / 命令用闪光渐变的英文状态词；回合结束后每个阶段下的思考与命令折成一行
// 「思考了 1m 12s，运行了 6 条命令」（Claude Code 的折叠摘要），编辑文件保留 diff；末尾 π 记号做工作指示。没有连线。

const MONO = "var(--font-mono)";
const RAIL = "⎿";
/** 命令输出默认露出的行数 */
const PREVIEW_LINES = 3;
/** 写入 / 编辑默认露出的 diff 行数 */
const DIFF_PREVIEW = 12;
/** 进行中的状态词：Claude Code 同款用法，闪光渐变，按用户要求用英文（两种界面语言都一样） */
const WORKING_VERBS = ["Thinking", "Pondering", "Cogitating", "Mulling", "Percolating", "Brewing", "Simmering", "Ruminating", "Synthesizing", "Noodling", "Marinating", "Crafting"];
/** 有步骤在闪光时 π 行只报时长；这行和状态词一样固定英文，不随界面语言变 */
const WORKING_FOR = "Working for {d}";

/** 每秒刷新一次的已用时长（仅在 active 时计时） */
function useElapsed(startedAt: number | undefined, active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return startedAt ? Math.max(0, now - startedAt) : 0;
}

/** 58s / 6m 8s / 2h 2m 3s */
function fmtSpan(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m ${s % 60}s`;
}

type StepTone = "dim" | "live" | "fail" | "warn";
type StepKind = ToolKind | "think" | "summary" | "context" | "error" | "abort" | "retry" | "work";

function KindIcon({ kind }: { kind: StepKind }) {
	const p = { size: 14, style: { flex: "none" as const } };
	switch (kind) {
		case "cmd":
			return <IconTerminalOutline14 {...p} />;
		case "read":
			return <IconBrowseOutline14 {...p} />;
		case "search":
			return <IconSearchOutline16 {...p} />;
		case "write":
			return <IconEditOutline16 {...p} />;
		case "think":
		case "summary":
			return <IconThinkOutline14 {...p} />;
		case "context":
			return <IconFileOutline16 {...p} />;
		case "error":
			return <IconWarningOutline16 {...p} />;
		case "abort":
			return <IconCloseOutline14 {...p} />;
		case "retry":
			return <IconRefreshOutline14 {...p} />;
		case "work":
			return <span className="pw-pi" aria-hidden>π</span>;
		default:
			return <IconDataOutline16 {...p} />;
	}
}

function Step({ kind, tone = "dim", live, className, children }: { kind: StepKind; tone?: StepTone; live?: boolean; className?: string; children: ReactNode }) {
	return (
		<div className={className ? `pw-step ${className}` : "pw-step"} data-kind={kind} data-tone={tone} data-live={live || undefined}>
			<span className="pw-icon" aria-hidden>
				<KindIcon kind={kind} />
			</span>
			<div className="pw-body">{children}</div>
		</div>
	);
}

/** 把模板里的 {n}/{d} 占位换成加粗的值（摘要行里数字加粗，像 Claude Code） */
function fillBold(template: string, values: Record<string, string>): ReactNode[] {
	const out: ReactNode[] = [];
	const re = /\{(\w+)\}/g;
	let last = 0;
	let m: RegExpExecArray | null;
	let i = 0;
	while ((m = re.exec(template))) {
		if (m.index > last) out.push(template.slice(last, m.index));
		out.push(<strong key={i++}>{values[m[1]] ?? ""}</strong>);
		last = m.index + m[0].length;
	}
	if (last < template.length) out.push(template.slice(last));
	return out;
}

// ---------- 工具步骤 ----------

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** 工具参数摘要：命令去掉 cd 工作区前缀与分隔用的 echo、路径相对于工作区 */
function toolSummary(name: string, args: unknown, cwd?: string): { text: string; scriptLines: number } {
	const a = (args ?? {}) as Record<string, unknown>;
	const n = name.toLowerCase();
	const kind = toolKind(name);
	const rel = (v: unknown) => {
		const s = str(v);
		return s ? relativizePath(s, cwd) : "";
	};
	if (kind === "cmd") {
		const c = cleanCommand(str(a.command) ?? str(a.cmd) ?? str(a.script) ?? "", cwd);
		return { text: c.text, scriptLines: c.lines };
	}
	if (n === "grep" || n === "glob" || n === "find") return { text: [str(a.pattern), rel(a.path)].filter(Boolean).join("  "), scriptLines: 0 };
	if (kind === "read" || kind === "write" || n === "ls") return { text: rel(a.path ?? a.file_path), scriptLines: 0 };
	const first = Object.values(a).find((v) => typeof v === "string") as string | undefined;
	return { text: (first ?? "").replace(/\s+/g, " ").slice(0, 160), scriptLines: 0 };
}

type Preview = { head?: string; lines: string[]; hidden: number; side?: "head" | "tail" };

/** ⎿ 结果预览：查看类命令看开头、构建测试类看结尾，搜索给条数，读取给行数 */
function toolPreview(kind: ToolKind, state: ToolCardState, t: Dict, cwd?: string): Preview {
	const running = state.state === "running";
	const raw = (state.result ?? state.partialResult ?? "").replace(/\r/g, "");
	const exitMatch = raw.match(/Command exited with code (\d+)/);
	const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
	const body = splitLines(raw).filter((l) => !/^Command exited with code \d+/.test(l));
	const count = (k: string, v: number) => t[k].replace("{n}", String(v));
	const rel = (lines: string[]) => (cwd ? lines.map((l) => relativizeInText(l, cwd)) : lines);
	const tailBody = trimNoiseTail(body);
	const tail = (n: number): Preview => ({ lines: rel(tailBody.slice(-n)), hidden: Math.max(0, body.length - Math.min(n, tailBody.length)), side: "tail" });
	const head = (n: number): Preview => ({ lines: rel(body.slice(0, n)), hidden: Math.max(0, body.length - n), side: "head" });
	const none: Preview = { lines: [], hidden: 0 };
	const a = state.args as Record<string, unknown> | undefined;
	const command = kind === "cmd" ? (str(a?.command) ?? str(a?.cmd) ?? str(a?.script) ?? "") : "";
	const byCmd = (n: number) => (previewSide(cleanCommand(command, cwd).text) === "head" ? head(n) : tail(n));
	if (running) return kind === "cmd" && body.length ? tail(PREVIEW_LINES) : none;
	if (state.isError) {
		const h = exitCode !== undefined && exitCode !== 0 ? `${t.toolFailed} · ${t.toolExit.replace("{code}", String(exitCode))}` : t.toolFailed;
		return { head: h, ...(kind === "cmd" ? tail(4) : head(4)) };
	}
	switch (kind) {
		case "read": {
			const lang = langOfPath(str(a?.path ?? a?.file_path) ?? "");
			return { head: body.length ? `${count("resultRead", body.length)}${lang ? ` · ${lang}` : ""}` : t.toolNoOutput, lines: [], hidden: 0 };
		}
		case "search":
			return body.length ? { head: count("resultFound", body.length), ...head(PREVIEW_LINES) } : { head: t.toolNoOutput, lines: [], hidden: 0 };
		case "cmd": {
			const h = exitCode !== undefined && exitCode !== 0 ? t.toolExit.replace("{code}", String(exitCode)) : undefined;
			if (!body.length) return { head: h ?? t.toolNoOutput, lines: [], hidden: 0 };
			return { head: h, ...byCmd(PREVIEW_LINES) };
		}
		case "write":
			return none;
		default:
			return body.length ? head(2) : { head: t.toolNoOutput, lines: [], hidden: 0 };
	}
}

function stepVerb(t: Dict, kind: ToolKind, name: string): string {
	const n = name.toLowerCase();
	if (kind === "cmd") return t.stepRan;
	if (kind === "read") return t.stepRead;
	if (kind === "search") return t.stepSearched;
	if (kind === "write") return n === "write" ? t.stepWrote : t.stepEdited;
	return displayToolName(name);
}

const ToolStep = memo(function ToolStep({
	id,
	name,
	args,
	state,
	cwd,
	onInspectTool,
	onOpenFile,
}: {
	id: string;
	name: string;
	args: unknown;
	state?: ToolCardState;
	cwd?: string;
	onInspectTool?: (toolCallId: string) => void;
	onOpenFile?: (path: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const tt = t as unknown as Dict;
	const kind = toolKind(name);
	const running = !state || state.state === "running";
	const elapsed = useElapsed(state?.startedAt, running);
	const output = state?.result ?? state?.partialResult ?? "";
	const isWriteTool = name.toLowerCase() === "write";
	const diff = useMemo(() => {
		// 失败的编辑同样渲染 diff：出错信息单独展示，不因为失败就把红绿藏掉
		if (kind !== "write" || !state || state.state !== "done") return null;
		const parsed = parseUnifiedDiff(state.patch || output);
		if (parsed) return parsed;
		// pi 的 write 工具不带 patch：新文件按新增行展示（全绿 +），与 edit 的 diff 口径一致
		if (isWriteTool) {
			const content = str((args as { content?: unknown } | undefined)?.content);
			if (content) return content.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((text, i): DiffLine => ({ kind: "add", new: i + 1, text }));
		}
		return null;
	}, [args, isWriteTool, kind, output, state]);
	const failed = Boolean(state?.isError) && !running;
	const summary = toolSummary(name, args, cwd);
	let argsTitle = summary.text;
	try {
		argsTitle = JSON.stringify(args, null, 2).slice(0, 2000);
	} catch {
		/* keep summary */
	}
	const argPath = (() => {
		if (kind !== "read" && kind !== "write") return "";
		const a = args as { path?: unknown; file_path?: unknown } | undefined;
		return str(a?.path ?? a?.file_path) ?? "";
	})();
	const fullCommand = kind === "cmd" ? (str((args as Record<string, unknown>)?.command) ?? str((args as Record<string, unknown>)?.cmd) ?? str((args as Record<string, unknown>)?.script) ?? "") : "";
	// 删除文件的命令：完成后给红色标记（内容级 diff 不强求）
	const deletedTarget = kind === "cmd" && !running && !failed && isDeleteCommand(fullCommand) ? deleteTargetOf(fullCommand) : "";
	const preview = state ? toolPreview(kind, state, tt, cwd) : { lines: [], hidden: 0 };
	const hasDiff = Boolean(diff && diff.length);
	const hasOutput = Boolean(output || state?.encodingLoss);
	const canExpand = hasOutput && !hasDiff && !running;
	const duration = state?.startedAt && state?.endedAt ? state.endedAt - state.startedAt : 0;
	const showPreview = Boolean(preview.head) || preview.lines.length > 0;
	// 失败且有 diff 时，出错信息要完整可见（此时 diff 占用了展开位）
	const showFullOutput = hasOutput && (open && canExpand || (failed && hasDiff));
	const diffLines = hasDiff && diff ? (open ? diff : diff.slice(0, DIFF_PREVIEW)) : null;
	const diffHidden = diff && diffLines && !open ? diff.length - diffLines.length : 0;
	const diffStat = hasDiff && diff
		? isWriteTool && !state?.patch
			? t.diffSummary.replace("{add}", String(diff.length)).replace("{del}", "0")
			: t.diffSummary.replace("{add}", String(diff.filter((l) => l.kind === "add").length)).replace("{del}", String(diff.filter((l) => l.kind === "del").length))
		: "";
	const toggle = () => setOpen((o) => !o);
	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			toggle();
		}
	};
	return (
		<Step kind={kind} tone={running ? "live" : failed ? "fail" : "dim"} live={running} className="group/tool">
			<div className="pw-line">
				{running ? <span className="pw-shimmer">{t.stepRunning}</span> : <span className="pw-verb" data-failed={failed || undefined}>{stepVerb(tt, kind, name)}</span>}
				{summary.text ? (
					<span className="pw-arg" title={argsTitle}>{summary.text}</span>
				) : (
					<span className="pw-arg" style={{ color: "var(--dsw-label-caption)" }}>{displayToolName(name)}</span>
				)}
				{diffStat && <span className="pw-meta">{diffStat}</span>}
				{deletedTarget && (
					<span className="pw-meta" style={{ color: "var(--dsw-danger)" }} title={deletedTarget}>
						{t.deletedFile.replace("{path}", relativizeInText(deletedTarget, cwd || ""))}
					</span>
				)}
				{summary.scriptLines > 1 && <span className="pw-meta">{t.commandLines.replace("{n}", String(summary.scriptLines))}</span>}
				{running && <span className="pw-meta">{fmtSpan(elapsed)}</span>}
				{!running && duration >= 1000 && <span className="pw-meta">{fmtSpan(duration)}</span>}
				{onOpenFile && argPath && (
					<button
						type="button"
						className="icon-btn opacity-0 group-hover/tool:opacity-100 focus-visible:opacity-100"
						style={{ width: 22, height: 22, flex: "none" }}
						title={t.fileOpenEditor}
						aria-label={t.fileOpenEditor}
						onClick={(e) => {
							e.stopPropagation();
							onOpenFile(argPath);
						}}
					>
						<IconFileOutline16 size={13} />
					</button>
				)}
				{onInspectTool && (
					<button
						type="button"
						className="icon-btn opacity-0 group-hover/tool:opacity-100 focus-visible:opacity-100"
						style={{ width: 22, height: 22, flex: "none" }}
						title={t.viewInTrajectory}
						aria-label={t.viewInTrajectory}
						onClick={(e) => {
							e.stopPropagation();
							onInspectTool(id);
						}}
					>
						<IconDataOutline16 size={13} />
					</button>
				)}
			</div>
			{showPreview && (
				<div
					className="pw-result"
					data-failed={failed || undefined}
					role={canExpand ? "button" : undefined}
					tabIndex={canExpand ? 0 : undefined}
					onClick={canExpand ? toggle : undefined}
					onKeyDown={canExpand ? onKey : undefined}
					title={canExpand ? (open ? t.collapseOutput : t.expandOutput) : undefined}
				>
					<span className="pw-rail">{RAIL}</span>
					<span className="pw-lines">
						{preview.head && <div className="pw-head">{preview.head}</div>}
						{!open && preview.side === "tail" && preview.hidden > 0 && <div className="pw-more">… {t.moreLines.replace("{n}", String(preview.hidden))}</div>}
						{!open && preview.lines.map((l, i) => <div key={i}>{l}</div>)}
						{!open && preview.side !== "tail" && preview.hidden > 0 && <div className="pw-more">… {t.moreLines.replace("{n}", String(preview.hidden))}</div>}
						{open && canExpand && <div className="pw-more">{t.collapseOutput}</div>}
					</span>
				</div>
			)}
			{diffLines && diffLines.length > 0 && (
				<div className="pw-diff">
					<DiffView lines={diffLines} language={languageForPath(argPath)} />
					{diffHidden > 0 && (
						<button type="button" className="pw-more" onClick={() => setOpen(true)}>
							… {t.moreLines.replace("{n}", String(diffHidden))}
						</button>
					)}
					{open && diff && diff.length > DIFF_PREVIEW && (
						<button type="button" className="pw-more" onClick={() => setOpen(false)}>
							{t.collapseOutput}
						</button>
					)}
				</div>
			)}
			{showFullOutput && (
				<div className="pw-output">
					{fullCommand && <div className="cmdline">{fullCommand}</div>}
					{state?.encodingLoss && <p className="mb-2 whitespace-normal" style={{ color: "var(--dsw-warn)" }}>{t.encodingLossWarning}</p>}
					{output && <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit" }}>{output}</pre>}
				</div>
			)}
		</Step>
	);
});

// ---------- 思考步骤：进行中闪光「Thinking…」+ 流动的两行尾巴；完成后收成首句 ----------

const ThinkStep = memo(function ThinkStep({ text, live, startedAt }: { text: string; live?: boolean; startedAt?: number }) {
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const elapsed = useElapsed(startedAt, Boolean(live));
	if (live) {
		const one = text.replace(/\s+/g, " ").trim();
		const tail = one.length > 220 ? `…${one.slice(-220)}` : one;
		return (
			<Step kind="think" tone="live" live>
				<div className="pw-line">
					<span className="pw-shimmer">{t.thinkingLive}…</span>
					{startedAt && elapsed >= 3000 ? <span className="pw-meta">{fmtSpan(elapsed)}</span> : null}
				</div>
				{tail && <div className="pw-tail">{tail}</div>}
			</Step>
		);
	}
	return (
		<Step kind="think">
			<button type="button" className="pw-line pw-clickable" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={t.thinkLabel}>
				<span className="pw-gist">{firstSentence(text, 140)}</span>
			</button>
			{open && <pre className="pw-output pw-think-full">{text}</pre>}
		</Step>
	);
});

// ---------- 叙述：模型在工具之间说的话，作为阶段标题（基线对齐，主色） ----------

const NarrationBlock = memo(function NarrationBlock({ text, live, error }: { text: string; live?: boolean; error?: boolean }) {
	return (
		<div className="pw-narr" data-error={error || undefined}>
			{live ? <StreamingMarkdown text={text} /> : <Markdown text={text} />}
		</div>
	);
});

// ---------- 模型错误 / 中止 / 自动重试 / 上下文注入 ----------

const ERROR_HINT_KEY: Record<ModelErrorKind, string> = {
	rateLimit: "modelErrorRateLimit",
	billing: "modelErrorBilling",
	auth: "modelErrorAuth",
	notFound: "modelErrorNotFound",
	context: "modelErrorContext",
	timeout: "modelErrorTimeout",
	server: "modelErrorServer",
	network: "modelErrorNetwork",
	moderation: "modelErrorModeration",
};

function ErrorStep({ message, count, model }: { message: string; count: number; model?: string }) {
	const { t } = useI18n();
	const tt = t as unknown as Dict;
	const kind = classifyModelError(message);
	const hint = kind ? tt[ERROR_HINT_KEY[kind]] : "";
	return (
		<Step kind="error" tone="warn">
			<div className="pw-line">
				<span className="pw-warn-text" title={message}>
					{t.modelError}: {message}
					{hint ? ` · ${hint}` : ""}
				</span>
				{count > 1 && <span className="pw-meta">{t.modelErrorTimes.replace("{n}", String(count))}</span>}
				{model && <span className="pw-meta">{model}</span>}
			</div>
		</Step>
	);
}

function AbortStep() {
	const { t } = useI18n();
	return (
		<Step kind="abort">
			<div className="pw-line">{t.turnAborted}</div>
		</Step>
	);
}

function RetryStep({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const oneLine = text.replace(/\s+/g, " ").trim();
	const [label, ...rest] = oneLine.split("：");
	return (
		<Step kind="retry" tone="warn" live>
			<button type="button" className="pw-line pw-clickable" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
				<span className="pw-verb" style={{ color: "var(--dsw-warn)" }}>{label}</span>
				{!open && rest.length > 0 && <span className="pw-gist">{rest.join("：")}</span>}
			</button>
			{open && <pre className="pw-output pw-think-full">{text}</pre>}
		</Step>
	);
}

function ContextStep({ resource, cwd }: { resource: ContextResource | string; cwd?: string }) {
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const normalized = typeof resource === "string" ? { path: resource, content: "", source: "project" as const } : resource;
	return (
		<Step kind="context">
			<button type="button" className="pw-line pw-clickable" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<span className="pw-verb">{t.contextInject}</span>
				<span className="pw-arg" title={normalized.path}>{relativizePath(normalized.path, cwd)}</span>
			</button>
			{open && normalized.content && <pre className="pw-output" style={{ maxHeight: 160 }}>{normalized.content}</pre>}
		</Step>
	);
}

// ---------- 工作指示：π 记号 + 英文状态词闪光（没有正在进行的步骤时）或「Working for 12s」；整行固定英文 ----------

function WorkingStep({ startedAt, outputTokens, workingMessage, hasLiveStep }: { startedAt: number; outputTokens?: number; workingMessage?: string | null; hasLiveStep: boolean }) {
	const elapsed = useElapsed(startedAt, true);
	const verb = WORKING_VERBS[Math.floor(elapsed / 3000) % WORKING_VERBS.length];
	// 扩展可以用 setWorkingMessage 覆盖这行文案（pi 终端同款能力）；有步骤在闪光时这里只报时长
	const label = workingMessage || (hasLiveStep ? null : `${verb}…`);
	return (
		<Step kind="work" tone="live" live>
			<div className="pw-line">
				{label ? <span className="pw-shimmer">{label}</span> : <span className="pw-verb">{fillBold(WORKING_FOR, { d: fmtSpan(elapsed) })}</span>}
				{label && <span className="pw-meta">{fmtSpan(elapsed)}</span>}
				{outputTokens ? <span className="pw-meta">↓ {fmtTok(outputTokens)} tokens</span> : null}
			</div>
		</Step>
	);
}

// ---------- 回合内容 → 步骤项；已完成回合把连续的思考 / 命令折成摘要行 ----------

type Item =
	| { kind: "think"; key: string; msgIndex: number; text: string; live: boolean; startedAt?: number }
	| { kind: "narr"; key: string; msgIndex: number; text: string; live: boolean; error: boolean }
	| { kind: "image"; key: string; msgIndex: number; data: string; mimeType: string }
	| { kind: "tool"; key: string; msgIndex: number; call: ToolCallContent; state?: ToolCardState }
	| { kind: "error"; key: string; msgIndex: number; message: string; count: number; model?: string }
	| { kind: "abort"; key: string; msgIndex: number };

type Run = { kind: "run"; key: string; items: Item[]; hasThink: boolean; cmds: number; reads: number; searches: number; durationMs?: number };
type Block = { kind: "item"; item: Item } | Run;

function buildItems(messages: WebMessage[], k: number, tools: Record<string, ToolCardState>, live: boolean, omitText: boolean, errorCount: number | undefined): Item[] {
	const message = messages[k];
	const lastIndex = message.content.length - 1;
	const isError = message.stopReason === "error";
	const items: Item[] = [];
	message.content.forEach((c, i) => {
		const key = `${k}-${i}`;
		if (c.type === "thinking" && c.thinking.trim()) items.push({ kind: "think", key, msgIndex: k, text: c.thinking, live: live && i === lastIndex, startedAt: message.timestamp });
		else if (c.type === "toolCall") items.push({ kind: "tool", key: `${key}-${c.id}`, msgIndex: k, call: c, state: tools[c.id] });
		else if (c.type === "text" && !omitText && c.text.trim()) items.push({ kind: "narr", key, msgIndex: k, text: c.text, live: live && i === lastIndex, error: isError });
		else if (c.type === "image" && !omitText) items.push({ kind: "image", key, msgIndex: k, data: c.data, mimeType: c.mimeType });
	});
	if (isError && (errorCount ?? 1) > 0) items.push({ kind: "error", key: `${k}-err`, msgIndex: k, message: message.errorMessage || message.stopReason || "error", count: errorCount ?? 1, model: message.model });
	if (message.stopReason === "aborted") items.push({ kind: "abort", key: `${k}-abort`, msgIndex: k });
	return items;
}

/** 可折进摘要的步骤：完成的思考，以及成功完成的命令 / 读取 / 搜索（编辑与写入永远单独可见） */
function isCollapsible(it: Item, finalIdx: number): boolean {
	if (it.msgIndex === finalIdx) return false;
	if (it.kind === "think") return !it.live;
	if (it.kind === "tool") {
		const s = it.state;
		if (!s || s.state !== "done" || s.isError) return false;
		const k = toolKind(it.call.name);
		return k === "cmd" || k === "read" || k === "search";
	}
	return false;
}

function collapseRuns(items: Item[], finalIdx: number, spanOf: (a: number, b: number) => number | undefined): Block[] {
	const blocks: Block[] = [];
	let i = 0;
	while (i < items.length) {
		if (!isCollapsible(items[i], finalIdx)) {
			blocks.push({ kind: "item", item: items[i] });
			i += 1;
			continue;
		}
		let j = i;
		while (j < items.length && isCollapsible(items[j], finalIdx)) j += 1;
		const run = items.slice(i, j);
		let cmds = 0;
		let reads = 0;
		let searches = 0;
		let hasThink = false;
		for (const it of run) {
			if (it.kind === "think") hasThink = true;
			else if (it.kind === "tool") {
				const k = toolKind(it.call.name);
				if (k === "cmd") cmds += 1;
				else if (k === "read") reads += 1;
				else searches += 1;
			}
		}
		const durationMs = spanOf(run[0].msgIndex, run[run.length - 1].msgIndex);
		if (cmds + reads + searches === 0 && durationMs === undefined) {
			for (const it of run) blocks.push({ kind: "item", item: it });
		} else {
			blocks.push({ kind: "run", key: `run-${run[0].key}`, items: run, hasThink, cmds, reads, searches, durationMs });
		}
		i = j;
	}
	return blocks;
}

function SummaryStep({ run, expanded, onToggle }: { run: Run; expanded: boolean; onToggle: () => void }) {
	const { t } = useI18n();
	const parts: ReactNode[][] = [];
	if (run.hasThink && run.durationMs !== undefined) parts.push(fillBold(t.sumThought, { d: fmtSpan(run.durationMs) }));
	if (run.cmds) parts.push(fillBold(run.cmds === 1 ? t.sumRan1 : t.sumRan, { n: String(run.cmds) }));
	if (run.reads) parts.push(fillBold(run.reads === 1 ? t.sumRead1 : t.sumRead, { n: String(run.reads) }));
	if (run.searches) parts.push(fillBold(run.searches === 1 ? t.sumSearched1 : t.sumSearched, { n: String(run.searches) }));
	// 英文时首字母大写（模板里只有第一段是大写开头）
	if (parts.length && typeof parts[0][0] === "string") parts[0][0] = (parts[0][0] as string).replace(/^[a-z]/, (ch) => ch.toUpperCase());
	return (
		<Step kind={run.hasThink ? "summary" : run.cmds ? "cmd" : run.reads ? "read" : "search"}>
			<button type="button" className="pw-line pw-clickable pw-summary" aria-expanded={expanded} onClick={onToggle}>
				<span className="pw-gist">
					{parts.map((p, i) => (
						<span key={i}>
							{i > 0 ? t.sumJoin : ""}
							{p}
						</span>
					))}
				</span>
				<IconChevronRight14 size={12} className="pw-chev" />
			</button>
		</Step>
	);
}

function ItemView({ item, cwd, onInspectTool, onOpenFile }: { item: Item; cwd?: string; onInspectTool?: (toolCallId: string) => void; onOpenFile?: (path: string) => void }) {
	switch (item.kind) {
		case "think":
			return <ThinkStep text={item.text} live={item.live} startedAt={item.startedAt} />;
		case "narr":
			return <NarrationBlock text={item.text} live={item.live} error={item.error} />;
		case "image":
			return (
				<div className="pw-narr">
					<img src={`data:${item.mimeType};base64,${item.data}`} alt="" className="my-1 max-h-96 max-w-full rounded-2xl object-contain" />
				</div>
			);
		case "tool":
			return <ToolStep id={item.call.id} name={item.call.name} args={item.call.arguments} state={item.state} cwd={cwd} onInspectTool={onInspectTool} onOpenFile={onOpenFile} />;
		case "error":
			return <ErrorStep message={item.message} count={item.count} model={item.model} />;
		case "abort":
			return <AbortStep />;
		default:
			return null;
	}
}

// ---------- 最终回答：过程之外、完整 Markdown、带操作行 ----------

const FinalAnswer = memo(function FinalAnswer({
	message,
	onFork,
	showActions,
	turnStartMs,
}: {
	message: WebMessage;
	onFork?: (entryId: string) => void;
	showActions: boolean;
	turnStartMs?: number;
}) {
	const textAll = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
	return (
		<div className="group w-full" style={{ marginTop: 14 }} data-role="assistant">
			{message.content.map((c, i) => {
				if (c.type === "text" && c.text.trim()) return <Markdown key={i} text={c.text} />;
				if (c.type === "image") return <img key={i} src={`data:${c.mimeType};base64,${c.data}`} alt="" className="my-2 max-h-96 max-w-full rounded-2xl object-contain" />;
				return null;
			})}
			{showActions && (
				<MessageActions
					text={textAll.trim()}
					onFork={message.id && onFork ? () => onFork(message.id!) : undefined}
					durationMs={(message.endedAt ?? message.timestamp) != null && turnStartMs != null ? Math.max(0, (message.endedAt ?? message.timestamp)! - turnStartMs) : undefined}
					usage={message.usage}
					time={message.timestamp}
				/>
			)}
		</div>
	);
});

/** 行级 memo：流式期间只有最后一条消息变化，历史行全部跳过重渲染 */
const UserMessage = memo(function UserMessage({ message, onEditMessage }: { message: WebMessage; onEditMessage?: (entryId: string, text: string) => void }) {
	const { t } = useI18n();
	const text = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = message.content.filter((content) => content.type === "image");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(text);
	const [editorWidth, setEditorWidth] = useState(132);
	const editRef = useRef<HTMLTextAreaElement>(null);
	const bubbleRef = useRef<HTMLDivElement>(null);
	const canEdit = Boolean(onEditMessage && message.id && text);
	useEffect(() => {
		if (!editing || !editRef.current) return;
		editRef.current.style.height = "0px";
		editRef.current.style.height = `${Math.min(320, editRef.current.scrollHeight)}px`;
	}, [draft, editing]);
	const imageStrip = images.length > 0 && (
		<div className="mb-2 flex max-w-[85%] flex-wrap justify-end gap-2">
			{images.map((image, index) => (
				<img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="" className="max-h-72 max-w-full rounded-2xl object-contain" style={{ border: "0.5px solid var(--dsw-border-l2)" }} />
			))}
		</div>
	);
	function beginEdit() {
		if (!canEdit) return;
		setEditorWidth(Math.max(132, Math.ceil(bubbleRef.current?.getBoundingClientRect().width ?? 132)));
		setDraft(text);
		setEditing(true);
	}
	if (editing) {
		return (
			<div className="group mt-7 flex w-full flex-col items-end first:mt-0" data-role="user">
				{imageStrip}
				<div className="msg-user-bubble pw-user-editor" style={{ width: editorWidth }}>
					<textarea
						ref={editRef}
						className="pw-user-editor-input"
						value={draft}
						aria-label={t.editMessage}
						autoFocus
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
						}}
					/>
					<div className="pw-user-editor-actions">
						<button type="button" className="pw-user-editor-cancel" aria-label={t.cancel} title={t.cancel} onClick={() => setEditing(false)}><IconCloseOutline14 size={14} /></button>
						<button type="button" className="pw-user-editor-send" aria-label={t.sendEdit} title={t.sendEdit} disabled={!draft.trim()} onClick={submit}><IconSendArrowUp14 size={15} /></button>
					</div>
				</div>
			</div>
		);
	}
	function submit() {
		const next = draft.trim();
		if (!next || !onEditMessage || !message.id) return;
		setEditing(false);
		onEditMessage(message.id, next);
	}
	return (
		// 回合边界：用户消息前留 28px（比回合内 8px 大得多），长对话里一眼找到“这一轮从哪开始”
		<div className="group mt-7 flex w-full flex-col items-end first:mt-0" data-role="user">
			{imageStrip}
			{/* 用户消息也走 Markdown：贴进来的代码块/列表不再是一坨纯文本 */}
			{text && <div ref={bubbleRef} className={`msg-user-bubble${canEdit ? " pw-user-message-clickable" : ""}`} onClick={canEdit ? (event) => {
				if ((event.target as HTMLElement).closest("a, button, input, textarea, [role='button']")) return;
				const selection = window.getSelection();
				if (selection && !selection.isCollapsed) return;
				beginEdit();
			} : undefined}><Markdown text={text} /></div>}
			{/* 用户消息：复制 + 原地编辑重发（编辑后模型从这条消息重新回答）；时钟在图标左侧（dsh clock=start） */}
			{text && (
				<MessageActions
					text={text}
					clockStart={message.timestamp !== undefined}
					time={message.timestamp}
					onEdit={canEdit ? beginEdit : undefined}
				/>
			)}
		</div>
	);
});

// ---------- 回合：用户消息 → 过程步骤 → 最终回答 ----------

type Turn = { key: string; userIndex: number; assistantIndexes: number[] };

function buildTurns(messages: WebMessage[]): Turn[] {
	const out: Turn[] = [];
	let cur: Turn | null = null;
	messages.forEach((m, i) => {
		if (m.role === "user") {
			cur = { key: `u${i}`, userIndex: i, assistantIndexes: [] };
			out.push(cur);
		} else if (m.role === "assistant") {
			if (!cur) {
				cur = { key: `a${i}`, userIndex: -1, assistantIndexes: [] };
				out.push(cur);
			}
			cur.assistantIndexes.push(i);
		}
	});
	return out;
}

/** 回合的最终回答：有正文、没有工具调用、且不是中途状态（toolUse / pending / error / aborted） */
function isFinalAnswer(m: WebMessage): boolean {
	const hasText = m.content.some((c) => c.type === "text" && c.text.trim());
	const hasTool = m.content.some((c) => c.type === "toolCall");
	const sr = m.stopReason ?? "stop";
	return hasText && !hasTool && sr !== "toolUse" && sr !== "pending" && sr !== "error" && sr !== "aborted";
}

function TurnBlockView({
	turn,
	messages,
	tools,
	cwd,
	isStreaming,
	isLast,
	lastAssistantIndex,
	contextFiles,
	retryNotice,
	streamStartedAt,
	runningTool,
	outputTokens,
	workingMessage,
	onFork,
	onEditMessage,
	onInspectTool,
	onOpenFile,
}: {
	turn: Turn;
	messages: WebMessage[];
	tools: Record<string, ToolCardState>;
	cwd?: string;
	isStreaming: boolean;
	isLast: boolean;
	lastAssistantIndex: number;
	contextFiles?: Array<ContextResource | string>;
	retryNotice?: string | null;
	streamStartedAt: number | null;
	runningTool?: string;
	outputTokens?: number;
	workingMessage?: string | null;
	onFork?: (entryId: string) => void;
	/** 编辑该回合的用户消息并重新发送（模型从这条消息重新回答） */
	onEditMessage?: (entryId: string, text: string) => void;
	onInspectTool?: (toolCallId: string) => void;
	onOpenFile?: (path: string) => void;
}) {
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const user = turn.userIndex >= 0 ? messages[turn.userIndex] : undefined;
	const assistants = turn.assistantIndexes;
	const lastIdx = assistants[assistants.length - 1];
	const turnLive = isStreaming && isLast;
	// 正在流式的那条永远先在过程里，回合结束后才作为最终回答"走出"过程
	const finalIdx = lastIdx !== undefined && isFinalAnswer(messages[lastIdx]) && !(isStreaming && lastIdx === lastAssistantIndex) ? lastIdx : -1;

	// 连续相同的模型错误（内容为空的错误消息）合并成一行，标连续次数
	const errorCounts = new Map<number, number>();
	{
		let runStart = -1;
		let runMsg = "";
		for (const k of assistants) {
			const m = messages[k];
			const bare = m.stopReason === "error" && !m.content.some((c) => (c.type === "text" && c.text.trim()) || c.type === "toolCall");
			if (bare && runStart >= 0 && (m.errorMessage ?? "") === runMsg) {
				errorCounts.set(k, 0);
				errorCounts.set(runStart, (errorCounts.get(runStart) ?? 1) + 1);
				continue;
			}
			if (bare) {
				runStart = k;
				runMsg = m.errorMessage ?? "";
				errorCounts.set(k, 1);
				continue;
			}
			runStart = -1;
		}
	}

	// 过程里要渲染的消息：最终回答只在有思考块时进过程（只出思考）
	const processIdx = assistants.filter((k) => k !== finalIdx || messages[k].content.some((c) => c.type === "thinking" && c.thinking.trim()));
	const items = processIdx.flatMap((k) => buildItems(messages, k, tools, isStreaming && k === lastAssistantIndex, k === finalIdx, errorCounts.get(k)));
	// 一段思考 + 命令的墙钟：从这段首条消息开始生成，到下一条助手消息开始生成（工具结果回来后）
	const spanOf = (a: number, b: number): number | undefined => {
		const start = messages[a]?.timestamp;
		const next = assistants.find((k) => k > b);
		const end = next !== undefined ? messages[next]?.timestamp : messages[b]?.endedAt;
		return typeof start === "number" && typeof end === "number" && end >= start ? end - start : undefined;
	};
	const blocks: Block[] = turnLive ? items.map((item) => ({ kind: "item", item })) : collapseRuns(items, finalIdx, spanOf);
	const last = items[items.length - 1];
	const hasLiveStep = Boolean(runningTool) || (last?.kind === "think" && last.live) || (last?.kind === "narr" && last.live);
	const showProcess = items.length > 0 || Boolean(contextFiles?.length) || turnLive || (isLast && Boolean(retryNotice));

	return (
		<div className="pw-conversation-turn">
			{user && <UserMessage message={user} onEditMessage={onEditMessage} />}
			{showProcess && (
				<div className="pw-turn">
					{contextFiles?.map((resource, i) => (
						<ContextStep key={`ctx-${typeof resource === "string" ? resource : `${resource.source}-${resource.path}`}-${i}`} resource={resource} cwd={cwd} />
					))}
					{blocks.map((b) => {
						if (b.kind === "item") return <ItemView key={b.item.key} item={b.item} cwd={cwd} onInspectTool={onInspectTool} onOpenFile={onOpenFile} />;
						const open = expanded.has(b.key);
						return (
							<div key={b.key} className="pw-run" data-open={open || undefined}>
								<SummaryStep
									run={b}
									expanded={open}
									onToggle={() => setExpanded((prev) => {
										const next = new Set(prev);
										if (next.has(b.key)) next.delete(b.key);
										else next.add(b.key);
										return next;
									})}
								/>
								{open && b.items.map((item) => <ItemView key={item.key} item={item} cwd={cwd} onInspectTool={onInspectTool} onOpenFile={onOpenFile} />)}
							</div>
						);
					})}
					{isLast && retryNotice && <RetryStep text={retryNotice} />}
					{turnLive && streamStartedAt && <WorkingStep startedAt={streamStartedAt} outputTokens={outputTokens} workingMessage={workingMessage} hasLiveStep={hasLiveStep} />}
				</div>
			)}
			{finalIdx >= 0 && <FinalAnswer message={messages[finalIdx]} onFork={onFork} showActions={!isStreaming || !isLast} turnStartMs={user?.timestamp} />}
		</div>
	);
}

function fmtTok(n: number): string {
	const scaled = (value: number) => value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
	return n >= 1_000_000 ? `${scaled(n / 1_000_000)}M` : n >= 1000 ? `${scaled(n / 1000)}K` : String(n);
}

function fmtDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

function fmtThroughput(tokensPerSecond: number): string {
	return tokensPerSecond >= 10 ? String(Math.round(tokensPerSecond)) : String(Math.round(tokensPerSecond * 10) / 10);
}

export function SessionStatsBar({
	stats,
}: {
	stats: WebStats | null;
}) {
	const { t } = useI18n();
	if (!stats || stats.assistantMessages === 0) return null;
	const groups: string[] = [
		t.statsCounts
			.replace("{turns}", String(stats.userMessages))
			.replace("{steps}", String(stats.assistantMessages)),
	];
	const durations: string[] = [];
	if (stats.llmMs > 0) durations.push(`LLM ${fmtDuration(stats.llmMs)}`);
	if (stats.toolMs > 0) durations.push(`${t.toolCalls} ${fmtDuration(stats.toolMs)}`);
	if (durations.length) groups.push(durations.join(" · "));
	const speeds: string[] = [];
	if (stats.ttftSteps > 0) speeds.push(`${t.ttftAverage} ${fmtDuration(stats.ttftMs / stats.ttftSteps)}`);
	if (stats.decodeMs > 0) speeds.push(`${fmtThroughput(stats.decodeTokens / (stats.decodeMs / 1000))} tok/s`);
	if (speeds.length) groups.push(speeds.join(" · "));
	const billedInput = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
	if (billedInput > 0 || stats.tokens.output > 0) {
		if (billedInput > 0) groups.push(`${t.cacheHits} ${Math.round((stats.tokens.cacheRead / billedInput) * 100)}%`);
		groups.push(`${t.inputTokens} ${fmtTok(billedInput)} tok · ${t.outputTokens} ${fmtTok(stats.tokens.output)} tok`);
	}
	const line = groups.join(" | ");
	return (
		// 悬停显示完整统计：自定义浮层固定在统计条上方（原生 title 位置不可控）
		<div className="group relative mx-auto mt-1 block w-full px-4 pt-1 text-center">
			<div
				className="overflow-hidden text-ellipsis whitespace-nowrap"
				style={{ fontSize: "var(--dsh-content-font-size-secondary, 13px)", lineHeight: "20px", color: "var(--dsw-label-caption)" }}
			>
				{line}
			</div>
			<div
				className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 hidden w-max max-w-[90vw] -translate-x-1/2 rounded-xl px-3 py-2 text-left group-hover:block"
				style={{ background: "var(--dsw-glass-popover)", border: "0.5px solid var(--dsw-border-l2)", boxShadow: "var(--dsw-elevation-soft)", fontSize: "var(--dsh-content-font-size-secondary, 13px)", lineHeight: "20px", color: "var(--dsw-label-secondary)" }}
			>
				{line}
			</div>
		</div>
	);
}

type TurnBlockProps = Parameters<typeof TurnBlockView>[0];

/**
 * 回合级跳过：流式期间只有正在变的那条消息身份会变（foldPiWebEvent 只替换被改动的消息），
 * 历史回合用到的数据全部保持身份，于是 200 条消息的会话里历史回合可以整体跳过重渲染。
 */
function turnBlockPropsEqual(prev: TurnBlockProps, next: TurnBlockProps): boolean {
	if (
		prev.cwd !== next.cwd ||
		prev.isStreaming !== next.isStreaming ||
		prev.isLast !== next.isLast ||
		prev.lastAssistantIndex !== next.lastAssistantIndex ||
		prev.retryNotice !== next.retryNotice ||
		prev.streamStartedAt !== next.streamStartedAt ||
		prev.runningTool !== next.runningTool ||
		prev.outputTokens !== next.outputTokens ||
		prev.workingMessage !== next.workingMessage ||
		prev.contextFiles !== next.contextFiles ||
		prev.onFork !== next.onFork ||
		prev.onEditMessage !== next.onEditMessage ||
		prev.onInspectTool !== next.onInspectTool ||
		prev.onOpenFile !== next.onOpenFile
	) return false;
	// buildTurns 每次重建回合对象：比较内容而不是引用
	if (prev.turn.key !== next.turn.key || prev.turn.userIndex !== next.turn.userIndex) return false;
	if (prev.turn.assistantIndexes.length !== next.turn.assistantIndexes.length) return false;
	if (!prev.turn.assistantIndexes.every((value, index) => value === next.turn.assistantIndexes[index])) return false;
	const indexes = [prev.turn.userIndex, ...prev.turn.assistantIndexes].filter((index) => index >= 0);
	if (!indexes.every((index) => prev.messages[index] === next.messages[index])) return false;
	// 只比较本回合引用到的工具条目：tools 外层容器每次工具事件都会换身份
	const toolIds: string[] = [];
	for (const index of indexes) {
		for (const part of prev.messages[index]?.content ?? []) {
			const call = part as { type?: string; id?: string };
			if (call.type === "toolCall" && call.id) toolIds.push(call.id);
		}
	}
	return toolIds.every((id) => prev.tools[id] === next.tools[id]);
}

const TurnBlock = memo(TurnBlockView, turnBlockPropsEqual);

export function ChatWindow({
	messages,
	tools,
	contextFiles,
	cwd,
	onFork,
	onEditMessage,
	isStreaming = false,
	error,
	connected = true,
	onClearError,
	retryNotice,
	compaction,
	onClearCompaction,
	workingMessage,
	stats,
	onOpenTrajectory,
	onOpenFile,
}: {
	messages: WebMessage[];
	tools: Record<string, ToolCardState>;
	contextFiles?: Array<ContextResource | string>;
	/** 工作区路径：工具行里的命令去掉 cd 前缀、文件路径显示为相对路径 */
	cwd?: string;
	onFork?: (entryId: string) => void;
	isStreaming?: boolean;
	/** 行内错误提示（显示在消息流末尾，替代右下角弹窗） */
	error?: string | null;
	connected?: boolean;
	onClearError?: () => void;
	/** 自动重试通知（轨道内一行，点击展开详情） */
	retryNotice?: string | null;
	compaction?: { phase: "start" | "end"; errorMessage?: string; ts: number } | null;
	onClearCompaction?: () => void;
	/** 扩展覆盖的工作中文案（setWorkingMessage） */
	workingMessage?: string | null;
	/** 会话统计：工作指示里显示本轮输出 token */
	stats?: WebStats | null;
	/** 轨迹条目：用于把工具行链接到轨迹 inspector */
	trajectory?: TrajEntry[];
	onOpenTrajectory?: (toolCallId: string) => void;
	/** 在本机编辑器打开工具行涉及的文件 */
	onEditMessage?: (entryId: string, text: string) => void;
	onOpenFile?: (path: string) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);
	const { t } = useI18n();
	// 脱离底部后累计的新内容条数（回到底部按钮上的角标）
	const [unseen, setUnseen] = useState(0);
	/** 是否已离开底部（state 版：ref 变化不会触发渲染，静态会话翻页时按钮出不来） */
	const [awayFromBottom, setAwayFromBottom] = useState(false);
	const prevLenRef = useRef(messages.length);
	// 本轮开始时间：工作指示的计时基准。以本轮用户消息的时间戳为准（中途打开页面也能显示真实已用时长），没有就取现在
	const lastUserTs = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === "user") return messages[i].timestamp;
		return undefined;
	}, [messages]);
	const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
	useEffect(() => {
		setStreamStartedAt((prev) => (isStreaming ? prev ?? (lastUserTs && Date.now() - lastUserTs < 6 * 3600_000 ? lastUserTs : Date.now()) : null));
	}, [isStreaming, lastUserTs]);
	const runningTool = useMemo(() => Object.values(tools).find((tool) => tool.state === "running")?.name, [tools]);
	const lastAssistantIndex = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === "assistant") return i;
		return -1;
	}, [messages]);
	const turns = useMemo(() => buildTurns(messages), [messages]);
	const firstUser = useMemo(() => messages.findIndex((m) => m.role === "user"), [messages]);

	useEffect(() => {
		const grew = messages.length > prevLenRef.current;
		prevLenRef.current = messages.length;
		if (!stickToBottom.current) {
			if (grew) setUnseen((n) => n + 1);
			return;
		}
		const frame = requestAnimationFrame(() => {
			const node = scrollRef.current;
			if (node) node.scrollTop = node.scrollHeight;
		});
		return () => cancelAnimationFrame(frame);
	}, [messages, tools, error, connected, retryNotice, compaction, isStreaming]);

	const scrollToBottom = () => {
		const node = scrollRef.current;
		if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
		stickToBottom.current = true;
		setAwayFromBottom(false);
		setUnseen(0);
	};

	return (
		<div className="pw-chat-window relative flex h-full min-h-0 flex-col">
			<div
				ref={scrollRef}
				className="pw-chat-scroll min-h-0 flex-1 overflow-y-auto"
				role="log"
				aria-live="polite"
				aria-relevant="additions"
				onScroll={(event) => {
					const node = event.currentTarget;
					const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
					stickToBottom.current = atBottom;
					setAwayFromBottom(!atBottom);
					if (atBottom) setUnseen(0);
				}}
			>
				<div className="pw-chat-flow mx-auto flex w-full flex-col px-4 py-6" style={{ maxWidth: "var(--dsh-chat-content-width)" }}>
					{turns.map((turn, ti) => (
						<TurnBlock
							key={turn.key}
							turn={turn}
							messages={messages}
							tools={tools}
							cwd={cwd}
							isStreaming={isStreaming}
							isLast={ti === turns.length - 1}
							lastAssistantIndex={lastAssistantIndex}
							contextFiles={turn.userIndex >= 0 && turn.userIndex === firstUser ? contextFiles : undefined}
							retryNotice={retryNotice}
							streamStartedAt={streamStartedAt}
							runningTool={runningTool}
							outputTokens={stats?.tokens.output}
							workingMessage={workingMessage}
							onFork={onFork}
							onEditMessage={onEditMessage}
							onInspectTool={onOpenTrajectory}
							onOpenFile={onOpenFile}
						/>
					))}
					{/* 还没有任何消息就已在流式（极少见）：单独给一条工作指示 */}
					{isStreaming && streamStartedAt && turns.length === 0 && (
						<div className="pw-turn">
							<WorkingStep startedAt={streamStartedAt} outputTokens={stats?.tokens.output} workingMessage={workingMessage} hasLiveStep={Boolean(runningTool)} />
						</div>
					)}
					{/* 重连提示：跟随消息流显示在最后一条输出下面 */}
					{!connected && (
						<div className="mt-3 flex justify-center">
							<div
								className="rounded-full px-3 py-1"
								style={{ fontSize: "var(--piweb-chat-font-t)", color: "var(--dsw-label-caption)", border: "0.5px dashed var(--dsw-border-l3)" }}
							>
								{t.reconnecting}
							</div>
						</div>
					)}
					{compaction && (
						<div className="mt-3 flex justify-center" role="status">
							<div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ fontSize: "var(--piweb-chat-font-s)", background: "var(--dsw-hover)", color: "var(--dsw-label-secondary)" }}>
								<span>{compaction.phase === "start" ? t.compacting : compaction.errorMessage ? `${t.compactionFailed}: ${compaction.errorMessage}` : t.compactionComplete}</span>
								{compaction.phase === "end" && <button type="button" onClick={onClearCompaction} aria-label={t.close} className="icon-btn">×</button>}
							</div>
						</div>
					)}
					{error && (
						<button
							className="mt-3 rounded-xl px-3 py-2 text-left"
							style={{ fontSize: "var(--piweb-chat-font-s)", background: "var(--dsw-danger)", color: "white" }}
							onClick={onClearError}
							role="alert"
						>
							{error}
						</button>
					)}
				</div>
			</div>
			{/* 右侧大纲导航：从助手回答的标题和用户消息生成，随滚动高亮，悬停展开 */}
			<OutlineRail scrollRef={scrollRef} revision={`${messages.length}:${isStreaming ? 1 : 0}`} />
			{/* 脱离底部时的“回到底部”浮钮：与输入框卡片同轴，挂在右上角顶部，图标带新内容角标 */}
			{(unseen > 0 || awayFromBottom) && (
				<div
					className="pointer-events-none absolute inset-x-0 bottom-2 mx-auto flex w-full justify-end"
					style={{ maxWidth: "var(--dsh-composer-card-max-width)" }}
				>
					<button
						type="button"
						className="pointer-events-auto relative flex h-8 w-8 items-center justify-center rounded-full"
						style={{ background: "var(--dsw-glass-popover)", border: "0.5px solid var(--dsw-border-l2)", boxShadow: "var(--dsw-elevation-soft)", color: "var(--dsw-label-secondary)" }}
						onClick={scrollToBottom}
						title={t.backToBottom}
					>
						{/* 向下箭头 */}
						<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
							<path d="M8 3.5v9M4.5 9L8 12.5 11.5 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
						</svg>
						{unseen > 0 && (
							<span
								className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1"
								style={{ fontSize: 10, fontWeight: 600, background: "var(--dsw-accent)", color: "#fff" }}
							>
								{unseen > 99 ? "99+" : unseen}
							</span>
						)}
					</button>
				</div>
			)}
		</div>
	);
}
