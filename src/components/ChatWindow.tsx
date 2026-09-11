"use client";

/**
 * 对话视图 —— 照 dsh 会话流：思考链（◎ Think · 单行预览，点击展开）与
 * 工具调用（工具图标 + 名称 · 参数摘要，点击展开输出）内联交错；
 * 助手正文 markdown 渲染与消息操作行。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
	IconBranchOutline16,
	IconBrowseOutline14,
	IconCheckOutline14,
	IconClockOutline16,
	IconCopyOutline16,
	IconDataOutline16,
	IconEditOutline16,
	IconFileOutline16,
	IconSearchOutline16,
	IconTerminalOutline14,
	IconThinkOutline14,
} from "@/components/icons";
import { DiffView, type DiffLine, parseUnifiedDiff } from "@/components/DiffView";
import { OutlineRail } from "@/components/OutlineRail";
import { useI18n } from "@/i18n";
import type { ToolCardState } from "@/hooks/usePiWeb";
import type { ContextResource, TrajEntry, TrajTokens, WebMessage, WebStats } from "@/lib/types";

function copyText(text: string) {
	void navigator.clipboard?.writeText(text);
}

/** dsh message-chrome formatRunDuration：整秒，分钟档秒数补零 */
function formatRunDuration(ms: number, t: Record<string, string>): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes > 0
		? t.durationMinutes.replace("{minutes}", String(minutes)).replace("{seconds}", String(seconds).padStart(2, "0"))
		: t.durationSeconds.replace("{seconds}", String(seconds));
}

