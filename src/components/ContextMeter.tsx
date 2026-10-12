"use client";

/**
 * 上下文占用：
 * 圆环常驻按钮 + 弹窗显示「百分比 / ~已用 / 窗口」与 13 类分段占用条
 * （mac 磁盘存储条式的多色分段，含 Free Space 段）。
 * 分段口径：全部为字符/4 启发式估算（与 SDK estimateTokens 一致），
 * 服务端分项（System Prompt / Tools / Memory / Skills / Compacted / Buffer）来自快照，
 * 消息分项（User / Agent Text / Thinking / Tool Call / Tool Output）弹窗打开时前端统计。
 * 冷会话（只浏览历史、agent 没启动）拿不到组装后的 System Prompt 和工具定义：
 * 其余分项照常显示，另给「现在统计」按需启动会话，分项随后经 context_breakdown 事件刷新。
 * 无对话时不渲染（由父组件经 contextVisible 控制）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { fmtPercent, fmtTokens } from "@/lib/format";
import { classifyMessageChars, scaleSegmentsToTotal } from "@/lib/process-format";
import type { ContextBreakdown } from "@/lib/types";

/** 13 类分段的定义（顺序即渲染顺序） */
interface Segment {
	key: string;
	label: string;
	tokens: number;
	color: string;
}

