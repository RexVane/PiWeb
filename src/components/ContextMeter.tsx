"use client";

/** 上下文总量是 SDK 估算；API 输入用量与内容字符分类分别展示，不能按比例分摊 token。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { fmtPercent, fmtTokens } from "@/lib/format";
import { classifyMessageChars } from "@/lib/process-format";
import type { ContextBreakdown, TrajTokens } from "@/lib/types";

export function ContextMeter({ percent, tokens, contextWindow, source }: {
	percent: number | null;
	tokens: number | null;
	contextWindow: number | null;
	source?: {
		systemChars: number;
		messages: Array<{ role?: string; content: Array<{ type: string; text?: string; thinking?: string; arguments?: unknown; name?: string }>; usage?: TrajTokens; stopReason?: string }>;
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
	const chars = useMemo(() => classifyMessageChars(open ? source?.messages ?? [] : []), [open, source]);
	const lastUsage = useMemo(() => open ? source?.messages.findLast((m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && m.stopReason !== "pending" &&
		(m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0) + (m.usage?.output ?? 0) > 0)?.usage : undefined, [open, source]);
	const measuredInput = lastUsage ? (lastUsage.input ?? 0) + (lastUsage.cacheRead ?? 0) + (lastUsage.cacheWrite ?? 0) : null;
	const p = percent ?? 0;
	const usageLabel = percent === null ? t.contextUnknown : `${fmtPercent(p)} ${t.contextEstimated}`;
	const r = 5.5;
	const circumference = 2 * Math.PI * r;
	const window_ = contextWindow ?? 0;
	const known = tokens !== null && Number.isFinite(tokens) && tokens >= 0;
	const used = known ? tokens : 0;
	const reserved = Math.max(0, source?.breakdown?.autoCompactBuffer ?? 0);
	// 超过窗口时预留不再画到窗口外；未知用量不能将整扇窗口显示为 Free Space。
	const visibleReserved = known && window_ > 0 ? Math.min(reserved, Math.max(0, window_ - used)) : 0;
	const free = known && window_ > 0 ? Math.max(0, window_ - used - reserved) : null;
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

	return (
		<div ref={ref} className="relative">
			<button className="icon-btn" style={{ width: 28, height: 28 }} title={usageLabel} aria-label={usageLabel} onClick={() => setOpen((o) => !o)}>
				<svg width="14" height="14" viewBox="0 0 14 14">
					<circle cx="7" cy="7" r={r} fill="none" stroke="var(--dsw-border-l3)" strokeWidth="2" />
					<circle cx="7" cy="7" r={r} fill="none" stroke={p > 85 ? "var(--dsw-warn)" : "var(--dsw-accent)"} strokeWidth="2"
						strokeDasharray={`${circumference * Math.max(0, Math.min(100, p)) / 100} ${circumference}`} transform="rotate(-90 7 7)" strokeLinecap="round" />
				</svg>
			</button>
			{open && (
				<div className="popover absolute bottom-9 right-0 z-50 w-72 p-4" style={{ fontSize: "var(--dsh-content-font-size-secondary)" }}>
					<div className="font-medium" style={{ color: "var(--dsw-label-primary)" }}>{usageLabel}</div>
					<div className="mt-1" style={{ color: "var(--dsw-label-tertiary)" }}>
						{known ? `~${fmtTokens(used)}` : "—"} / {window_ > 0 ? fmtTokens(window_) : "—"} tok
					</div>
					{measuredInput !== null && <div className="mt-2 flex items-center justify-between gap-2"><span>{t.contextApiInput}</span><span title={`${measuredInput} tok`}>{fmtTokens(measuredInput)} tok</span></div>}
					{known && window_ > 0 && (
						<div className="mt-3 flex h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--dsw-selector)" }} aria-hidden>
							<span className="flex-none" style={{ width: `${Math.min(100, used / window_ * 100)}%`, background: "var(--dsw-accent)" }} />
							{visibleReserved > 0 && <span className="flex-none" style={{ width: `${visibleReserved / window_ * 100}%`, background: "var(--dsw-border-l3)" }} />}
						</div>
					)}
					<div className="mt-2 flex flex-col gap-1" style={{ color: "var(--dsw-label-tertiary)" }}>
						{reserved > 0 && <DataRow label={t.contextAutoCompactBuffer} value={`${fmtTokens(reserved)} tok`} exact={`${reserved} tok`} color="var(--dsw-border-l3)" />}
						{window_ > 0 && <DataRow label={t.contextFreeSpace} value={free === null ? "—" : `~${fmtTokens(free)} tok`} color="var(--dsw-selector)" />}
					</div>
					<div className="mt-3 font-medium">{t.contextCharacterBreakdown}</div>
					<div className="mt-1" style={{ fontSize: 11.5, color: "var(--dsw-label-tertiary)" }}>{t.contextCharacterHint}</div>
					<div className="mt-2 flex flex-col gap-1" style={{ color: "var(--dsw-label-tertiary)" }}>
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
				</div>
			)}
		</div>
	);
}

function DataRow({ label, value, exact, color }: { label: string; value: string; exact?: string; color: string }) {
	return <div className="flex items-center justify-between gap-2">
		<span className="flex items-center gap-1.5"><span className="inline-block rounded-full" style={{ width: 7, height: 7, background: color }} />{label}</span>
		<span title={exact}>{value}</span>
	</div>;
}
