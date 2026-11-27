"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


/** 上下文总量是 SDK 估算；API 输入用量与内容字符分类分别展示，不能按比例分摊 token。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ContextInspectorModal } from "@/components/ContextInspectorModal";
import { useI18n } from "@/i18n";
import { inContextMessages, type ContextCategoryKey, type ContextMessageLike } from "@/lib/effective-context";
import { fmtPercent, fmtTokens } from "@/lib/format";
import { formatCapacity, parseCapacity } from "@/lib/model-draft";
import { classifyMessageChars } from "@/lib/process-format";
import type { ContextBreakdown, TrajTokens } from "@/lib/types";

type ContextMessage = ContextMessageLike & {
	usage?: TrajTokens;
};

type ContextSource = {
	systemChars: number;
	/** 直接传入消息（测试 / 静态场景） */
	messages?: ContextMessage[];
	/** 惰性取最新消息：打开弹窗时才读，父组件流式更新不需要换 source 引用 */
	getMessages?: () => ContextMessage[];
	breakdown?: ContextBreakdown;
	compacted?: boolean;
	loadFull?: () => Promise<unknown> | unknown;
	/** 会话 ID：点击颜色条或分类行时从服务端读取真正的有效上下文投影 */
	sessionId?: string | null;
};

const EMPTY_MESSAGES: ContextMessage[] = [];

