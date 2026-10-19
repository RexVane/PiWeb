"use client";

/** 上下文总量是 SDK 估算；API 输入用量与内容字符分类分别展示，不能按比例分摊 token。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { fmtPercent, fmtTokens } from "@/lib/format";
import { formatCapacity, parseCapacity } from "@/lib/model-draft";
import { classifyMessageChars } from "@/lib/process-format";
import type { ContextBreakdown, TrajTokens } from "@/lib/types";

type ContextMessage = {
	role?: string;
	content: Array<{ type: string; text?: string; thinking?: string; arguments?: unknown; name?: string }>;
	usage?: TrajTokens;
	stopReason?: string;
	timestamp?: number;
	summaryKind?: string;
};

/**
 * 消息列表会照常显示压缩前的历史，但模型上下文只从最近一张压缩卡往后算（卡片以上只剩摘要，已计入 compacted）。
 * 保留下来的旧助手消息用量是压缩前那次请求的，也不能当「最近一次输入」。
 */
function inContext(messages: ContextMessage[]): { messages: ContextMessage[]; since?: number } {
	const at = messages.findLastIndex((m) => m.role === "summary" && m.summaryKind === "compaction");
	return at < 0 ? { messages } : { messages: messages.slice(at + 1), since: messages[at].timestamp };
}