/** dsh message-chrome formatMessageClock 的月日精度版：恒显示 M月d日，跨年补年 */
function formatMessageClock(time: number, t: Record<string, string>): string {
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
function TurnMetaPill({ durationMs, usage, t }: { durationMs: number; usage?: TrajTokens & { cost?: { total?: number } }; t: Record<string, string> }) {
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
				style={{ height: 22, fontSize: 11.5, color: "var(--dsw-label-caption)" }}
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
					<div className="flex flex-col gap-1" style={{ fontSize: 12, color: "var(--dsw-label-secondary)" }}>
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

const RAIL = "⎿";
const MONO = "var(--font-mono)";

/**
 * 结果摘要：照 Claude Code 终端的 ⎿ 行——用行数/匹配数/退出码/最后一行输出概括结果，
 * 而不是把命令再截断显示一遍。
 */
function toolGist(name: string, state: ToolCardState, t: Record<string, string>, diff: DiffLine[] | null): { text: string; lines: string[]; exitCode?: number } {
	const raw = (state.result ?? state.partialResult ?? "").replace(/\r/g, "");
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const n = name.toLowerCase();
	const exitMatch = raw.match(/Command exited with code (\d+)/);
	const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
	const body = lines.filter((l) => !/^Command exited with code \d+/.test(l));
	const count = (k: string, v: number) => t[k].replace("{n}", String(v));
	if (n === "edit" || n === "write") {
		if (diff) {
			const add = diff.filter((l) => l.kind === "add").length;
			const del = diff.filter((l) => l.kind === "del").length;
			return { text: t.diffSummary.replace("{add}", String(add)).replace("{del}", String(del)), lines: body, exitCode };
		}
		return { text: body[0] ?? t.toolWritten, lines: body, exitCode };
	}
	if (n === "grep" || n === "find" || n === "glob" || n === "ls") {
		return { text: body.length ? `${count("toolMatches", body.length)} · ${body[0]}` : t.toolNoOutput, lines: body, exitCode };
	}
	if (n === "read") {
		return { text: body.length ? count("toolLines", body.length) : t.toolNoOutput, lines: body, exitCode };
	}
	const parts: string[] = [];
	if (exitCode !== undefined && exitCode !== 0) parts.push(t.toolExit.replace("{code}", String(exitCode)));
	if (body.length) parts.push(count("toolLines", body.length), body[body.length - 1]);
	return { text: parts.length ? parts.join(" · ") : t.toolNoOutput, lines: body, exitCode };
}

function ToolRow({ name, state, onInspect, onOpenFile }: { name: string; state?: ToolCardState; onInspect?: () => void; onOpenFile?: (path: string) => void }) {
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const running = state?.state === "running";
	const elapsed = useElapsed(state?.startedAt, Boolean(running));
	const output = state?.result ?? state?.partialResult ?? "";
	const n = name.toLowerCase();
	const diff = useMemo(() => {
		if (n !== "edit" && n !== "write") return null;
		return parseUnifiedDiff(state?.patch || output);
	}, [n, output, state?.patch]);
	if (!state) {
		return (
			<div className="flex items-center gap-2 py-1" style={{ fontSize: 13.5, lineHeight: "20px" }}>
				<ToolIcon name={name} />
				<span style={{ color: "var(--dsw-label-tertiary)", fontWeight: 500 }}>{name}</span>
			</div>
		);
	}
	const summary = toolSummary(name, state.args);
	// 悬停显示完整参数（不只是截断的第一行）
	let argsTitle = summary;
	try {
		argsTitle = JSON.stringify(state.args, null, 2).slice(0, 2000);
	} catch {
		/* keep summary */
	}
	const failed = Boolean(state.isError) && !running;
	// read/edit/write：悬停给「在编辑器中打开」
	const argPath = (() => {
		if (!["read", "edit", "write"].includes(n)) return "";
		const a = state.args as { path?: unknown; file_path?: unknown } | undefined;
		const p = a?.path ?? a?.file_path;
		return typeof p === "string" ? p : "";
	})();
	const gist = toolGist(name, state, t as unknown as Record<string, string>, diff);
	const hasDetails = Boolean(output || state.encodingLoss);
	// 失败时直接露出前几行，不需要点开才知道错在哪
	const errorLines = failed ? gist.lines.slice(0, 4) : [];
	const duration = state.startedAt && state.endedAt ? state.endedAt - state.startedAt : 0;
	const railColor = failed ? "var(--dsw-danger)" : "var(--dsw-label-caption)";
	// diff 默认展开：改了什么是最想一眼看到的（像 Claude Code 的 Update 卡）
	const showDiff = diff && !failed && (open || diff.length <= 40);
	return (
		<div className="group/tool py-1" style={{ lineHeight: "20px" }}>
			<div className="flex items-center gap-2" style={{ fontSize: 13.5 }}>
				{running ? (
					<span className="piweb-spin" style={{ display: "inline-flex", flex: "none" }}><ToolIcon name={name} /></span>
				) : (
					<ToolIcon name={name} />
				)}
				<span style={{ fontWeight: 600, color: failed ? "var(--dsw-danger)" : "var(--dsw-label-primary)", flex: "none" }}>{name}</span>
				{summary && (
					<span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5, fontFamily: MONO, color: "var(--dsw-label-secondary)" }} title={argsTitle}>
						{summary}
					</span>
				)}
				{running && <span style={{ fontSize: 12, color: "var(--dsw-label-caption)", flex: "none" }}>{fmtSeconds(elapsed)}</span>}
				{!running && duration >= 1500 && <span style={{ fontSize: 12, color: "var(--dsw-label-caption)", flex: "none" }}>{fmtSeconds(duration)}</span>}
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
			{(hasDetails || running || failed) && (
				<button
					type="button"
					className="flex w-full items-start gap-2 text-left"
					style={{ paddingLeft: 3, cursor: hasDetails ? "pointer" : "default" }}
					onClick={() => hasDetails && setOpen((o) => !o)}
					title={hasDetails ? (open ? t.collapseOutput : t.expandOutput) : undefined}
				>
					<span aria-hidden style={{ flex: "none", width: 14, textAlign: "center", color: railColor, fontFamily: MONO, fontSize: 12.5 }}>{RAIL}</span>
					{failed && errorLines.length ? (
						<span className="min-w-0 flex-1" style={{ fontSize: 12.5, fontFamily: MONO, color: "var(--dsw-danger)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
							{gist.exitCode !== undefined && gist.exitCode !== 0 ? `${t.toolExit.replace("{code}", String(gist.exitCode))}\n` : ""}
							{errorLines.join("\n")}
							{gist.lines.length > errorLines.length ? "\n…" : ""}
						</span>
					) : (
						<span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5, fontFamily: MONO, color: failed ? "var(--dsw-danger)" : "var(--dsw-label-tertiary)" }}>
							{failed ? `${t.toolFailed} · ${gist.text}` : gist.text}
						</span>
					)}
				</button>
			)}
			{showDiff && diff && (
				<div className="mb-1 ml-6 mt-1 max-h-96 overflow-auto rounded-xl px-2 py-1.5" style={{ background: "var(--dsw-hover)" }}>
					{summary && (
						<div className="mb-1 truncate" style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--dsw-label-caption)", borderBottom: "0.5px solid var(--dsw-border-l2)", paddingBottom: 4 }}>
							{summary}
						</div>
					)}
					<DiffView lines={open ? diff : diff.slice(0, 40)} />
				</div>
			)}
			{open && hasDetails && !showDiff && (
				<div
					className="mb-1 ml-6 mt-1 max-h-80 overflow-auto rounded-xl px-3 py-2"
					style={{ background: "var(--dsw-hover)", fontFamily: MONO, fontSize: 12, lineHeight: 1.55, color: failed ? "var(--dsw-danger)" : "var(--dsw-label-secondary)" }}
				>
					{state.encodingLoss && <p className="mb-2 whitespace-normal" style={{ color: "var(--dsw-warning, #d5a13b)" }}>{t.encodingLossWarning}</p>}
					{output && <pre className="whitespace-pre-wrap font-inherit">{output}</pre>}
				</div>
			)}
		</div>
	);
}

