"use client";

/**
 * 上下文占用圆环（对齐 dsh ui-conversation ContextMeter：14×14、r=5.5、2px 描边）。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";

export function ContextMeter({
	percent,
	tokens,
	onCompact,
}: {
	percent: number | null;
	tokens: number | null;
	onCompact: () => void;
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

	const p = percent ?? 0;
	const r = 5.5;
	const c = 2 * Math.PI * r;
	const shown = Math.max(0, Math.min(100, p));
	const fmt = (n: number | null) =>
		n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

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
						cx="7"
						cy="7"
						r={r}
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
						~{fmt(tokens)} tokens
					</div>
					<button
						className="mt-3 w-full rounded-lg px-3 py-1.5 text-left transition-colors"
						style={{ background: "var(--dsw-hover)" }}
						onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-active)")}
						onMouseLeave={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
						onClick={() => {
							setOpen(false);
							onCompact();
						}}
					>
						{t.compactNow}
					</button>
				</div>
			)}
		</div>
	);
}