export function ContextMeter({ percent, tokens, contextWindow, model, source, label }: {
	percent: number | null;
	tokens: number | null;
	contextWindow: number | null;
	/** 当前会话的模型：有它才能在弹窗里改上下文窗口 */
	model?: { provider: string; id: string } | null;
	/** 覆盖「上下文估算」这个措辞：拿到真实用量时不该叫估算 */
	label?: string;
	source?: ContextSource;
}) {
	const [open, setOpen] = useState(false);
	const [counting, setCounting] = useState(false);
	const [hoverKey, setHoverKey] = useState<string | null>(null);
	const [inspectCategory, setInspectCategory] = useState<ContextCategoryKey | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const { t } = useI18n();
	const cold = Boolean(source?.breakdown?.cold);

	useEffect(() => { if (!cold) setCounting(false); }, [cold]);
	useEffect(() => {
		if (!open) return;
		const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [open]);

	// 刚改过窗口：服务端已落盘，但页面上的 contextWindow 还是改之前的值（冷会话要等下一次快照）。
	// 在它变之前先显示刚保存的值；contextWindow 一变（快照 / 用量追上来，或别处改了）就以 props 为准。
	const modelKey = model ? `${model.provider}/${model.id}` : "";
	const [applied, setApplied] = useState<{ key: string; from: number; value: number } | null>(null);
	useEffect(() => {
		if (applied && (applied.key !== modelKey || contextWindow !== applied.from)) setApplied(null);
	}, [applied, modelKey, contextWindow]);
	const override = applied && applied.key === modelKey && contextWindow === applied.from ? applied.value : null;

	const known = tokens !== null && Number.isFinite(tokens) && tokens >= 0;
	const used = known ? tokens : 0;
	const window_ = override ?? contextWindow ?? 0;
	const recomputed = override !== null && known;
	const p = recomputed ? used / override * 100 : percent ?? 0;

	const hasCompactedBreakdown = Boolean(source?.compacted || (source?.breakdown?.characters?.compacted ?? 0) > 0 || (source?.breakdown?.compacted ?? 0) > 0);
	// 流式期间只在打开弹窗后扫描；仅在刚压缩且尚无新回合 API 用量时读取最新上下文消息以算圆环估算值。
	const shouldReadClosed = window_ > 0 && tokens === null && percent === null && hasCompactedBreakdown;
	const messages = (open || shouldReadClosed || (inspectCategory !== null && !source?.sessionId))
		? source?.getMessages?.() ?? source?.messages ?? EMPTY_MESSAGES
		: EMPTY_MESSAGES;
	const context = useMemo(() => inContextMessages(messages), [messages]);
	const chars = useMemo(() => classifyMessageChars(context.messages), [context]);
	const lastUsage = useMemo(() => context.messages.findLast((m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && m.stopReason !== "pending" &&
		(context.since === undefined || (m.timestamp ?? 0) >= context.since) &&
		(m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0) + (m.usage?.output ?? 0) > 0)?.usage, [context]);
	const measuredInput = lastUsage ? (lastUsage.input ?? 0) + (lastUsage.cacheRead ?? 0) + (lastUsage.cacheWrite ?? 0) : null;

	const r = 5.5;
	const circumference = 2 * Math.PI * r;
	const reserved = Math.max(0, source?.breakdown?.autoCompactBuffer ?? 0);
	/**
	 * 进度条与 Free Space 的「已用」基准：优先最近一次请求的真实输入（API 报的），
	 * 没测到才退回 SDK 估算；两者都没有且处于压缩后等待下轮回复期间，则按字符/4估算。
	 */
	const anchor = window_ > 0 ? (measuredInput !== null ? Math.min(measuredInput, window_) : known ? Math.min(used, window_) : null) : null;
	// 超过窗口时预留不再画到窗口外；非压缩导致的用量未知仍不能将整扇窗口显示为 Free Space。
	const free = anchor === null ? null : Math.max(0, window_ - anchor - reserved);
	const serverMsgChars = source?.breakdown?.messageCharacters;
	const effectiveChars = serverMsgChars ?? chars;
	const b = source?.breakdown?.characters;
	const rows: Array<{ key: ContextCategoryKey; label: string; value: number | undefined; color: string }> = [
		{ key: "system", label: t.contextSystemPrompt, value: b?.systemPrompt, color: "#3b82f6" },
		{ key: "builtin", label: t.contextSystemTools, value: b?.systemTools, color: "#8b5cf6" },
		{ key: "custom", label: t.contextCustomTools, value: b?.customTools, color: "#a855f7" },
		{ key: "memory", label: t.contextMemory, value: b?.memory, color: "#06b6d4" },
		{ key: "skills", label: t.contextSkills, value: b?.skills, color: "#10b981" },
		{ key: "user", label: t.contextUserMessages, value: effectiveChars.user, color: "#22c55e" },
		{ key: "text", label: t.contextAgentText, value: effectiveChars.agentText, color: "#84cc16" },
		{ key: "thinking", label: t.contextAgentThinking, value: effectiveChars.agentThinking, color: "#eab308" },
		{ key: "call", label: t.contextAgentToolCall, value: effectiveChars.agentToolCall, color: "#f97316" },
		{ key: "output", label: t.contextToolOutput, value: effectiveChars.toolOutput, color: "#f59e0b" },
		{ key: "compacted", label: t.contextCompacted, value: b?.compacted, color: "#ec4899" },
	];
	const visibleRows = rows
		.filter((row) => row.value !== undefined && row.value > 0)
		.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
	const charTotal = visibleRows.reduce((sum, row) => sum + (row.value ?? 0), 0);
	const isPostCompaction = hasCompactedBreakdown || context.since !== undefined;
	/**
	 * 压缩后、下一次模型响应返回真实 API usage 之前：真实 token 与 SDK 估算均为 null，
	 * 此处按当前保留内容与摘要总字符 / 4 近似估算，同步反馈在圆环、进度条和 Free Space 上。
	 */
	const estimatedFromChars = anchor === null && window_ > 0 && isPostCompaction && charTotal > 0 ? Math.min(window_, Math.ceil(charTotal / 4)) : null;
	const postCompactionPercent = estimatedFromChars !== null && window_ > 0 ? Math.max(0, Math.min(100, estimatedFromChars / window_ * 100)) : null;
	const ringPercent = postCompactionPercent ?? p;
	const usageLabel = postCompactionPercent !== null
		? `${fmtPercent(postCompactionPercent)} ${t.contextCompactedEstimated}`
		: percent === null && !recomputed
			? t.contextUnknown
			: `${fmtPercent(p)} ${label ?? t.contextEstimated}`;
	const barAnchor = anchor ?? estimatedFromChars;
	const barReserved = barAnchor === null ? 0 : Math.min(reserved, Math.max(0, window_ - barAnchor));
	const displayFree = free ?? (estimatedFromChars !== null ? Math.max(0, window_ - estimatedFromChars - reserved) : null);
	const segments = barAnchor === null || charTotal === 0 ? [] : visibleRows.map((row) => ({
		key: row.key,
		label: row.label,
		value: row.value as number,
		color: row.color,
		width: barAnchor / window_ * 100 * ((row.value as number) / charTotal),
	}));
	const openInspector = (key: ContextCategoryKey) => {
		setOpen(false);
		setHoverKey(null);
		setInspectCategory(key);
	};
	const categoryMeta = visibleRows.map((row) => ({
		key: row.key,
		label: row.label,
		color: row.color,
		chars: row.value ?? 0,
	}));

	return (
		<div ref={ref} className="relative">
			<button className="icon-btn isx-ring-btn" style={{ width: 28, height: 28 }} title={usageLabel} aria-label={usageLabel} onClick={() => setOpen((o) => !o)}>
				<svg width="14" height="14" viewBox="0 0 14 14">
					<circle cx="7" cy="7" r={r} fill="none" stroke="var(--dsw-border-l3)" strokeWidth="2" />
					<circle cx="7" cy="7" r={r} fill="none" stroke={ringPercent > 85 ? "var(--dsw-warn)" : "var(--dsw-label-primary)"} strokeWidth="2"
						strokeDasharray={`${circumference * Math.max(0, Math.min(100, ringPercent)) / 100} ${circumference}`} transform="rotate(-90 7 7)" strokeLinecap="round" />
				</svg>
			</button>
			{open && (
				/* 弹窗右下角对齐在直径 28px 的圆环上，而圆环离屏幕右缘还有 60-70px：固定
				   w-72(288px) 在 ≤360px 的手机会往左顶出屏幕（实测 344px 下 left=-15）。
				   .pw-context-popover 不是给本仓 CSS 用的，是「远程连接」注入的 mobile-fit.css
				   认的钩子 —— 它用 calc(100vw-96px) + !important 压过那里的 .popover 兜底，重命名
				   或删掉这个类会让手机端重新冒出溢出。 */
				<div className="pw-context-popover popover absolute bottom-9 right-0 z-50 w-72 max-w-[calc(100vw-96px)] p-4" style={{ fontSize: "var(--dsh-content-font-size-secondary)" }}>
					{measuredInput !== null && <div className="mt-1 flex items-center justify-between gap-2" style={{ fontVariantNumeric: "tabular-nums" }}><span style={{ color: "var(--dsw-label-secondary)", fontWeight: 500 }}>{t.contextApiInput}</span><span title={`${measuredInput} tok`} style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--dsw-label-primary)" }}>{fmtTokens(measuredInput)} tok</span></div>}
					{measuredInput === null && estimatedFromChars !== null && <div className="mt-1 flex items-center justify-between gap-2" style={{ fontVariantNumeric: "tabular-nums" }}><span style={{ color: "var(--dsw-label-secondary)", fontWeight: 500 }}>{t.contextCompactedEstimateLabel}</span><span title={`${estimatedFromChars} tok`} style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--dsw-label-primary)" }}>~{fmtTokens(estimatedFromChars)} tok</span></div>}
					{window_ > 0 && (
						<div className="pw-agent-limits-bar mt-3 flex h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--dsw-selector)" }} data-testid="context-bar" aria-hidden onMouseLeave={() => setHoverKey(null)}>
							{segments.map((segment) => (
								<span key={segment.key} data-segment={segment.key} data-clickable="true" className="pw-agent-limits-seg flex-none" title={`${segment.label}：${fmtTokens(segment.value)} ${t.contextChars} · ${t.contextInspectorClickHint}`}
									onMouseEnter={() => setHoverKey(segment.key)}
									onClick={(e) => { e.stopPropagation(); openInspector(segment.key); }}
									style={{ width: `${segment.width}%`, background: segment.color, opacity: hoverKey && hoverKey !== segment.key ? 0.32 : 1 }} />
							))}
							{barReserved > 0 && <span data-segment="reserved" className="pw-agent-limits-seg flex-none" onMouseEnter={() => setHoverKey("reserved")} style={{ width: `${barReserved / window_ * 100}%`, background: "var(--dsw-border-l3)", opacity: hoverKey && hoverKey !== "reserved" ? 0.32 : 1 }} />}
						</div>
					)}
					<div className="mt-2.5 flex flex-col gap-1" style={{ color: "var(--dsw-label-tertiary)" }}>
						{reserved > 0 && <DataRow itemKey="reserved" active={hoverKey === "reserved"} dimmed={hoverKey !== null && hoverKey !== "reserved"} onHover={setHoverKey} label={t.contextAutoCompactBuffer} value={`${fmtTokens(reserved)} tok`} exact={`${reserved} tok`} color="var(--dsw-border-l3)" />}
						{window_ > 0 && <DataRow label={t.contextFreeSpace} value={displayFree === null ? "—" : `~${fmtTokens(displayFree)} tok`} exact={displayFree !== null ? `${displayFree} tok` : undefined} color="var(--dsw-selector)" />}
					</div>
					{estimatedFromChars !== null && (
						<div className="mt-2" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))", color: "var(--dsw-label-caption)" }}>
							{t.contextPostCompactionHint}
						</div>
					)}
					{/* 进度条的图例：颜色跟上面的分段一一对应，数字是真实字符数；点击对应行查看该类当前有效内容 */}
					<div className="mt-2.5 flex flex-col gap-1" style={{ color: "var(--dsw-label-tertiary)" }} onMouseLeave={() => setHoverKey(null)}>
						{visibleRows.map((row) => <DataRow key={row.key} itemKey={row.key} active={hoverKey === row.key} dimmed={hoverKey !== null && hoverKey !== row.key} onHover={setHoverKey} onClick={() => openInspector(row.key)} clickHint={t.contextInspectorClickHint} label={row.label} value={`${fmtTokens(row.value!)} ${t.contextChars}`} exact={`${row.value} ${t.contextChars}`} color={row.color} />)}
					</div>
					{cold && source?.loadFull && (
						<div className="mt-3 flex items-center justify-between gap-2" style={{ color: "var(--dsw-label-tertiary)" }}>
							<span className="min-w-0" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))" }}>{t.contextColdHint}</span>
							<button type="button" className="btn-outline flex-none" style={{ height: "max(24px, calc(24px + var(--dsh-content-font-delta)))", padding: "0 10px", fontSize: "var(--dsh-ui-font-xs)" }} disabled={counting}
								onClick={() => {
									setCounting(true);
									void Promise.resolve(source.loadFull?.()).then((result) => {
										if ((result as { success?: boolean } | undefined)?.success === false) setCounting(false);
									}, () => setCounting(false));
								}}>{counting ? t.contextCounting : t.contextCountNow}</button>
						</div>
					)}
					{model && window_ > 0 && (
						<WindowEditor key={modelKey} model={model} value={window_} onSaved={(value) => setApplied({ key: modelKey, from: contextWindow ?? 0, value })} />
					)}
				</div>
			)}
			<ContextInspectorModal
				open={inspectCategory !== null}
				initialCategory={inspectCategory ?? "system"}
				categoryMeta={categoryMeta}
				messages={messages}
				model={model}
				sessionId={source?.sessionId}
				refreshKey={source?.breakdown}
				cold={cold}
				onLoadFull={source?.loadFull}
				onClose={() => setInspectCategory(null)}
			/>
		</div>
	);
}

