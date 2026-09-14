"use client";

/**
 * 上下文占用：
 * 圆环常驻按钮 + 弹窗显示「百分比 / ~已用 / 窗口」与 13 类分段占用条
 * （mac 磁盘存储条式的多色分段，含 Free Space 段）。
 * 分段口径：全部为字符/4 启发式估算（与 SDK estimateTokens 一致），
 * 服务端分项（System Prompt / Tools / Memory / Skills / Compacted / Buffer）来自快照，
 * 消息分项（User / Agent Text / Thinking / Tool Call / Tool Output）弹窗打开时前端统计。
 * 无对话时不渲染（由父组件经 contextVisible 控制）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { classifyMessageChars } from "@/lib/process-format";
import type { ContextBreakdown } from "@/lib/types";

function fmtTok(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
}

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
	};
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const { t } = useI18n();

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
	const usageLabel = percent === null ? t.contextUnknown : `${Math.round(p)}% ${t.contextUsed}`;
	const r = 5.5;
	const c = 2 * Math.PI * r;
	const shown = Math.max(0, Math.min(100, p));

	const segments: Segment[] = b
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

	// Free Space：窗口余量（窗口未知则不显示）；分段条不归一化到已用之和
	const usedSum = segments.reduce((sum, s) => sum + s.tokens, 0);
	const free = window_ > 0 ? Math.max(0, window_ - usedSum) : 0;
	const barTotal = window_ > 0 ? window_ : usedSum || 1;
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
						{tokens === null ? "—" : `~${fmtTok(used)}`} / {window_ > 0 ? fmtTok(window_) : "—"}
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
			<span>~{fmtTok(tokens)}</span>
		</div>
	);
}
