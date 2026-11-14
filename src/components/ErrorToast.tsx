"use client";

import { useI18n } from "@/i18n";

/** Inline error banner with a selectable message body and an explicit dismiss button. */
export function ErrorToast({
	message,
	onDismiss,
	className,
	fontSize,
}: {
	message: string;
	onDismiss?: () => void;
	className?: string;
	fontSize?: number | string;
}) {
	const { t } = useI18n();
	return (
		<div
			className={className ? `pw-toast-card pw-toast-error ${className}` : "pw-toast-card pw-toast-error"}
			style={fontSize !== undefined ? { fontSize } : undefined}
			role="alert"
		>
			<span className="pw-toast-icon" aria-hidden="true">✕</span>
			<span className="pw-toast-body">{message}</span>
			{onDismiss && (
				<button
					type="button"
					onClick={onDismiss}
					aria-label={t.close}
					title={t.close}
					className="icon-btn pw-toast-close"
				>
					×
				</button>
			)}
		</div>
	);
}
