"use client";

/**
 * 扩展界面桥的浏览器端：对话框（select / confirm / input）、通知条、页脚状态。
 * 对应 pi RPC 模式的 extension_ui_request；没有页面应答时服务端按超时/取消处理。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconShieldOutline16 } from "@/components/icons";
import { useI18n } from "@/i18n";
import type { ExtensionDialog } from "@/hooks/usePiWeb";

/** message 若全是 "key : value" 行（权限对话框的常见形态），解析成键值表渲染 */
function parseKeyValueRows(message: string): { key: string; value: string }[] | null {
	const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
	if (!lines.length) return null;
	const rows: { key: string; value: string }[] = [];
	for (const line of lines) {
		const m = /^([^:\s]{1,20})\s*:\s(.+)$/.exec(line);
		if (!m) return null;
		rows.push({ key: m[1], value: m[2] });
	}
	return rows;
}

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
	const dialogRef = useRef<HTMLDivElement>(null);
	const isPermission = /permission|approve|allow/i.test(dialog?.title ?? "");
	const kvRows = useMemo(() => (dialog?.message ? parseKeyValueRows(dialog.message) : null), [dialog?.message, dialog?.id]);
	useEffect(() => {
		setText("");
		setIdx(0);
	}, [dialog?.id]);
	useEffect(() => {
		if (!dialog) return;
		const previous = document.activeElement;
		if (dialog.method !== "input") dialogRef.current?.focus();
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, [dialog?.id, dialog?.method]);
	if (!dialog) return null;
	return (
		<div
			ref={dialogRef}
			tabIndex={-1}
			className="fixed inset-0 z-[120] flex items-center justify-center"
			style={{ background: "var(--dsw-mask)" }}
			role="dialog"
			aria-modal="true"
			aria-label={dialog.title}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					onAnswer(dialog.id, { cancelled: true });
				} else if (dialog.method === "select" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
					event.preventDefault();
					setIdx((current) => Math.max(0, Math.min(current + (event.key === "ArrowDown" ? 1 : -1), (dialog.options?.length ?? 1) - 1)));
				} else if (dialog.method === "select" && event.key === "Enter" && event.target === event.currentTarget) {
					event.preventDefault();
					onAnswer(dialog.id, { value: dialog.options?.[idx] });
				}
			}}
		>
			<div className="popover flex w-[min(92vw,480px)] flex-col gap-3 p-5" style={{ background: "var(--dsw-glass-modal)" }}>
				<div className="flex items-start gap-2.5">
					{isPermission && (
						<span className="flex-none flex items-center justify-center rounded-lg" style={{ width: 30, height: 30, background: "color-mix(in srgb, var(--dsw-warn) 15%, transparent)" }}>
							<IconShieldOutline16 size={16} style={{ color: "var(--dsw-warn)" }} />
						</span>
					)}
					<div className="min-w-0 flex-1">
						<div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.4 }}>{dialog.title}</div>
						<div className="mt-0.5" style={{ fontSize: 10.5, color: "var(--dsw-label-caption)" }}>{t.extensionDialogTag}</div>
					</div>
				</div>
				{kvRows ? (
					<div className="flex flex-col gap-1.5 rounded-xl px-3 py-2.5" style={{ background: "var(--dsw-hover)" }}>
						{kvRows.map(({ key, value }) => (
							<div key={key} className="flex items-baseline gap-2">
								<span className="flex-none" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)", width: 72 }}>{key}</span>
								<span className="min-w-0 flex-1 break-all" style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--dsw-label-primary)" }}>{value}</span>
							</div>
						))}
					</div>
				) : dialog.message ? (
					<div className="whitespace-pre-wrap rounded-xl px-3 py-2.5" style={{ fontSize: 12.5, color: "var(--dsw-label-secondary)", lineHeight: 1.55, background: "var(--dsw-hover)" }}>{dialog.message}</div>
				) : null}
				{dialog.method === "select" && (
					<div className="flex max-h-72 flex-col overflow-y-auto rounded-xl" style={{ border: "0.5px solid var(--dsw-border-l2)" }} role="listbox">
						{(dialog.options ?? []).map((opt, i) => {
							const affirmative = /^(yes|allow|always)/i.test(opt.trim());
							const negative = /^(no|deny|never)/i.test(opt.trim());
							return (
								<button
									key={`${i}-${opt}`}
									role="option"
									aria-selected={i === idx}
									className="px-3 py-2 text-left transition-colors"
									style={{
										fontSize: 13,
										fontWeight: affirmative || negative ? 550 : 400,
										color: affirmative ? "var(--dsw-accent)" : negative ? "var(--dsw-danger)" : "var(--dsw-label-primary)",
										background: i === idx ? "var(--dsw-hover)" : "transparent",
										borderLeft: i === idx ? "2px solid var(--dsw-accent)" : "2px solid transparent",
									}}
									onMouseEnter={() => setIdx(i)}
									onClick={() => onAnswer(dialog.id, { value: opt })}
								>
									{opt}
								</button>
							);
						})}
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
