"use client";

/**
 * 上下文占用（对齐 dsh ContextMeter）：
 * 圆环常驻按钮 + 弹窗显示「百分比 / ~已用 / 窗口」与分段占用条
 * （系统提示词 / 对话消息 / 工具，mac 磁盘存储条式的多色分段）。
 * 无对话时不渲染（由父组件经 contextVisible 控制）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";

function fmtTok(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
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
	/** 分段数据源：字符统计只在弹窗打开时执行（流式期间消息每 token 都变，不能常驻扫描） */
	source?: { systemChars: number; messages: { content: Array<{ type: string; text?: string; thinking?: string }> }[] };
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

	// 分段估算只在弹窗打开时计算（≈3.5 字符/token）
	const segments = useMemo(() => {
		if (!open) return { system: 0, messages: 0 };
		let chars = 0;
		for (const message of source?.messages ?? []) {
			for (const content of message.content) {
				chars += content.type === "text" ? (content.text?.length ?? 0) : content.type === "thinking" ? (content.thinking?.length ?? 0) : 0;
			}
		}
		return { system: Math.round((source?.systemChars ?? 0) / 3.5), messages: Math.round(chars / 3.5) };
	}, [open, source]);

	const p = percent ?? 0;
	const r = 5.5;
	const c = 2 * Math.PI * r;
	const shown = Math.max(0, Math.min(100, p));
	const used = tokens ?? 0;
	const window_ = contextWindow ?? 0;

	// 分段估算：系统提示词 / 对话消息；工具与基底取余量，保证各段之和等于总量
	const systemTokens = Math.max(0, Math.round(segments?.system ?? 0));
	const messageTokens = Math.max(0, Math.round(segments?.messages ?? 0));
	const toolTokens = Math.max(0, used - systemTokens - messageTokens);
	const segTotal = systemTokens + messageTokens + toolTokens || 1;
	const bar = (n: number) => `${(n / segTotal) * 100}%`;

	return (
		<div ref={ref} className="relative">
			<button
				className="icon-btn"
				style={{ width: 28, height: 28 }}
				title={`${Math.round(p)}% ${t.contextUsed}`}
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
						{Math.round(p)}% {t.contextUsed}
					</div>
					<div style={{ color: "var(--dsw-label-tertiary)" }} className="mt-1">
						~{fmtTok(used)} / {window_ > 0 ? fmtTok(window_) : "—"}
					</div>

					{/* 分段占用条（mac 磁盘存储条式多色分段） */}
					{(systemTokens > 0 || messageTokens > 0 || toolTokens > 0) && (
						<div className="mt-3 flex h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--dsw-selector)" }} aria-hidden>
							{systemTokens > 0 && <span style={{ width: bar(systemTokens), background: "var(--dsw-accent)" }} />}
							{messageTokens > 0 && <span style={{ width: bar(messageTokens), background: "var(--dsw-success)" }} />}
							{toolTokens > 0 && <span style={{ width: bar(toolTokens), background: "var(--dsw-warn)" }} />}
						</div>
					)}
					<div className="mt-2 flex flex-col gap-1" style={{ color: "var(--dsw-label-tertiary)" }}>
						<SegmentRow label={t.contextSystem} tokens={systemTokens} color="var(--dsw-accent)" />
						<SegmentRow label={t.contextMessages} tokens={messageTokens} color="var(--dsw-success)" />
						<SegmentRow label={t.contextTools} tokens={toolTokens} color="var(--dsw-warn)" />
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
