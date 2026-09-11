"use client";

/**
 * 扩展界面桥的浏览器端：对话框（select / confirm / input）、通知条、页脚状态。
 * 对应 pi RPC 模式的 extension_ui_request；没有页面应答时服务端按超时/取消处理。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import type { ExtensionDialog } from "@/hooks/usePiWeb";

export function ExtensionDialogHost({
	dialog,
	onAnswer,
}: {
	dialog: ExtensionDialog | null;
	onAnswer: (id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}) {
	const { t } = useI18n();
	const [text, setText] = useState("");
	const [idx, setIdx] = useState(0);
	useEffect(() => {
		setText("");
		setIdx(0);
	}, [dialog?.id]);
	useEffect(() => {
		if (!dialog) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onAnswer(dialog.id, { cancelled: true });
			if (dialog.method === "select") {
				if (e.key === "ArrowDown") setIdx((i) => Math.min(i + 1, (dialog.options?.length ?? 1) - 1));
				if (e.key === "ArrowUp") setIdx((i) => Math.max(i - 1, 0));
				if (e.key === "Enter") onAnswer(dialog.id, { value: dialog.options?.[idx] });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [dialog, idx, onAnswer]);
	if (!dialog) return null;
	return (
		<div className="fixed inset-0 z-[120] flex items-center justify-center" style={{ background: "var(--dsw-mask)" }} role="dialog" aria-modal="true" aria-label={dialog.title}>
			<div className="popover flex w-[min(92vw,480px)] flex-col gap-3 p-5" style={{ background: "var(--dsw-glass-modal)" }}>
				<div className="flex items-baseline gap-2">
					<span className="rounded px-1.5 py-0.5" style={{ fontSize: 10.5, color: "var(--dsw-label-caption)", background: "var(--dsw-selector)" }}>{t.extensionDialogTag}</span>
					<div className="whitespace-pre-wrap" style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.45 }}>{dialog.title}</div>
				</div>
				{dialog.message && <div className="whitespace-pre-wrap" style={{ fontSize: 13, color: "var(--dsw-label-secondary)", lineHeight: 1.55 }}>{dialog.message}</div>}
				{dialog.method === "select" && (
					<div className="flex max-h-72 flex-col overflow-y-auto rounded-xl" style={{ border: "0.5px solid var(--dsw-border-l2)" }} role="listbox">
						{(dialog.options ?? []).map((opt, i) => (
							<button
								key={`${i}-${opt}`}
								role="option"
								aria-selected={i === idx}
								className="px-3 py-2 text-left"
								style={{ fontSize: 13, background: i === idx ? "var(--dsw-hover)" : "transparent" }}
								onMouseEnter={() => setIdx(i)}
								onClick={() => onAnswer(dialog.id, { value: opt })}
							>
								{opt}
							</button>
						))}
					</div>
				)}
				{dialog.method === "input" && (
					<input
						autoFocus
						value={text}
						placeholder={dialog.placeholder}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.nativeEvent.isComposing) onAnswer(dialog.id, { value: text });
						}}
						className="rounded-xl px-3 py-2"
						style={{ fontSize: 13, background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)" }}
					/>
				)}
				<div className="flex justify-end gap-2">
					<button className="btn-outline" style={{ height: 32 }} onClick={() => onAnswer(dialog.id, { cancelled: true })}>{t.cancel}</button>
					{dialog.method === "confirm" && (
						<button className="btn-primary-white" style={{ height: 32 }} onClick={() => onAnswer(dialog.id, { confirmed: true })}>{t.confirm}</button>
					)}
					{dialog.method === "input" && (
						<button className="btn-primary-white" style={{ height: 32 }} onClick={() => onAnswer(dialog.id, { value: text })}>{t.confirm}</button>
					)}
				</div>
			</div>
		</div>
	);
}

export function ExtensionNotices({
	notices,
	onDismiss,
}: {
	notices: { id: string; message: string; type: "info" | "warning" | "error"; ts: number }[];
	onDismiss: (id: string) => void;
}) {
	// 通知 6 秒后自动消失
	useEffect(() => {
		if (!notices.length) return;
		const timers = notices.map((n) => setTimeout(() => onDismiss(n.id), Math.max(500, 6000 - (Date.now() - n.ts))));
		return () => timers.forEach(clearTimeout);
	}, [notices, onDismiss]);
	if (!notices.length) return null;
	const color = (type: string) => (type === "error" ? "var(--dsw-danger)" : type === "warning" ? "var(--dsw-warn)" : "var(--dsw-accent)");
	return (
		<div className="pointer-events-none fixed bottom-24 right-4 z-[110] flex w-[min(92vw,360px)] flex-col gap-2">
			{notices.map((n) => (
				<button
					key={n.id}
					className="pointer-events-auto rounded-xl px-3 py-2 text-left"
					style={{ fontSize: 12.5, background: "var(--dsw-glass-popover)", border: "0.5px solid var(--dsw-border-l2)", boxShadow: "var(--dsw-elevation-soft)", borderLeft: `3px solid ${color(n.type)}` }}
					onClick={() => onDismiss(n.id)}
				>
					{n.message}
				</button>
			))}
		</div>
	);
}
