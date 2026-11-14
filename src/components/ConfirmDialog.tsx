"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCloseOutline14, IconWarningOutline16 } from "@/components/icons";
import { useDialog } from "@/hooks/useDialog";
import { useI18n } from "@/i18n";

export interface ConfirmDialogOptions {
	title?: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
}

interface ConfirmDialogProps extends ConfirmDialogOptions {
	open: boolean;
	busy?: boolean;
	error?: string;
	onConfirm: () => void;
	onCancel: () => void;
}

function ConfirmDialogInner({
	title,
	message,
	confirmLabel,
	cancelLabel,
	danger = true,
	busy = false,
	error,
	onConfirm,
	onCancel,
}: Omit<ConfirmDialogProps, "open">) {
	const { t } = useI18n();
	const titleId = useId();
	const descId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);

	useDialog({
		open: true,
		onClose: () => {
			if (!busy) onCancel();
		},
		ref: dialogRef,
	});

	if (typeof document === "undefined") return null;

	const resolvedTitle = title ?? (danger ? t.confirmDeleteAction : t.confirmAction);
	const resolvedConfirm = confirmLabel ?? t.confirm;
	const resolvedCancel = cancelLabel ?? t.cancel;

	return createPortal(
		<div
			className="modal-mask fixed inset-0 z-[10000] flex items-center justify-center p-4 animate-in fade-in duration-150"
			onClick={() => {
				if (!busy) onCancel();
			}}
		>
			<div
				ref={dialogRef}
				className="glass-modal relative w-full max-w-[420px] p-6"
				style={{
					boxShadow: "var(--pw-shadow-modal)",
					color: "var(--dsw-label-primary)",
				}}
				onClick={(e) => e.stopPropagation()}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={descId}
			>
				<button
					type="button"
					onClick={onCancel}
					disabled={busy}
					className="icon-btn absolute right-4 top-4"
					style={{ width: 28, height: 28 }}
					aria-label={t.close}
				>
					<IconCloseOutline14 size={15} />
				</button>

				<div className="flex items-start gap-3 pr-7">
					{danger && (
						<span
							className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full"
							style={{
								background: "color-mix(in srgb, var(--dsw-danger) 12%, transparent)",
								color: "var(--dsw-danger)",
							}}
							aria-hidden="true"
						>
							<IconWarningOutline16 size={16} />
						</span>
					)}
					<div className="min-w-0 flex-1">
						<h3
							id={titleId}
							className="text-base font-semibold leading-snug"
							style={{ color: "var(--dsw-label-primary)" }}
						>
							{resolvedTitle}
						</h3>
						<p
							id={descId}
							className="mt-2 text-sm leading-relaxed break-words"
							style={{ color: "var(--dsw-label-secondary)" }}
						>
							{message}
						</p>
						{error && <p role="alert" className="mt-3 text-sm leading-relaxed break-words" style={{ color: "var(--dsw-danger)" }}>{error}</p>}
					</div>
				</div>

				<div className="mt-6 flex items-center justify-end gap-2.5">
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						className="btn-outline"
					>
						{resolvedCancel}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={busy}
						className={danger ? "pw-btn-danger" : "btn-primary-white"}
					>
						{resolvedConfirm}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

/**
 * 主题感知的确认对话框（替代原生 window.confirm，通过 useDialog 接入聚焦栈与 Esc 堆栈）。
 */
export function ConfirmDialog({ open, ...props }: ConfirmDialogProps) {
	if (!open) return null;
	return <ConfirmDialogInner {...props} />;
}

/**
 * Promise 式确认框：用于在事件处理器里直接替代 `window.confirm(...)`。
 */
export function useConfirmDialog() {
	const [pending, setPending] = useState<ConfirmDialogOptions | null>(null);
	const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

	const settle = useCallback((confirmed: boolean) => {
		const resolve = resolverRef.current;
		resolverRef.current = null;
		setPending(null);
		resolve?.(confirmed);
	}, []);

	useEffect(() => {
		return () => {
			resolverRef.current?.(false);
			resolverRef.current = null;
		};
	}, []);

	const confirm = useCallback((options: ConfirmDialogOptions | string): Promise<boolean> => {
		const normalized = typeof options === "string" ? { message: options } : options;
		if (resolverRef.current) {
			resolverRef.current(false);
		}
		setPending(normalized);
		return new Promise<boolean>((resolve) => {
			resolverRef.current = resolve;
		});
	}, []);

	const dialog = (
		<ConfirmDialog
			open={pending !== null}
			title={pending?.title}
			message={pending?.message ?? ""}
			confirmLabel={pending?.confirmLabel}
			cancelLabel={pending?.cancelLabel}
			danger={pending?.danger}
			onConfirm={() => settle(true)}
			onCancel={() => settle(false)}
		/>
	);

	return { confirm, confirmDialog: dialog };
}