async function postModels<T>(body: Record<string, unknown>): Promise<T> {
	const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const payload = (await response.json().catch(() => null)) as { success?: boolean; data?: T; error?: string } | null;
	if (!response.ok || !payload?.success) throw new Error(payload?.error || `request failed (${response.status})`);
	return payload.data as T;
}

/**
 * 弹窗底部的上下文窗口：平时显示精确值，「修改」后填数字保存。
 * 不用滑块：模型的真实上限是 128000、200000 这类精确值，拖出来的近似值多一点上游就 400。
 * 内置目录有原值就并排给出、填大了提醒；改的是该模型的全局配置，这一点写在输入框下面。
 */
function WindowEditor({ model, value, onSaved }: { model: { provider: string; id: string }; value: number; onSaved: (value: number) => void }) {
	const { t } = useI18n();
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState("");
	/** undefined = 还在查（不显示上限提示，免得先闪一句「没有内置值」） */
	const [builtin, setBuiltin] = useState<number | null | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const infoSeq = useRef(0);
	const parsed = parseCapacity(text);
	const target = parsed !== undefined && !Number.isNaN(parsed) ? parsed : null;
	const valid = target !== null;
	const over = target !== null && typeof builtin === "number" && target > builtin;
	const exact = (n: number) => n.toLocaleString("en-US");

	const begin = () => {
		setEditing(true);
		setText(formatCapacity(value));
		setError(null);
		setBuiltin(undefined);
		const seq = ++infoSeq.current;
		void postModels<{ builtin: number | null }>({ action: "contextWindowInfo", providerId: model.provider, modelId: model.id }).then(
			(info) => { if (seq === infoSeq.current) setBuiltin(info.builtin); },
			() => { if (seq === infoSeq.current) setBuiltin(null); },
		);
	};
	const cancel = () => {
		infoSeq.current += 1;
		setEditing(false);
	};
	const save = async () => {
		if (target === null || saving) return;
		setSaving(true);
		setError(null);
		try {
			const info = await postModels<{ contextWindow: number }>({ action: "setContextWindow", providerId: model.provider, modelId: model.id, contextWindow: target });
			onSaved(info.contextWindow);
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	if (!editing) {
		return (
			<div className="hairline-t mt-3 flex items-center justify-between gap-2 pt-3" style={{ color: "var(--dsw-label-tertiary)" }}>
				<span>{t.contextWindowLabel}</span>
				<span className="flex items-center gap-2">
					<span style={{ color: "var(--dsw-label-secondary)", fontFamily: "var(--font-mono)" }}>{exact(value)}</span>
					<button type="button" className="btn-outline" style={{ height: "max(22px, calc(22px + var(--dsh-content-font-delta)))", padding: "0 8px", fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))" }} onClick={begin}>{t.contextWindowEdit}</button>
				</span>
			</div>
		);
	}
	return (
		<div className="hairline-t mt-3 pt-3" style={{ color: "var(--dsw-label-tertiary)" }}>
			<div>{t.contextWindowLabel}</div>
			<div className="mt-1.5 flex items-center gap-1.5">
				<input
					autoFocus
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.nativeEvent.isComposing || e.keyCode === 229) return;
						if (e.key === "Enter") {
							e.preventDefault();
							void save();
						} else if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							cancel();
						}
					}}
					aria-label={t.contextWindowLabel}
					aria-invalid={!valid}
					spellCheck={false}
					className="min-w-0 flex-1 rounded-md px-2"
					style={{ height: "max(26px, calc(26px + var(--dsh-content-font-delta)))", fontSize: "var(--dsh-ui-font-125)", fontFamily: "var(--font-mono)", color: "var(--dsw-label-primary)", background: "var(--dsw-hover)", border: `0.5px solid ${valid ? "var(--dsw-border-l2)" : "var(--dsw-danger)"}` }}
				/>
				<button type="button" className="btn-primary-white flex-none" style={{ height: "max(26px, calc(26px + var(--dsh-content-font-delta)))", padding: "0 10px", fontSize: "var(--dsh-ui-font-xs)" }} disabled={!valid || saving} onClick={() => void save()}>
					{saving ? t.saving : t.save}
				</button>
				<button type="button" className="btn-outline flex-none" style={{ height: "max(26px, calc(26px + var(--dsh-content-font-delta)))", padding: "0 10px", fontSize: "var(--dsh-ui-font-xs)" }} disabled={saving} onClick={cancel}>{t.cancel}</button>
			</div>
			{typeof builtin === "number" && (
				<div className="mt-1.5 flex items-center gap-1.5" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))" }}>
					<span>{t.contextWindowBuiltin.replace("{value}", exact(builtin))}</span>
					{target !== builtin && (
						<button type="button" className="underline" style={{ color: "var(--dsw-label-secondary)" }} onClick={() => setText(formatCapacity(builtin))}>{t.contextWindowUseBuiltin}</button>
					)}
				</div>
			)}
			{!valid ? (
				<div className="mt-1" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))", color: "var(--dsw-danger)" }}>{t.contextWindowInvalid}</div>
			) : over ? (
				<div className="mt-1" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))", color: "var(--dsw-warn)" }}>{t.contextWindowOverBuiltin}</div>
			) : builtin === null ? (
				<div className="mt-1" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))" }}>{t.contextWindowNoBuiltin}</div>
			) : null}
			<div className="mt-1" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))" }}>{t.contextWindowScope}</div>
			{error && <div className="mt-1" role="alert" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))", color: "var(--dsw-danger)" }}>{error}</div>}
		</div>
	);
}