// ---------- 思考行：进行中显示流动的斜体正文，完成后收成一行暗色斜体（比工具行低一级） ----------

function ThinkRow({ text, live, startedAt }: { text: string; live?: boolean; startedAt?: number }) {
	const [open, setOpen] = useState(false);
	const { lang, t } = useI18n();
	const elapsed = useElapsed(startedAt, Boolean(live));
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (live) {
		const tail = oneLine.length > 240 ? `…${oneLine.slice(-240)}` : oneLine;
		return (
			<div className="py-1" style={{ lineHeight: "20px" }}>
				<div className="flex items-center gap-2" style={{ fontSize: 13 }}>
					<span className="state-dot running" style={{ width: 6, height: 6 }} />
					<span style={{ color: "var(--dsw-label-tertiary)", fontStyle: "italic" }}>{t.thinkingLive}</span>
					{startedAt && elapsed >= 3000 ? <span style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{fmtSeconds(elapsed)}</span> : null}
				</div>
				{tail && (
					<div className="ml-4" style={{ fontSize: 13, fontStyle: "italic", color: "var(--dsw-label-tertiary)", opacity: 0.85, wordBreak: "break-word" }}>
						{tail}
					</div>
				)}
			</div>
		);
	}
	return (
		<div>
			<button className="flex w-full items-baseline gap-2 py-1 text-left" style={{ lineHeight: "20px" }} onClick={() => setOpen((o) => !o)}>
				<IconThinkOutline14 size={13} style={{ flex: "none", color: "var(--dsw-label-caption)", alignSelf: "center" }} />
				<span style={{ fontSize: 13, color: "var(--dsw-label-tertiary)", fontStyle: "italic", flex: "none" }}>
					{lang === "zh" ? "思考" : "Think"}
				</span>
				{!open && (
					<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, fontStyle: "italic", color: "var(--dsw-label-caption)" }}>
						{oneLine}
					</span>
				)}
			</button>
			{open && (
				<pre
					className="mb-1 ml-6 mt-1 whitespace-pre-wrap rounded-xl px-3 py-2"
					style={{ background: "var(--dsw-hover)", fontSize: 12.5, lineHeight: 1.6, color: "var(--dsw-label-tertiary)", fontFamily: "inherit" }}
				>
					{text}
				</pre>
			)}
		</div>
	);
}

