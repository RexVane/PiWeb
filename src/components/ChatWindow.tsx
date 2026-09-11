"use client";

/**
 * 对话视图 —— 过程时间线。
 * 每个回合 = 用户消息 → 过程轨道（一条竖线串起思考 / 叙述 / 工具 / 结果 / 错误）→ 最终回答（轨道外）。
 * 工具行按种类着色（命令 / 读取 / 搜索 / 写入），结果预览按种类挑最有用的几行；
 * 已完成且步骤多的回合折叠成一行摘要（列出改了哪些文件）。
 */
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
	IconBranchOutline16,
	IconCheckOutline14,
	IconClockOutline16,
	IconCopyOutline16,
	IconDataOutline16,
	IconFileOutline16,
} from "@/components/icons";
import { DiffView, type DiffLine, parseUnifiedDiff } from "@/components/DiffView";
import { OutlineRail } from "@/components/OutlineRail";
import { useI18n } from "@/i18n";
import type { ToolCardState } from "@/hooks/usePiWeb";
import type { ContextResource, TrajEntry, TrajTokens, WebContent, WebMessage, WebStats } from "@/lib/types";
import {
	basename,
	classifyModelError,
	cleanCommand,
	firstSentence,
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

function copyText(text: string) {
	void navigator.clipboard?.writeText(text);
}

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
			<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}>
				{text}
			</ReactMarkdown>
		</div>
	);
});