function DataRow({ label, value, exact, color, itemKey, active, dimmed, onHover, onClick, clickHint }: { label: string; value: string; exact?: string; color: string; itemKey?: string; active?: boolean; dimmed?: boolean; onHover?: (key: string | null) => void; onClick?: () => void; clickHint?: string }) {
	const inner = (
		<>
			<span className="flex items-center gap-1.5"><span className="pw-agent-limits-dot inline-block rounded-full" style={{ width: 8, height: 8, background: color, boxShadow: active ? `0 0 8px ${color}` : undefined }} />{label}</span>
			<span title={exact} style={{ fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-mono)", fontSize: "0.94em" }}>{value}</span>
		</>
	);
	if (onClick) {
		return (
			<button
				type="button"
				className="pw-agent-limits-row pw-agent-limits-row-clickable flex w-full items-center justify-between gap-2 text-left"
				data-active={active || undefined}
				data-dimmed={dimmed || undefined}
				title={clickHint}
				onMouseEnter={itemKey && onHover ? () => onHover(itemKey) : undefined}
				onMouseLeave={itemKey && onHover ? () => onHover(null) : undefined}
				onClick={onClick}
			>
				{inner}
			</button>
		);
	}
	return <div
		className="pw-agent-limits-row flex items-center justify-between gap-2"
		data-active={active || undefined}
		data-dimmed={dimmed || undefined}
		onMouseEnter={itemKey && onHover ? () => onHover(itemKey) : undefined}
		onMouseLeave={itemKey && onHover ? () => onHover(null) : undefined}
	>
		{inner}
	</div>;
}