/** 模型返回错误：不能只把正文染红（正文可能为空），要有一条明确的错误行，并给一键重试 */
function ModelErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
	const { t } = useI18n();
	return (
		<div className="flex items-start gap-2 py-1" style={{ lineHeight: "20px", fontSize: 13 }}>
			<span aria-hidden style={{ flex: "none", color: "var(--dsw-danger)", fontWeight: 600 }}>✕</span>
			<span style={{ flex: "none", color: "var(--dsw-danger)", fontWeight: 600 }}>{t.modelError}</span>
			<span className="min-w-0 flex-1" style={{ color: "var(--dsw-danger)", fontFamily: MONO, fontSize: 12.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
				{message}
			</span>
			{onRetry && (
				<button type="button" className="btn-outline" style={{ height: 24, padding: "0 10px", fontSize: 12, flex: "none" }} onClick={onRetry}>
					{t.retry}
				</button>
			)}
		</div>
	);
}

/** 流末尾的工作指示：✻ 轮换动词 (已用时长 · ↓ 输出 token)；有工具在跑时改为「正在运行 xxx」 */
function WorkingIndicator({ startedAt, runningTool, outputTokens }: { startedAt: number; runningTool?: string; outputTokens?: number }) {
	const { t } = useI18n();
	const elapsed = useElapsed(startedAt, true);
	const verbs = t.workingVerbs.split("|");
	const verb = verbs[Math.floor(elapsed / 3000) % verbs.length];
	const label = runningTool ? t.runningTool.replace("{name}", runningTool) : `${verb}…`;
	const meta = [fmtSeconds(elapsed), outputTokens ? `↓ ${fmtTok(outputTokens)} tokens` : ""].filter(Boolean).join(" · ");
	return (
		<div className="mt-2 flex items-center gap-2" style={{ fontSize: 13, lineHeight: "20px" }}>
			<span className="state-dot running" style={{ width: 7, height: 7, background: "var(--dsw-accent)" }} />
			<span style={{ color: "var(--dsw-accent)" }}>{label}</span>
			<span style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>({meta})</span>
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
		<div className="min-w-0">
			<button
				type="button"
				className="flex w-full min-w-0 items-center gap-2 py-1 text-left"
				style={{ lineHeight: "20px" }}
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<IconContextRow />
				<span style={{ flex: "none", fontSize: 13.5, fontWeight: 500, color: "var(--dsw-label-tertiary)" }}>
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
					className="mb-1 ml-6 mt-1 max-h-[141px] overflow-auto whitespace-pre-wrap rounded-lg px-3 py-2.5"
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

/** 行级 memo：流式期间只有最后一条消息变化，历史行全部跳过重渲染 */
const AssistantMessage = memo(function AssistantMessage({
	message,
	tools,
	onFork,
	showActions = true,
	compact = false,
	live = false,
	onRetry,
	onInspectTool,
	onOpenFile,
	turnStartMs,
}: {
	message: WebMessage;
	tools: Record<string, ToolCardState>;
	onFork?: (entryId: string) => void;
	/** 流式输出中隐藏操作行：完整回答后才允许复制/分支 */
	showActions?: boolean;
	/** 同一回合内的后续步骤（上一条也是助手消息，或紧随上下文注入行）：用步骤间距而非回合间距 */
	compact?: boolean;
	/** 这条正在流式生成：思考块以活的斜体正文显示，最后一段正文逐字显示带光标 */
	live?: boolean;
	/** 模型出错时重发上一条用户消息 */
	onRetry?: () => void;
	/** 点工具行右侧图标，在轨迹页打开对应记录 */
	onInspectTool?: (toolCallId: string) => void;
	/** read/edit/write 工具行：在本机编辑器打开该文件 */
	onOpenFile?: (path: string) => void;
	/** 本回合首条用户消息的时间戳：与最终回答时间戳一起算回合耗时（dsh runMs） */
	turnStartMs?: number;
}) {
	const textAll = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
	const isError = message.stopReason === "error";
	// 只有回合的最终回答才显示复制/分支：带工具调用的中间步骤（stopReason=toolUse，
	// 模型常附带仅含换行的空 text 块）和流式未完成（pending）的消息都不算最终回答。
	const hasToolCall = message.content.some((c) => c.type === "toolCall");
	const isFinalAnswer = Boolean(textAll.trim())
		&& !hasToolCall
		&& message.stopReason !== "toolUse"
		&& message.stopReason !== "pending";
	// 正在流式且思考块是最后一个内容块时，它才是"进行中"的思考
	const lastIndex = message.content.length - 1;
	// 一条消息里并发多个工具调用时，先给一行汇总（像 Claude Code 的 "Running N steps…"），再列每个步骤
	const toolCalls = message.content.filter((c): c is { type: "toolCall"; id: string; name: string; arguments: unknown } => c.type === "toolCall");
	const batchRunning = toolCalls.some((c) => tools[c.id]?.state === "running" || !tools[c.id]);
	const { t } = useI18n();

	return (
		<div className={`group w-full first:mt-0 ${compact ? "" : "mt-3"}`} data-role="assistant">
			{toolCalls.length >= 2 && (
				<div className="flex items-center gap-2 py-1" style={{ fontSize: 13, lineHeight: "20px", color: "var(--dsw-label-tertiary)" }}>
					{batchRunning ? <span className="state-dot running" style={{ width: 6, height: 6 }} /> : <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: "var(--dsw-label-caption)", flex: "none" }} />}
					<span>{(batchRunning ? t.batchRunning : t.batchDone).replace("{n}", String(toolCalls.length))}</span>
				</div>
			)}
			{message.content.map((c, i) => {
				if (c.type === "thinking" && c.thinking.trim())
					return <ThinkRow key={i} text={c.thinking} live={live && i === lastIndex} startedAt={message.timestamp} />;
				if (c.type === "toolCall") return <div key={`${c.id}-${i}`} className={toolCalls.length >= 2 ? "ml-4" : undefined}><ToolRow name={c.name} state={tools[c.id]} onInspect={onInspectTool ? () => onInspectTool(c.id) : undefined} onOpenFile={onOpenFile} /></div>;
				if (c.type === "image")
					return <img key={i} src={`data:${c.mimeType};base64,${c.data}`} alt="" className="my-2 max-h-96 max-w-full rounded-2xl object-contain" />;
				if (c.type === "text" && c.text.trim())
					return (
						<div key={i} className="py-1" style={isError ? { color: "var(--dsw-danger)" } : undefined}>
							{live && i === lastIndex ? <StreamingText text={c.text} /> : <Markdown text={c.text} />}
						</div>
					);
				return null;
			})}
			{isError && (message.errorMessage || !textAll.trim()) && (
				<ModelErrorRow message={message.errorMessage || (message.stopReason ?? "error")} onRetry={onRetry} />
			)}
			{isFinalAnswer && showActions && (
				<MessageActions
					text={textAll.trim()}
					onFork={message.id && onFork ? () => onFork(message.id!) : undefined}
					durationMs={message.timestamp != null && turnStartMs != null ? Math.max(0, message.timestamp - turnStartMs) : undefined}
					usage={message.usage}
					time={message.timestamp}
				/>
			)}
		</div>
	);
});

const UserMessage = memo(function UserMessage({
	message,
}: {
	message: WebMessage;
}) {
	const { t } = useI18n();
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
			{text && (
				<MessageActions
					text={text}
					clockStart={message.timestamp !== undefined}
					time={message.timestamp}
				/>
			)}
		</div>
	);
});

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
	onFork,
	isStreaming = false,
	error,
	connected = true,
	onClearError,
	retryNotice,
	stats,
	trajectory,
	onRetry,
	onAbort,
	onOpenTrajectory,
	onOpenFile,
}: {
	messages: WebMessage[];
	tools: Record<string, ToolCardState>;
	queue: { steering: string[]; followUp: string[] };
	contextFiles?: Array<ContextResource | string>;
	onFork?: (entryId: string) => void;
	isStreaming?: boolean;
	/** 行内错误提示（显示在消息流末尾，替代右下角弹窗） */
	error?: string | null;
	connected?: boolean;
	onClearError?: () => void;
	/** 自动重试通知（消息流内折叠行，点击展开详情） */
	retryNotice?: string | null;
	/** 会话统计：工作指示里显示本轮输出 token */
	stats?: WebStats | null;
	/** 轨迹条目：用于把工具行链接到轨迹 inspector */
	trajectory?: TrajEntry[];
	/** 模型出错后重发文本 */
	onRetry?: (text: string) => void;
	/** 停止（用于“停止重试”） */
	onAbort?: () => void;
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
	// 本轮开始时间：工作指示的计时基准（切到流式时记一次）
	const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
	useEffect(() => {
		setStreamStartedAt(isStreaming ? Date.now() : null);
	}, [isStreaming]);
	const runningTool = useMemo(() => Object.values(tools).find((tool) => tool.state === "running")?.name, [tools]);
	const lastAssistantIndex = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === "assistant") return i;
		return -1;
	}, [messages]);

	const rendered = useMemo(() => {
		const firstUser = messages.findIndex((message) => message.role === "user");
		const hasContextGroup = firstUser >= 0 && Boolean(contextFiles?.length);
		// 每条助手消息对应的“上一条用户消息文本”（重试用）
		const lastUserTextBefore = (index: number): string => {
			for (let j = index - 1; j >= 0; j -= 1) {
				const m = messages[j];
				if (m.role === "user") return m.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
			}
			return "";
		};
		// 回合墙钟起点：本回合首条用户消息的时间戳（dsh turn.start 的对应物）。
		// 缺 timestamp（老会话冷读）时返回 undefined，操作行只显示时钟不显示耗时。
		const turnStartBefore = (index: number): number | undefined => {
			for (let j = index - 1; j >= 0; j -= 1) {
				if (messages[j].role === "user") return typeof messages[j].timestamp === "number" ? messages[j].timestamp : undefined;
			}
			return undefined;
		};
		const renderAssistant = (message: WebMessage, index: number, compact: boolean) => (
			<AssistantMessage
				key={`message-${index}`}
				message={message}
				tools={tools}
				onFork={onFork}
				compact={compact}
				live={isStreaming && index === lastAssistantIndex}
				// 整个回合（含工具执行、分段输出）结束前不显示复制/分支
				showActions={!isStreaming}
				onRetry={onRetry && message.stopReason === "error" ? () => onRetry(lastUserTextBefore(index)) : undefined}
				onInspectTool={onOpenTrajectory}
				onOpenFile={onOpenFile}
				turnStartMs={turnStartBefore(index)}
			/>
		);
		// 回合折叠：一轮已结束、中间步骤消息 ≥ 2 且工具调用 ≥ 4 时，把中间步骤收成一行摘要（最终回答保持展开）
		const stepIndexes = new Set<number>();
		const groups: Array<{ start: number; end: number }> = [];
		{
			let i = 0;
			while (i < messages.length) {
				if (messages[i].role !== "assistant") { i += 1; continue; }
				let j = i;
				while (j < messages.length && messages[j].role !== "user") j += 1;
				const assistants: number[] = [];
				for (let k = i; k < j; k += 1) if (messages[k].role === "assistant") assistants.push(k);
				const turnLive = isStreaming && assistants.includes(lastAssistantIndex);
				const last = assistants[assistants.length - 1];
				const lastIsAnswer = last !== undefined && !messages[last].content.some((c) => c.type === "toolCall");
				const steps = lastIsAnswer ? assistants.slice(0, -1) : assistants;
				const toolCount = steps.reduce((n, k) => n + messages[k].content.filter((c) => c.type === "toolCall").length, 0);
				// 出错的回合不折叠：模型报错或任一工具失败时，用户需要直接看到出错前后的完整过程
				const turnFailed = assistants.some((k) => messages[k].stopReason === "error")
					|| assistants.some((k) => messages[k].content.some((c) => c.type === "toolCall" && tools[c.id]?.isError));
				if (!turnLive && !turnFailed && steps.length >= 2 && toolCount >= 4) {
					groups.push({ start: steps[0], end: steps[steps.length - 1] });
					for (const k of steps) stepIndexes.add(k);
				}
				i = j;
			}
		}
		// 垂直节奏：回合之间 16px（mt-3 加行内 4px 内边距），同一回合内的步骤行之间 8px（上下各 4px 内边距）。
		return messages.flatMap((message, index) => {
			let prevIndex = -1;
			for (let j = index - 1; j >= 0; j -= 1) {
				if (messages[j].role === "user" || messages[j].role === "assistant") {
					prevIndex = j;
					break;
				}
			}
			// 上一条可见消息也是助手（工具调用后的续写），或紧随首条用户消息下的上下文注入行：同属一个回合
			const compact = prevIndex >= 0 && (messages[prevIndex].role === "assistant" || (hasContextGroup && prevIndex === firstUser));
			const group = groups.find((g) => g.start === index);
			let row: React.ReactNode = null;
			if (group) {
				const stepMessages: number[] = [];
				for (let k = group.start; k <= group.end; k += 1) if (stepIndexes.has(k)) stepMessages.push(k);
				row = (
					<StepsGroup key={`steps-${index}`} messages={stepMessages.map((k) => messages[k])} tools={tools} compact={compact}>
						{stepMessages.map((k, n) => renderAssistant(messages[k], k, n > 0 || compact))}
					</StepsGroup>
				);
			} else if (stepIndexes.has(index)) {
				row = null;
			} else if (message.role === "user") {
				row = <UserMessage key={`message-${index}`} message={message} />;
			} else if (message.role === "assistant") {
				row = renderAssistant(message, index, compact);
			}
			if (index !== firstUser || !contextFiles?.length) return row ? [row] : [];
			// 多条上下文注入行收进同一容器，与下方助手消息的思考/工具行共用步骤间距（视觉上同属一组）
			return [
				...(row ? [row] : []),
				<div key="context-group" className="mt-3 flex flex-col">
					{contextFiles.map((resource, resourceIndex) => (
						<ContextRow
							key={`context-${typeof resource === "string" ? resource : `${resource.source}-${resource.path}`}-${resourceIndex}`}
							resource={resource}
						/>
					))}
				</div>,
			];
		});
	}, [contextFiles, isStreaming, lastAssistantIndex, messages, onFork, onOpenFile, onOpenTrajectory, onRetry, tools]);

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
					{rendered}
					{isStreaming && streamStartedAt && <WorkingIndicator startedAt={streamStartedAt} runningTool={runningTool} outputTokens={stats?.tokens.output} />}
					{queue.steering.length + queue.followUp.length > 0 && (
						<div className="mt-3 flex justify-end">
							<div
								className="rounded-full px-3 py-1"
								style={{ fontSize: 12, color: "var(--dsw-label-caption)", border: "0.5px dashed var(--dsw-border-l3)" }}
							>
								+{queue.steering.length + queue.followUp.length} queued
							</div>
						</div>
					)}
					{/* 自动重试通知：消息流内折叠行，点击展开错误详情；可一键停止 */}
					{retryNotice && <RetryRow text={retryNotice} onStop={onAbort} />}
					{/* 重连提示：跟随消息流显示在最后一条输出下面 */}
					{!connected && (
						<div className="mt-3 flex justify-center">
							<div
								className="rounded-full px-3 py-1"
								style={{ fontSize: 12, color: "var(--dsw-label-caption)", border: "0.5px dashed var(--dsw-border-l3)" }}
							>
								{t.reconnecting}
							</div>
						</div>
					)}
					{error && (
						<button
							className="mt-3 rounded-xl px-3 py-2 text-left"
							style={{ fontSize: 12.5, background: "var(--dsw-danger)", color: "white" }}
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

// ---------- 已完成回合的中间步骤折叠：一行摘要，点开看全部 ----------

function StepsGroup({ messages, tools, compact, children }: { messages: WebMessage[]; tools: Record<string, ToolCardState>; compact: boolean; children: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const calls = messages.flatMap((m) => m.content.filter((c): c is { type: "toolCall"; id: string; name: string; arguments: unknown } => c.type === "toolCall"));
	const isFile = (n: string) => ["read", "edit", "write"].includes(n.toLowerCase());
	const isCmd = (n: string) => ["bash", "powershell", "pwsh"].includes(n.toLowerCase());
	const files = calls.filter((c) => isFile(c.name)).length;
	const cmds = calls.filter((c) => isCmd(c.name)).length;
	const failed = calls.some((c) => tools[c.id]?.isError);
	let start = Infinity;
	let end = 0;
	for (const c of calls) {
		const s = tools[c.id];
		if (s?.startedAt) start = Math.min(start, s.startedAt);
		if (s?.endedAt) end = Math.max(end, s.endedAt);
	}
	const duration = Number.isFinite(start) && end > start ? end - start : 0;
	const summary = t.turnSummary.replace("{steps}", String(calls.length)).replace("{files}", String(files)).replace("{cmds}", String(cmds));
	return (
		<div className={`w-full first:mt-0 ${compact ? "" : "mt-3"}`}>
			<button
				type="button"
				className="flex w-full items-center gap-2 py-1 text-left"
				style={{ lineHeight: "20px", fontSize: 13, color: "var(--dsw-label-tertiary)" }}
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
			>
				<span aria-hidden style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms var(--ds-ease-in-out)", width: 14, justifyContent: "center", color: failed ? "var(--dsw-danger)" : "var(--dsw-label-caption)" }}>▸</span>
				<span className="min-w-0 flex-1 truncate">
					{summary}
					{duration >= 1500 ? ` · ${fmtSeconds(duration)}` : ""}
					{failed ? ` · ${t.toolFailed}` : ""}
				</span>
				<span style={{ fontSize: 12, color: "var(--dsw-label-caption)", flex: "none" }}>{open ? t.hideSteps : t.showSteps}</span>
			</button>
			{open && <div className="ml-1 border-l pl-3" style={{ borderColor: "var(--dsw-border-l2)" }}>{children}</div>}
		</div>
	);
}

// ---------- 自动重试行（对齐思考行的点击展开交互） ----------

function RetryRow({ text, onStop }: { text: string; onStop?: () => void }) {
	const [open, setOpen] = useState(false);
	const { t } = useI18n();
	const oneLine = text.replace(/\s+/g, " ").trim();
	return (
		<div>
			<div className="flex w-full items-center gap-2 py-1" style={{ lineHeight: "20px" }}>
				<button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
					<span
						className="state-dot"
						style={{ width: 6, height: 6, flex: "none", background: "var(--dsw-warn)" }}
						aria-hidden
					/>
					<span style={{ fontSize: 13, fontWeight: 500, color: "var(--dsw-warn)", flex: "none" }}>
						{oneLine.split("：")[0]}
					</span>
					<span style={{ fontSize: 13, color: "var(--dsw-label-caption)", flex: "none" }}>·</span>
					{!open && (
						<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, color: "var(--dsw-label-tertiary)" }}>
							{oneLine.split("：").slice(1).join("：") || oneLine}
						</span>
					)}
				</button>
				{onStop && (
					<button type="button" className="btn-outline" style={{ height: 24, padding: "0 10px", fontSize: 12, flex: "none" }} onClick={onStop}>
						{t.stopRetry}
					</button>
				)}
			</div>
			{open && (
				<pre
					className="mb-1 ml-6 mt-1 whitespace-pre-wrap rounded-xl px-3 py-2"
					style={{ background: "var(--dsw-hover)", fontSize: 12.5, lineHeight: 1.6, color: "var(--dsw-label-tertiary)", fontFamily: "inherit" }}
				>
					{text}
				</pre>
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