/** 流式中的最后一段正文：纯文本逐字追加 + 闪烁光标，结束后再切 Markdown（避免每个 delta 重解析整段） */
function StreamingText({ text }: { text: string }) {
	return (
		<div className="md">
			<p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>
				{text}
				<span className="stream-cursor" aria-hidden />
			</p>
		</div>
	);
}

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
	durationMs,
	usage,
	time,
	clockStart = false,
}: {
	text: string;
	onFork?: () => void | Promise<unknown>;
	/** 回合墙钟耗时（最终回答时间戳 − 回合首条用户消息时间戳），dsh runMs 的对应物 */
	durationMs?: number;
	usage?: TrajTokens & { cost?: { total?: number } };
	/** 消息时间戳，驱动时钟；undefined 时不显示时钟 */
	time?: number;
	/** 用户消息时钟在图标左侧（dsh clock=start），助手在行尾（clock=end） */
	clockStart?: boolean;
}) {
	const [copied, setCopied] = useState(false);
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
				title={t.copy}
				aria-label={t.copy}
				onClick={() => {
					copyText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				}}
			>
				{copied ? <IconCheckOutline14 size={14} /> : <IconCopyOutline16 size={14} />}
			</button>
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

// ---------- 过程轨道：基础行与节点 ----------

const MONO = "var(--font-mono)";
const RAIL = "⎿";
/** ⎿ 预览最多几行 */
const PREVIEW_LINES = 3;
/** diff 默认露出多少行 */
const DIFF_PREVIEW = 40;

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

function fmtSeconds(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

type DotState = "running" | "failed" | "done";
type DotVariant = "narr" | "think" | "work" | "error" | "abort" | "retry" | "ctx";

/** 轨道上的节点：工具行按种类着色，运行中呼吸，失败变红；其它行各有形状 */
function Dot({ kind, state, variant }: { kind?: ToolKind; state?: DotState; variant?: DotVariant }) {
	return (
		<span aria-hidden className={variant ? `proc-dot ${variant}` : "proc-dot"} data-kind={kind} data-state={state}>
			{variant === "error" ? "✕" : null}
		</span>
	);
}

function ProcRow({ dot, className, style, children }: { dot: ReactNode; className?: string; style?: CSSProperties; children: ReactNode }) {
	return (
		<div className={className ? `proc-row ${className}` : "proc-row"} style={style}>
			{dot}
			{children}
		</div>
	);
}

// ---------- 工具行 ----------

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** 工具参数摘要：命令去掉 cd 工作区前缀、路径相对于工作区 */
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

/** ⎿ 结果预览：按工具种类挑最有用的几行（查看类命令看开头、构建测试类看结尾，搜索看开头，读取只给行数，写入给 diff 统计） */
function toolPreview(kind: ToolKind, state: ToolCardState, t: Dict, diff: DiffLine[] | null, cwd?: string): Preview {
	const running = state.state === "running";
	const raw = (state.result ?? state.partialResult ?? "").replace(/\r/g, "");
	const exitMatch = raw.match(/Command exited with code (\d+)/);
	const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
	const body = splitLines(raw).filter((l) => !/^Command exited with code \d+/.test(l));
	const count = (k: string, v: number) => t[k].replace("{n}", String(v));
	// 输出里的工作区绝对路径也改成相对路径
	const rel = (lines: string[]) => (cwd ? lines.map((l) => relativizeInText(l, cwd)) : lines);
	// 结尾只剩括号 / 符号的行（"}"、");"）看了等于没看，取尾巴前先剥掉
	const tailBody = trimNoiseTail(body);
	const tail = (n: number): Preview => ({ lines: rel(tailBody.slice(-n)), hidden: Math.max(0, body.length - Math.min(n, tailBody.length)), side: "tail" });
	const head = (n: number): Preview => ({ lines: rel(body.slice(0, n)), hidden: Math.max(0, body.length - n), side: "head" });
	const none: Preview = { lines: [], hidden: 0 };
	const a = state.args as Record<string, unknown> | undefined;
	const command = kind === "cmd" ? (str(a?.command) ?? str(a?.cmd) ?? str(a?.script) ?? "") : "";
	// 看开头还是结尾按去掉 cd 前缀后的真正命令判断
	const byCmd = (n: number) => (previewSide(cleanCommand(command, cwd).text) === "head" ? head(n) : tail(n));
	if (running) {
		// 命令运行中：实时贴输出尾巴（像终端）；其它工具运行中不占位
		return kind === "cmd" && body.length ? tail(PREVIEW_LINES) : none;
	}
	if (state.isError) {
		const h = exitCode !== undefined && exitCode !== 0 ? `${t.toolFailed} · ${t.toolExit.replace("{code}", String(exitCode))}` : t.toolFailed;
		// 命令的错误通常在末尾，其它工具在开头
		return { head: h, ...(kind === "cmd" ? tail(4) : head(4)) };
	}
	switch (kind) {
		case "write": {
			if (diff && diff.length) {
				const add = diff.filter((l) => l.kind === "add").length;
				const del = diff.filter((l) => l.kind === "del").length;
				return { head: t.diffSummary.replace("{add}", String(add)).replace("{del}", String(del)), lines: [], hidden: 0 };
			}
			return { head: body[0] ?? t.toolWritten, lines: [], hidden: 0 };
		}
		case "read": {
			const a = state.args as { path?: unknown; file_path?: unknown } | undefined;
			const lang = langOfPath(str(a?.path ?? a?.file_path) ?? "");
			return { head: body.length ? `${count("toolLines", body.length)}${lang ? ` · ${lang}` : ""}` : t.toolNoOutput, lines: [], hidden: 0 };
		}
		case "search":
			return body.length ? { head: count("toolMatches", body.length), ...head(PREVIEW_LINES) } : { head: t.toolNoOutput, lines: [], hidden: 0 };
		case "cmd": {
			const h = exitCode !== undefined && exitCode !== 0 ? t.toolExit.replace("{code}", String(exitCode)) : undefined;
			if (!body.length) return { head: h ?? t.toolNoOutput, lines: [], hidden: 0 };
			return { head: h, ...byCmd(PREVIEW_LINES) };
		}
		default:
			return body.length ? head(2) : { head: t.toolNoOutput, lines: [], hidden: 0 };
	}
}

function ToolRow({ name, state, cwd, onInspect, onOpenFile }: { name: string; state?: ToolCardState; cwd?: string; onInspect?: () => void; onOpenFile?: (path: string) => void }) {
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const tt = t as unknown as Dict;
	const kind = toolKind(name);
	const running = state?.state === "running";
	const elapsed = useElapsed(state?.startedAt, Boolean(running));
	const output = state?.result ?? state?.partialResult ?? "";
	const diff = useMemo(() => {
		if (kind !== "write") return null;
		const parsed = parseUnifiedDiff(state?.patch || output);
		if (parsed) return parsed;
		// pi 的 write 工具不带 patch：整份内容都是新增，直接按绿色新增行展示
		if (name.toLowerCase() === "write" && state?.state === "done" && !state.isError) {
			const content = str((state.args as { content?: unknown } | undefined)?.content);
			if (content) return content.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((text, i): DiffLine => ({ kind: "add", new: i + 1, text }));
		}
		return null;
	}, [kind, name, output, state?.args, state?.isError, state?.patch, state?.state]);
	if (!state) {
		return (
			<ProcRow dot={<Dot kind={kind} state="running" />}>
				<div className="flex items-center gap-2" style={{ fontSize: "var(--piweb-chat-font-l)" }}>
					<span className="proc-tool-name" data-kind={kind}>{name}</span>
				</div>
			</ProcRow>
		);
	}
	const failed = Boolean(state.isError) && !running;
	const summary = toolSummary(name, state.args, cwd);
	// 悬停显示完整参数（不只是截断的第一行）
	let argsTitle = summary.text;
	try {
		argsTitle = JSON.stringify(state.args, null, 2).slice(0, 2000);
	} catch {
		/* keep summary */
	}
	// read/edit/write：悬停给「在编辑器中打开」
	const argPath = (() => {
		if (kind !== "read" && kind !== "write") return "";
		const a = state.args as { path?: unknown; file_path?: unknown } | undefined;
		return str(a?.path ?? a?.file_path) ?? "";
	})();
	const fullCommand = kind === "cmd"
		? (() => {
				const a = state.args as Record<string, unknown> | undefined;
				return str(a?.command) ?? str(a?.cmd) ?? str(a?.script) ?? "";
			})()
		: "";
	const preview = toolPreview(kind, state, tt, diff, cwd);
	const hasDiff = Boolean(diff && diff.length) && !failed;
	const hasOutput = Boolean(output || state.encodingLoss);
	// 有 diff 的写入：展开由 diff 自己的「还有 N 行」承担，不再另开输出面板
	const canExpand = hasOutput && !hasDiff;
	const duration = state.startedAt && state.endedAt ? state.endedAt - state.startedAt : 0;
	const dotState: DotState = running ? "running" : failed ? "failed" : "done";
	const showPreview = Boolean(preview.head) || preview.lines.length > 0;
	const diffLines = hasDiff && diff ? (open ? diff : diff.slice(0, DIFF_PREVIEW)) : null;
	const diffHidden = diff && diffLines && !open ? diff.length - diffLines.length : 0;
	const toggle = () => setOpen((o) => !o);
	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			toggle();
		}
	};
	return (
		<ProcRow dot={<Dot kind={kind} state={dotState} />} className="group/tool">
			<div className="flex items-center gap-2" style={{ fontSize: "var(--piweb-chat-font-l)" }}>
				<span className="proc-tool-name" data-kind={kind} data-failed={failed || undefined}>{name}</span>
				{summary.text ? (
					<span className="min-w-0 flex-1 truncate" style={{ fontSize: "var(--piweb-chat-font-s)", fontFamily: MONO, color: "var(--dsw-label-secondary)" }} title={argsTitle}>
						{summary.text}
					</span>
				) : (
					<span className="flex-1" />
				)}
				{summary.scriptLines > 1 && <span className="proc-meta">{t.commandLines.replace("{n}", String(summary.scriptLines))}</span>}
				{running && <span className="proc-meta">{fmtSeconds(elapsed)}</span>}
				{!running && duration >= 1000 && <span className="proc-meta">{fmtSeconds(duration)}</span>}
				{onOpenFile && argPath && (
					<button
						type="button"
						className="icon-btn opacity-0 group-hover/tool:opacity-100"
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
				{onInspect && (
					<button
						type="button"
						className="icon-btn opacity-0 group-hover/tool:opacity-100"
						style={{ width: 22, height: 22, flex: "none" }}
						title={t.viewInTrajectory}
						aria-label={t.viewInTrajectory}
						onClick={(e) => {
							e.stopPropagation();
							onInspect();
						}}
					>
						<IconDataOutline16 size={13} />
					</button>
				)}
			</div>
			{showPreview && (
				<div
					className="proc-result"
					data-failed={failed || undefined}
					role={canExpand ? "button" : undefined}
					tabIndex={canExpand ? 0 : undefined}
					onClick={canExpand ? toggle : undefined}
					onKeyDown={canExpand ? onKey : undefined}
					title={canExpand ? (open ? t.collapseOutput : t.expandOutput) : undefined}
					style={canExpand ? { cursor: "pointer" } : undefined}
				>
					<span className="rail">{RAIL}</span>
					<span className="lines">
						{preview.head && <div className="head">{preview.head}</div>}
						{/* 尾巴预览：被省略的行在上面，「还有 N 行」也放上面 */}
						{!open && preview.side === "tail" && preview.hidden > 0 && <div className="more">… {t.moreLines.replace("{n}", String(preview.hidden))}</div>}
						{!open && preview.lines.map((l, i) => <div key={i}>{l}</div>)}
						{!open && preview.side !== "tail" && preview.hidden > 0 && <div className="more">… {t.moreLines.replace("{n}", String(preview.hidden))}</div>}
						{open && canExpand && <div className="more">{t.collapseOutput}</div>}
					</span>
				</div>
			)}
			{diffLines && diffLines.length > 0 && (
				<div className="proc-output" style={{ padding: "6px 8px" }}>
					<DiffView lines={diffLines} />
					{diffHidden > 0 && (
						<button type="button" className="proc-more" onClick={() => setOpen(true)}>
							… {t.moreLines.replace("{n}", String(diffHidden))}
						</button>
					)}
					{open && diff && diff.length > DIFF_PREVIEW && (
						<button type="button" className="proc-more" onClick={() => setOpen(false)}>
							{t.collapseOutput}
						</button>
					)}
				</div>
			)}
			{open && canExpand && (
				<div className="proc-output">
					{fullCommand && <div className="cmdline">{fullCommand}</div>}
					{state.encodingLoss && <p className="mb-2 whitespace-normal" style={{ color: "var(--dsw-warn)" }}>{t.encodingLossWarning}</p>}
					{output && <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit" }}>{output}</pre>}
				</div>
			)}
		</ProcRow>
	);
}

// ---------- 思考行：进行中显示流动的斜体尾巴，完成后收成首句 ----------

function ThinkRow({ text, live, startedAt }: { text: string; live?: boolean; startedAt?: number }) {
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const elapsed = useElapsed(startedAt, Boolean(live));
	if (live) {
		const one = text.replace(/\s+/g, " ").trim();
		const tail = one.length > 240 ? `…${one.slice(-240)}` : one;
		return (
			<ProcRow dot={<Dot variant="think" state="running" />}>
				<div className="flex items-center gap-2" style={{ fontSize: "var(--piweb-chat-font-m)" }}>
					<span style={{ color: "var(--dsw-label-tertiary)", fontStyle: "italic" }}>{t.thinkingLive}…</span>
					{startedAt && elapsed >= 3000 ? <span className="proc-meta">{fmtSeconds(elapsed)}</span> : null}
				</div>
				{tail && <div className="proc-think-live">{tail}</div>}
			</ProcRow>
		);
	}
	const gist = firstSentence(text);
	return (
		<ProcRow dot={<Dot variant="think" />}>
			<button type="button" className="flex w-full min-w-0 items-baseline gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
				<span className="proc-think-text" style={{ flex: "none", color: "var(--dsw-label-tertiary)" }}>{t.thinkLabel}</span>
				{!open && <span className="proc-think-text min-w-0 flex-1 truncate">{gist}</span>}
			</button>
			{open && (
				<pre className="proc-output" style={{ fontFamily: "inherit", fontSize: 12.5, fontStyle: "italic", whiteSpace: "pre-wrap", color: "var(--dsw-label-tertiary)" }}>
					{text}
				</pre>
			)}
		</ProcRow>
	);
}

// ---------- 叙述行：模型在工具之间说的话，是这一阶段的标题 ----------

function NarrationRow({ text, live, error }: { text: string; live?: boolean; error?: boolean }) {
	return (
		<ProcRow dot={<Dot variant="narr" />} className="proc-narr">
			<div className="proc-narr-body" data-error={error || undefined}>
				{live ? <StreamingText text={text} /> : <Markdown text={text} />}
			</div>
		</ProcRow>
	);
}

// ---------- 模型错误行：归类成人话 + 原文 + 连续次数（要继续就直接再发一条消息，不设按钮） ----------

const ERROR_HINT_KEY: Record<ModelErrorKind, string> = {
	rateLimit: "modelErrorRateLimit",
	billing: "modelErrorBilling",
	auth: "modelErrorAuth",
	notFound: "modelErrorNotFound",
	context: "modelErrorContext",
	timeout: "modelErrorTimeout",
	server: "modelErrorServer",
	network: "modelErrorNetwork",
};

function ErrorRow({ message, count, model }: { message: string; count: number; model?: string }) {
	const { t } = useI18n();
	const tt = t as unknown as Dict;
	const kind = classifyModelError(message);
	const hint = kind ? tt[ERROR_HINT_KEY[kind]] : "";
	return (
		<ProcRow dot={<Dot variant="error" />}>
			<div className="flex items-center gap-2" style={{ fontSize: "var(--piweb-chat-font-m)" }}>
				<span style={{ flex: "none", fontWeight: 600, color: "var(--dsw-danger)" }}>{t.modelError}</span>
				<span className="flex-1" />
				{count > 1 && <span className="proc-meta" style={{ color: "var(--dsw-danger)" }}>{t.modelErrorTimes.replace("{n}", String(count))}</span>}
				{model && <span className="proc-meta">{model}</span>}
			</div>
			{/* 第一行是人话解释（认得出错误类型时），原始报错放下面一行变淡 */}
			<div className="proc-result" data-failed="true">
				<span className="rail">{RAIL}</span>
				<span className="lines">
					{hint && <div className="head" style={{ whiteSpace: "pre-wrap" }}>{hint}</div>}
					<div style={{ whiteSpace: "pre-wrap", color: hint ? "var(--dsw-label-caption)" : undefined }}>{message}</div>
				</span>
			</div>
		</ProcRow>
	);
}

function AbortRow() {
	const { t } = useI18n();
	return (
		<ProcRow dot={<Dot variant="abort" />}>
			<div style={{ fontSize: 13, color: "var(--dsw-label-caption)" }}>{t.turnAborted}</div>
		</ProcRow>
	);
}

/** 轨道末尾的工作指示：轮换动词 (已用时长 · ↓ 输出 token)；有工具在跑时改为「正在运行 xxx」 */
function WorkingRow({ startedAt, runningTool, outputTokens, workingMessage }: { startedAt: number; runningTool?: string; outputTokens?: number; workingMessage?: string | null }) {
	const { t } = useI18n();
	const elapsed = useElapsed(startedAt, true);
	const verbs = t.workingVerbs.split("|");
	const verb = verbs[Math.floor(elapsed / 3000) % verbs.length];
	// 扩展可以用 setWorkingMessage 覆盖这行文案（pi 终端同款能力）
	const label = workingMessage || (runningTool ? t.runningTool.replace("{name}", runningTool) : `${verb}…`);
	const meta = [fmtSeconds(elapsed), outputTokens ? `↓ ${fmtTok(outputTokens)} tokens` : ""].filter(Boolean).join(" · ");
	return (
		<ProcRow dot={<Dot variant="work" />}>
			<div className="flex items-center gap-2" style={{ fontSize: "var(--piweb-chat-font-m)" }}>
				<span style={{ color: "var(--dsw-accent)" }}>{label}</span>
				<span className="proc-meta">({meta})</span>
			</div>
		</ProcRow>
	);
}

// ---------- 自动重试行（pi 自己在重试；点击展开详情，停止用输入框的停止键） ----------

function RetryRow({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const oneLine = text.replace(/\s+/g, " ").trim();
	const [label, ...rest] = oneLine.split("：");
	return (
		<ProcRow dot={<Dot variant="retry" />}>
			<button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" style={{ fontSize: "var(--piweb-chat-font-m)" }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
				<span style={{ fontWeight: 500, color: "var(--dsw-warn)", flex: "none" }}>{label}</span>
				{!open && rest.length > 0 && (
					<span className="min-w-0 flex-1 truncate" style={{ color: "var(--dsw-label-tertiary)" }}>{rest.join("：")}</span>
				)}
			</button>
			{open && (
				<pre className="proc-output" style={{ fontFamily: "inherit", fontSize: 12.5, whiteSpace: "pre-wrap", color: "var(--dsw-label-tertiary)" }}>
					{text}
				</pre>
			)}
		</ProcRow>
	);
}

// ---------- 上下文注入行（AGENTS.md 等） ----------

function ContextRow({ resource, cwd }: { resource: ContextResource | string; cwd?: string }) {
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const normalized = typeof resource === "string" ? { path: resource, content: "", source: "project" as const } : resource;
	return (
		<ProcRow dot={<Dot variant="ctx" />}>
			<button
				type="button"
				className="flex w-full min-w-0 items-center gap-2 text-left"
				style={{ fontSize: "var(--piweb-chat-font-m)" }}
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<span style={{ flex: "none", color: "var(--dsw-label-tertiary)" }}>{t.contextInject}</span>
				<span className="min-w-0 flex-1 truncate" style={{ color: "var(--dsw-label-caption)", fontFamily: MONO, fontSize: "var(--piweb-chat-font-t)" }} title={normalized.path}>
					{relativizePath(normalized.path, cwd)}
				</span>
			</button>
			{open && normalized.content && (
				<pre className="proc-output" style={{ maxHeight: 141, fontSize: "var(--piweb-chat-font-xs)", lineHeight: 1.45, whiteSpace: "pre-wrap", color: "var(--dsw-label-tertiary)" }}>
					{normalized.content}
				</pre>
			)}
		</ProcRow>
	);
}

// ---------- 已完成回合的折叠摘要：一行说清做了什么，点开看全部 ----------

function FoldRow({ calls, tools, open, onToggle }: { calls: ToolCallContent[]; tools: Record<string, ToolCardState>; open: boolean; onToggle: () => void }) {
	const { t } = useI18n();
	const edited: string[] = [];
	let reads = 0;
	let cmds = 0;
	let searches = 0;
	let failed = 0;
	let start = Infinity;
	let end = 0;
	for (const c of calls) {
		const kind = toolKind(c.name);
		const s = tools[c.id];
		if (kind === "write") {
			const a = c.arguments as { path?: unknown; file_path?: unknown } | undefined;
			const p = str(a?.path ?? a?.file_path);
			if (p) {
				const b = basename(p);
				if (!edited.includes(b)) edited.push(b);
			}
		} else if (kind === "read") reads += 1;
		else if (kind === "cmd") cmds += 1;
		else if (kind === "search") searches += 1;
		if (s?.isError) failed += 1;
		if (s?.startedAt) start = Math.min(start, s.startedAt);
		if (s?.endedAt) end = Math.max(end, s.endedAt);
	}
	const parts: Array<{ text: string; mono?: boolean }> = [{ text: t.batchDone.replace("{n}", String(calls.length)) }];
	if (edited.length) {
		const names = edited.slice(0, 3).join(", ") + (edited.length > 3 ? ` +${edited.length - 3}` : "");
		parts.push({ text: t.stepsSummaryEdited.replace("{files}", names), mono: true });
	}
	if (reads) parts.push({ text: t.stepsSummaryReads.replace("{n}", String(reads)) });
	if (searches) parts.push({ text: t.stepsSummarySearches.replace("{n}", String(searches)) });
	if (cmds) parts.push({ text: t.stepsSummaryCmds.replace("{n}", String(cmds)) });
	if (failed) parts.push({ text: t.stepsSummaryFailed.replace("{n}", String(failed)) });
	const duration = Number.isFinite(start) && end > start ? end - start : 0;
	if (duration >= 1500) parts.push({ text: fmtSeconds(duration) });
	return (
		<ProcRow dot={<Dot />}>
			<button type="button" className="proc-fold" aria-expanded={open} onClick={onToggle}>
				<span className="chev" aria-hidden>▸</span>
				<span className="min-w-0 flex-1 truncate">
					{parts.map((p, i) => (
						<span key={i} className={p.mono ? "files" : undefined}>
							{i > 0 ? " · " : ""}
							{p.text}
						</span>
					))}
				</span>
				<span className="proc-meta">{open ? t.hideSteps : t.showSteps}</span>
			</button>
		</ProcRow>
	);
}

// ---------- 一条助手消息在轨道上的行（思考 / 叙述 / 工具 / 错误 / 中止） ----------

const ProcessMessage = memo(function ProcessMessage({
	message,
	tools,
	cwd,
	live = false,
	omitText = false,
	errorCount,
	onInspectTool,
	onOpenFile,
}: {
	message: WebMessage;
	tools: Record<string, ToolCardState>;
	cwd?: string;
	/** 正在流式生成：最后一个思考块显示为进行中，最后一段正文逐字显示带光标 */
	live?: boolean;
	/** 这条是回合的最终回答：正文在轨道外单独渲染，这里只出思考 */
	omitText?: boolean;
	/** 模型错误行：0 = 不渲染（已并入前一条同错误行），≥ 1 = 渲染并标连续次数 */
	errorCount?: number;
	onInspectTool?: (toolCallId: string) => void;
	onOpenFile?: (path: string) => void;
}) {
	const lastIndex = message.content.length - 1;
	const isError = message.stopReason === "error";
	const rows: ReactNode[] = [];
	message.content.forEach((c, i) => {
		if (c.type === "thinking" && c.thinking.trim()) {
			rows.push(<ThinkRow key={`t${i}`} text={c.thinking} live={live && i === lastIndex} startedAt={message.timestamp} />);
		} else if (c.type === "toolCall") {
			rows.push(
				<ToolRow key={`${c.id}-${i}`} name={c.name} state={tools[c.id]} cwd={cwd} onInspect={onInspectTool ? () => onInspectTool(c.id) : undefined} onOpenFile={onOpenFile} />,
			);
		} else if (c.type === "text" && !omitText && c.text.trim()) {
			rows.push(<NarrationRow key={`n${i}`} text={c.text} live={live && i === lastIndex} error={isError} />);
		} else if (c.type === "image" && !omitText) {
			rows.push(
				<ProcRow key={`i${i}`} dot={<Dot variant="narr" />}>
					<img src={`data:${c.mimeType};base64,${c.data}`} alt="" className="my-1 max-h-96 max-w-full rounded-2xl object-contain" />
				</ProcRow>,
			);
		}
	});
	if (isError && (errorCount ?? 1) > 0) {
		rows.push(<ErrorRow key="err" message={message.errorMessage || message.stopReason || "error"} count={errorCount ?? 1} model={message.model} />);
	}
	if (message.stopReason === "aborted") rows.push(<AbortRow key="abort" />);
	return <>{rows}</>;
});

// ---------- 最终回答：轨道外、完整 Markdown、带操作行 ----------

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
const UserMessage = memo(function UserMessage({ message }: { message: WebMessage }) {
	const text = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = message.content.filter((content) => content.type === "image");
	return (
		// 回合边界：用户消息前留 28px（比回合内 8px 大得多），长对话里一眼找到“这一轮从哪开始”
		<div className="group mt-7 flex w-full flex-col items-end first:mt-0" data-role="user">
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
			{/* 用户消息也走 Markdown：贴进来的代码块/列表不再是一坨纯文本 */}
			{text && <div className="msg-user-bubble"><Markdown text={text} /></div>}
			{/* 用户消息只有复制操作，不提供分支；时钟在图标左侧（dsh clock=start） */}
			{text && <MessageActions text={text} clockStart={message.timestamp !== undefined} time={message.timestamp} />}
		</div>
	);
});

// ---------- 回合：用户消息 → 轨道 → 最终回答 ----------

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

const isToolCall = (c: WebContent): c is ToolCallContent => c.type === "toolCall";

function TurnBlock({
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
	onInspectTool?: (toolCallId: string) => void;
	onOpenFile?: (path: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const user = turn.userIndex >= 0 ? messages[turn.userIndex] : undefined;
	const assistants = turn.assistantIndexes;
	const lastIdx = assistants[assistants.length - 1];
	const turnLive = isStreaming && isLast;
	// 正在流式的那条永远先在轨道里，回合结束后才作为最终回答“走出”轨道
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

	const calls = assistants.flatMap((k) => messages[k].content.filter(isToolCall));
	// 出错或中止的回合不折叠：用户需要直接看到出错前后的完整过程
	const turnFailed = assistants.some((k) => messages[k].stopReason === "error" || messages[k].stopReason === "aborted")
		|| calls.some((c) => tools[c.id]?.isError);
	const foldable = !turnLive && !turnFailed && calls.length >= 4;
	// 轨道上要渲染的消息：最终回答只在有思考块时进轨道（只出思考）
	const processIdx = assistants.filter((k) => k !== finalIdx || messages[k].content.some((c) => c.type === "thinking" && c.thinking.trim()));
	const showRail = processIdx.length > 0 || Boolean(contextFiles?.length) || turnLive || (isLast && Boolean(retryNotice));

	return (
		<>
			{user && <UserMessage message={user} />}
			{showRail && (
				<div className="proc-turn">
					{contextFiles?.map((resource, i) => (
						<ContextRow key={`ctx-${typeof resource === "string" ? resource : `${resource.source}-${resource.path}`}-${i}`} resource={resource} cwd={cwd} />
					))}
					{foldable && <FoldRow calls={calls} tools={tools} open={expanded} onToggle={() => setExpanded((o) => !o)} />}
					{(!foldable || expanded)
						&& processIdx.map((k) => (
							<ProcessMessage
								key={`m-${k}`}
								message={messages[k]}
								tools={tools}
								cwd={cwd}
								live={isStreaming && k === lastAssistantIndex}
								omitText={k === finalIdx}
								errorCount={errorCounts.get(k)}
								onInspectTool={onInspectTool}
								onOpenFile={onOpenFile}
							/>
						))}
					{isLast && retryNotice && <RetryRow text={retryNotice} />}
					{turnLive && streamStartedAt && <WorkingRow startedAt={streamStartedAt} runningTool={runningTool} outputTokens={outputTokens} workingMessage={workingMessage} />}
				</div>
			)}
			{finalIdx >= 0 && <FinalAnswer message={messages[finalIdx]} onFork={onFork} showActions={!isStreaming} turnStartMs={user?.timestamp} />}
		</>
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

export function ChatWindow({
	messages,
	tools,
	queue,
	contextFiles,
	cwd,
	onFork,
	isStreaming = false,
	error,
	connected = true,
	onClearError,
	retryNotice,
	workingMessage,
	stats,
	onOpenTrajectory,
	onOpenFile,
}: {
	messages: WebMessage[];
	tools: Record<string, ToolCardState>;
	queue: { steering: string[]; followUp: string[] };
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
	/** 扩展覆盖的工作中文案（setWorkingMessage） */
	workingMessage?: string | null;
	/** 会话统计：工作指示里显示本轮输出 token */
	stats?: WebStats | null;
	/** 轨迹条目：用于把工具行链接到轨迹 inspector */
	trajectory?: TrajEntry[];
	onOpenTrajectory?: (toolCallId: string) => void;
	/** 在本机编辑器打开工具行涉及的文件 */
	onOpenFile?: (path: string) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);
	const { t } = useI18n();
	// 脱离底部后累计的新内容条数（回到底部按钮上的角标）
	const [unseen, setUnseen] = useState(0);
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
	}, [messages, tools, queue, error, connected, retryNotice, isStreaming]);

	const scrollToBottom = () => {
		const node = scrollRef.current;
		if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
		stickToBottom.current = true;
		setUnseen(0);
	};

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div
				ref={scrollRef}
				className="min-h-0 flex-1 overflow-y-auto"
				onScroll={(event) => {
					const node = event.currentTarget;
					const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
					stickToBottom.current = atBottom;
					if (atBottom) setUnseen(0);
				}}
			>
				<div className="mx-auto flex w-full flex-col px-4 py-6" style={{ maxWidth: "var(--dsh-chat-content-width)" }}>
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
							onInspectTool={onOpenTrajectory}
							onOpenFile={onOpenFile}
						/>
					))}
					{/* 还没有任何消息就已在流式（极少见）：单独给一条工作指示 */}
					{isStreaming && streamStartedAt && turns.length === 0 && (
						<div className="proc-turn">
							<WorkingRow startedAt={streamStartedAt} runningTool={runningTool} outputTokens={stats?.tokens.output} workingMessage={workingMessage} />
						</div>
					)}
					{queue.steering.length + queue.followUp.length > 0 && (
						<div className="mt-3 flex justify-end">
							<div
								className="rounded-full px-3 py-1"
								style={{ fontSize: "var(--piweb-chat-font-t)", color: "var(--dsw-label-caption)", border: "0.5px dashed var(--dsw-border-l3)" }}
							>
								+{queue.steering.length + queue.followUp.length} queued
							</div>
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
			{/* 脱离底部时的“回到底部”浮钮，带新内容角标 */}
			{(unseen > 0 || !stickToBottom.current) && (
				<button
					type="button"
					className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3 py-1.5"
					style={{ fontSize: 12, background: "var(--dsw-glass-popover)", border: "0.5px solid var(--dsw-border-l2)", boxShadow: "var(--dsw-elevation-soft)", color: "var(--dsw-label-secondary)" }}
					onClick={scrollToBottom}
					title={t.backToBottom}
				>
					{/* 圆圈内向下箭头 */}
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden style={{ flex: "none" }}>
						<circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
						<path d="M8 5v6M5.5 8.5L8 11l2.5-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
					{unseen > 0 ? t.newContent.replace("{n}", String(unseen)) : t.backToBottom}
				</button>
			)}
		</div>
	);
}