export function ContextMeter({ percent, tokens, contextWindow, model, source, label }: {
	percent: number | null;
	tokens: number | null;
	contextWindow: number | null;
	/** 当前会话的模型：有它才能在弹窗里改上下文窗口 */
	model?: { provider: string; id: string } | null;
	/** 覆盖「上下文估算」这个措辞：拿到真实用量时不该叫估算 */
	label?: string;
	source?: {
		systemChars: number;
		messages: ContextMessage[];
		breakdown?: ContextBreakdown;
		loadFull?: () => Promise<unknown> | unknown;
	};
}) {
	const [open, setOpen] = useState(false);
	const [counting, setCounting] = useState(false);
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

	// 流式期间只在打开弹窗后扫描，分类是实际文本字符数，不是假设的 token 数。
	const context = useMemo(() => inContext(open ? source?.messages ?? [] : []), [open, source]);
	const chars = useMemo(() => classifyMessageChars(context.messages), [context]);
	const lastUsage = useMemo(() => context.messages.findLast((m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && m.stopReason !== "pending" &&
		(context.since === undefined || (m.timestamp ?? 0) >= context.since) &&
		(m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0) + (m.usage?.output ?? 0) > 0)?.usage, [context]);
	const measuredInput = lastUsage ? (lastUsage.input ?? 0) + (lastUsage.cacheRead ?? 0) + (lastUsage.cacheWrite ?? 0) : null;

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
	/** 圆环与悬停提示仍用 SDK 估算（那是「占窗口多少」），弹窗正文只留 API 出来的真实数字 */
	const usageLabel = percent === null && !recomputed ? t.contextUnknown : `${fmtPercent(p)} ${label ?? t.contextEstimated}`;
	const r = 5.5;
	const circumference = 2 * Math.PI * r;
	const reserved = Math.max(0, source?.breakdown?.autoCompactBuffer ?? 0);
	/**
	 * 进度条与 Free Space 的「已用」基准：优先最近一次请求的真实输入（API 报的），
	 * 没测到才退回 SDK 估算；两者都没有就不画（未知不能当空闲）。
	 */
	const anchor = window_ > 0 ? (measuredInput !== null ? Math.min(measuredInput, window_) : known ? Math.min(used, window_) : null) : null;
	// 超过窗口时预留不再画到窗口外；用量未知不能将整扇窗口显示为 Free Space。
	const visibleReserved = anchor === null ? 0 : Math.min(reserved, Math.max(0, window_ - anchor));
	const free = anchor === null ? null : Math.max(0, window_ - anchor - reserved);
	const b = source?.breakdown?.characters;
	const rows = [
		{ key: "system", label: t.contextSystemPrompt, value: b?.systemPrompt, color: "var(--dsw-accent)" },
		{ key: "builtin", label: t.contextSystemTools, value: b?.systemTools, color: "#8B7EC8" },
		{ key: "custom", label: t.contextCustomTools, value: b?.customTools, color: "#B39DDB" },
		{ key: "memory", label: t.contextMemory, value: b?.memory, color: "#5FA8D3" },
		{ key: "skills", label: t.contextSkills, value: b?.skills, color: "#4FB286" },
		{ key: "user", label: t.contextUserMessages, value: chars.user, color: "var(--dsw-success)" },
		{ key: "text", label: t.contextAgentText, value: chars.agentText, color: "#7BC96F" },
		{ key: "thinking", label: t.contextAgentThinking, value: chars.agentThinking, color: "#C9A66B" },
		{ key: "call", label: t.contextAgentToolCall, value: chars.agentToolCall, color: "#D3A15F" },
		{ key: "output", label: t.contextToolOutput, value: chars.toolOutput, color: "var(--dsw-warn)" },
		{ key: "compacted", label: t.contextCompacted, value: b?.compacted, color: "#A05A78" },
	].filter((row) => row.value !== undefined && row.value > 0);
	const charTotal = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
	/**
	 * 进度条整条 = 全部上下文窗口：已用那一截按各类**字符数比例**分段（API 不给分类 token，
	 * 所以只摊比例、不报每类的 token 数），剩下的部分就是背景色的 Free Space。
	 */
	const segments = anchor === null || charTotal === 0 ? [] : rows.map((row) => ({
		key: row.key,
		label: row.label,
		value: row.value as number,
		color: row.color,
		width: anchor / window_ * 100 * ((row.value as number) / charTotal),
	}));

	return (
		<div ref={ref} className="relative">
			<button className="icon-btn isx-ring-btn" style={{ width: 28, height: 28 }} title={usageLabel} aria-label={usageLabel} onClick={() => setOpen((o) => !o)}>
				<svg width="14" height="14" viewBox="0 0 14 14">
					<circle cx="7" cy="7" r={r} fill="none" stroke="var(--dsw-border-l3)" strokeWidth="2" />
					<circle cx="7" cy="7" r={r} fill="none" stroke={p > 85 ? "var(--dsw-warn)" : "var(--dsw-label-primary)"} strokeWidth="2"
						strokeDasharray={`${circumference * Math.max(0, Math.min(100, p)) / 100} ${circumference}`} transform="rotate(-90 7 7)" strokeLinecap="round" />
				</svg>
			</button>
			{open && (
				/* 弹窗右下角对齐在直径 28px 的圆环上，而圆环离屏幕右缘还有 60-70px：固定
				   w-72(288px) 在 ≤360px 的手机会往左顶出屏幕（实测 344px 下 left=-15）。
				   .pw-context-popover 不是给本仓 CSS 用的，是「远程连接」注入的 mobile-fit.css
				   认的钩子 —— 它用 calc(100vw-96px) + !important 压过那里的 .popover 兜底，重命名
				   或删掉这个类会让手机端重新冒出溢出。 */
				<div className="pw-context-popover popover absolute bottom-9 right-0 z-50 w-72 max-w-[calc(100vw-96px)] p-4" style={{ fontSize: "var(--dsh-content-font-size-secondary)" }}>
					{measuredInput !== null && <div className="mt-2 flex items-center justify-between gap-2"><span>{t.contextApiInput}</span><span title={`${measuredInput} tok`}>{fmtTokens(measuredInput)} tok</span></div>}
					{window_ > 0 && (
						<div className="mt-3 flex h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--dsw-selector)" }} data-testid="context-bar" aria-hidden>
							{segments.map((segment) => (
								<span key={segment.key} data-segment={segment.key} className="flex-none" title={`${segment.label}：${fmtTokens(segment.value)} ${t.contextChars}`}
									style={{ width: `${segment.width}%`, background: segment.color }} />
							))}
							{visibleReserved > 0 && <span data-segment="reserved" className="flex-none" style={{ width: `${visibleReserved / window_ * 100}%`, background: "var(--dsw-border-l3)" }} />}
						</div>
					)}
					<div className="mt-2 flex flex-col gap-1" style={{ color: "var(--dsw-label-tertiary)" }}>
						{reserved > 0 && <DataRow label={t.contextAutoCompactBuffer} value={`${fmtTokens(reserved)} tok`} exact={`${reserved} tok`} color="var(--dsw-border-l3)" />}
						{window_ > 0 && <DataRow label={t.contextFreeSpace} value={free === null ? "—" : `~${fmtTokens(free)} tok`} color="var(--dsw-selector)" />}
					</div>
					{/* 进度条的图例：颜色跟上面的分段一一对应，数字是真实字符数 */}
					<div className="mt-3 flex flex-col gap-1" style={{ color: "var(--dsw-label-tertiary)" }}>
						{rows.map((row) => <DataRow key={row.key} label={row.label} value={`${fmtTokens(row.value!)} ${t.contextChars}`} exact={`${row.value} ${t.contextChars}`} color={row.color} />)}
					</div>
					{cold && source?.loadFull && (
						<div className="mt-3 flex items-center justify-between gap-2" style={{ color: "var(--dsw-label-tertiary)" }}>
							<span className="min-w-0" style={{ fontSize: 11.5 }}>{t.contextColdHint}</span>
							<button type="button" className="btn-outline flex-none" style={{ height: 24, padding: "0 10px", fontSize: 12 }} disabled={counting}
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
					<button type="button" className="btn-outline" style={{ height: 22, padding: "0 8px", fontSize: 11.5 }} onClick={begin}>{t.contextWindowEdit}</button>
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
					style={{ height: 26, fontSize: 12.5, fontFamily: "var(--font-mono)", color: "var(--dsw-label-primary)", background: "var(--dsw-hover)", border: `0.5px solid ${valid ? "var(--dsw-border-l2)" : "var(--dsw-danger)"}` }}
				/>
				<button type="button" className="btn-primary-white flex-none" style={{ height: 26, padding: "0 10px", fontSize: 12 }} disabled={!valid || saving} onClick={() => void save()}>
					{saving ? t.saving : t.save}
				</button>
				<button type="button" className="btn-outline flex-none" style={{ height: 26, padding: "0 10px", fontSize: 12 }} disabled={saving} onClick={cancel}>{t.cancel}</button>
			</div>
			{typeof builtin === "number" && (
				<div className="mt-1.5 flex items-center gap-1.5" style={{ fontSize: 11.5 }}>
					<span>{t.contextWindowBuiltin.replace("{value}", exact(builtin))}</span>
					{target !== builtin && (
						<button type="button" className="underline" style={{ color: "var(--dsw-label-secondary)" }} onClick={() => setText(formatCapacity(builtin))}>{t.contextWindowUseBuiltin}</button>
					)}
				</div>
			)}
			{!valid ? (
				<div className="mt-1" style={{ fontSize: 11.5, color: "var(--dsw-danger)" }}>{t.contextWindowInvalid}</div>
			) : over ? (
				<div className="mt-1" style={{ fontSize: 11.5, color: "var(--dsw-warn)" }}>{t.contextWindowOverBuiltin}</div>
			) : builtin === null ? (
				<div className="mt-1" style={{ fontSize: 11.5 }}>{t.contextWindowNoBuiltin}</div>
			) : null}
			<div className="mt-1" style={{ fontSize: 11.5 }}>{t.contextWindowScope}</div>
			{error && <div className="mt-1" role="alert" style={{ fontSize: 11.5, color: "var(--dsw-danger)" }}>{error}</div>}
		</div>
	);
}

function DataRow({ label, value, exact, color }: { label: string; value: string; exact?: string; color: string }) {
	return <div className="flex items-center justify-between gap-2">
		<span className="flex items-center gap-1.5"><span className="inline-block rounded-full" style={{ width: 7, height: 7, background: color }} />{label}</span>
		<span title={exact}>{value}</span>
	</div>;
}