export function ContextMeter({
	percent,
	tokens,
	contextWindow,
	source,
}: {
	percent: number | null;
	tokens: number | null;
	contextWindow: number | null;
	/** 分段数据源：消息字符统计只在弹窗打开时执行（流式期间消息每 token 都变，不能常驻扫描） */
	source?: {
		systemChars: number;
		messages: { role?: string; content: Array<{ type: string; text?: string; thinking?: string; arguments?: unknown }> }[];
		breakdown?: ContextBreakdown;
		/** 冷会话里点「现在统计」：启动会话（prepare），System Prompt 与工具定义才算得出来 */
		loadFull?: () => Promise<unknown> | unknown;
	};
}) {
	const [open, setOpen] = useState(false);
	const [counting, setCounting] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const { t } = useI18n();
	const cold = Boolean(source?.breakdown?.cold);

	// 新分项到了（不再是冷的）就收起「统计中」
	useEffect(() => {
		if (!cold) setCounting(false);
	}, [cold]);

	useEffect(() => {
		if (!open) return;
		const h = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [open]);

	const used = tokens ?? 0;
	const window_ = contextWindow ?? 0;
	const b = source?.breakdown;

	// 消息分项只在弹窗打开时统计（≈4 字符/token，与 SDK 一致）
	const messageSegments = useMemo(() => {
		if (!open) return { user: 0, agentText: 0, agentThinking: 0, agentToolCall: 0, toolOutput: 0 };
		const chars = classifyMessageChars(source?.messages ?? []);
		return {
			user: Math.max(0, Math.round(chars.user / 4)),
			agentText: Math.max(0, Math.round(chars.agentText / 4)),
			agentThinking: Math.max(0, Math.round(chars.agentThinking / 4)),
			agentToolCall: Math.max(0, Math.round(chars.agentToolCall / 4)),
			toolOutput: Math.max(0, Math.round(chars.toolOutput / 4)),
		};
	}, [open, source]);

	const p = percent ?? 0;
	const usageLabel = percent === null ? t.contextUnknown : `${fmtPercent(p)} ${t.contextUsed}`;
	const r = 5.5;
	const c = 2 * Math.PI * r;
	const shown = Math.max(0, Math.min(100, p));

	const rawSegments: Segment[] = b
		? [
				{ key: "systemPrompt", label: t.contextSystemPrompt, tokens: b.systemPrompt, color: "var(--dsw-accent)" },
				{ key: "systemTools", label: t.contextSystemTools, tokens: b.systemTools, color: "#8B7EC8" },
				{ key: "customTools", label: t.contextCustomTools, tokens: b.customTools, color: "#B39DDB" },
				{ key: "memory", label: t.contextMemory, tokens: b.memory, color: "#5FA8D3" },
				{ key: "skills", label: t.contextSkills, tokens: b.skills, color: "#4FB286" },
				{ key: "user", label: t.contextUserMessages, tokens: messageSegments.user, color: "var(--dsw-success)" },
				{ key: "agentText", label: t.contextAgentText, tokens: messageSegments.agentText, color: "#7BC96F" },
				{ key: "agentThinking", label: t.contextAgentThinking, tokens: messageSegments.agentThinking, color: "#C9A66B" },
				{ key: "agentToolCall", label: t.contextAgentToolCall, tokens: messageSegments.agentToolCall, color: "#D3A15F" },
				{ key: "toolOutput", label: t.contextToolOutput, tokens: messageSegments.toolOutput, color: "var(--dsw-warn)" },
				{ key: "compacted", label: t.contextCompacted, tokens: b.compacted, color: "#A05A78" },
				{ key: "buffer", label: t.contextAutoCompactBuffer, tokens: b.autoCompactBuffer, color: "var(--dsw-border-l3)" },
			]
		: // 服务端分项缺失（旧快照）：退回旧三段口径
			[
				{ key: "system", label: t.contextSystem, tokens: Math.max(0, Math.round((source?.systemChars ?? 0) / 4)), color: "var(--dsw-accent)" },
				{ key: "messages", label: t.contextMessages, tokens: messageSegments.user + messageSegments.agentText + messageSegments.agentThinking, color: "var(--dsw-success)" },
				{ key: "tools", label: t.contextTools, tokens: Math.max(0, used - Math.max(0, Math.round((source?.systemChars ?? 0) / 4)) - messageSegments.user - messageSegments.agentText - messageSegments.agentThinking), color: "var(--dsw-warn)" },
			];

	// 分项只提供比例，总量锚定到真实用量：头部、分项之和、Free Space 三者才能对上。
	// 真实用量未知（冷会话 / 刚压缩完）时 keep 估算口径。
	const anchor = tokens !== null && tokens > 0 ? tokens : null;
	// Auto-Compact Buffer 是「预留」不是已用内容，不参与按比例归一化，
	// 它从窗口余量里单独扣（Free = 窗口 − 真实用量 − 预留）。
	const reserved = rawSegments.filter((s) => s.key === "buffer");
	const scaled = scaleSegmentsToTotal(rawSegments.filter((s) => s.key !== "buffer"), anchor);
	const segments: Segment[] = [...scaled, ...reserved];
	const usedSum = scaled.reduce((sum, s) => sum + s.tokens, 0);
	const reservedSum = reserved.reduce((sum, s) => sum + s.tokens, 0);
	const free = window_ > 0 ? Math.max(0, window_ - (anchor ?? usedSum) - reservedSum) : 0;
	const barTotal = window_ > 0 ? window_ : (usedSum + reservedSum) || 1;
	const bar = (n: number) => `${(n / barTotal) * 100}%`;

	return (
		<div ref={ref} className="relative">
			<button
				className="icon-btn"
				style={{ width: 28, height: 28 }}
				title={usageLabel}
				onClick={() => setOpen((o) => !o)}
			>
				<svg width="14" height="14" viewBox="0 0 14 14">
					<circle cx="7" cy="7" r={r} fill="none" stroke="var(--dsw-border-l3)" strokeWidth="2" />
					<circle
						cx="7" cy="7" r={r}
						fill="none"
						stroke={p != null && p > 85 ? "var(--dsw-warn)" : "var(--dsw-accent)"}
						strokeWidth="2"
						strokeDasharray={`${(c * shown) / 100} ${c}`}
						transform="rotate(-90 7 7)"
						strokeLinecap="round"
					/>
				</svg>
			</button>
			{open && (
				<div
					className="popover absolute bottom-9 right-0 z-50 w-64 p-4"
					style={{ fontSize: "var(--dsh-content-font-size-secondary)" }}
				>
					<div className="font-medium" style={{ color: "var(--dsw-label-primary)" }}>
						{usageLabel}
					</div>
					<div style={{ color: "var(--dsw-label-tertiary)" }} className="mt-1">
						{tokens === null ? "—" : `~${fmtTokens(used)}`} / {window_ > 0 ? fmtTokens(window_) : "—"}
					</div>

					{/* 分段占用条（mac 磁盘存储条式多色分段，含 Free Space） */}
					{usedSum > 0 && (
						<div className="mt-3 flex h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--dsw-selector)" }} aria-hidden>
							{segments.filter((s) => s.tokens > 0).map((s) => (
								<span key={s.key} style={{ width: bar(s.tokens), background: s.color }} />
							))}
							{free > 0 && <span style={{ width: bar(free), background: "transparent" }} />}
						</div>
					)}
					<div className="mt-2 flex flex-col gap-1" style={{ color: "var(--dsw-label-tertiary)" }}>
						{segments.filter((s) => s.tokens > 0).map((s) => (
							<SegmentRow key={s.key} label={s.label} tokens={s.tokens} color={s.color} />
						))}
						{window_ > 0 && <SegmentRow label={t.contextFreeSpace} tokens={free} color="var(--dsw-selector)" />}
					</div>
					{cold && source?.loadFull ? (
						<div className="mt-3 flex items-center justify-between gap-2" style={{ color: "var(--dsw-label-tertiary)" }}>
							<span className="min-w-0" style={{ fontSize: 11.5 }}>{t.contextColdHint}</span>
							<button
								type="button"
								className="btn-outline flex-none"
								style={{ height: 24, padding: "0 10px", fontSize: 12 }}
								disabled={counting}
								onClick={() => {
									setCounting(true);
									// 启动失败（例如没配模型）就把按钮还回来；成功时等 context_breakdown 事件把冷标记去掉
									void Promise.resolve(source.loadFull?.()).then((result) => {
										if ((result as { success?: boolean } | undefined)?.success === false) setCounting(false);
									}, () => setCounting(false));
								}}
							>
								{counting ? t.contextCounting : t.contextCountNow}
							</button>
						</div>
					) : null}
				</div>
			)}
		</div>
	);
}

function SegmentRow({ label, tokens, color }: { label: string; tokens: number; color: string }) {
	if (tokens <= 0) return null;
	return (
		<div className="flex items-center justify-between gap-2">
			<span className="flex items-center gap-1.5">
				<span className="inline-block rounded-full" style={{ width: 7, height: 7, background: color }} />
				{label}
			</span>
			<span>~{fmtTokens(tokens)}</span>
		</div>
	);
}
