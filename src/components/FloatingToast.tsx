"use client";

export interface FloatingToastState {
	ok: boolean;
	msg: string;
	loading?: boolean;
}

/** 轻量级顶部悬浮状态提示，用于扩展安装/更新/卸载等异步反馈。 */
export function FloatingToast({ toast }: { toast: FloatingToastState | null }) {
	if (!toast) return null;
	return (
		<div
			role="status"
			className="fixed top-6 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2.5 px-4 py-2 rounded-lg transition-all pointer-events-none"
			style={{
				fontSize: 13,
				fontWeight: 500,
				background: "var(--dsw-glass-popover)",
				border: toast.loading
					? "1px solid var(--dsw-border-l2)"
					: toast.ok
					? "1px solid color-mix(in srgb, var(--dsw-success) 40%, transparent)"
					: "1px solid color-mix(in srgb, var(--dsw-danger) 40%, transparent)",
				color: toast.loading
					? "var(--dsw-label-primary)"
					: toast.ok
					? "var(--dsw-success)"
					: "var(--dsw-danger)",
				backdropFilter: "blur(12px)",
				boxShadow: "var(--dsw-elevation-panel)",
			}}
		>
			{toast.loading && (
				<span className="h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-current border-t-transparent" />
			)}
			<span>{toast.msg}</span>
		</div>
	);
}
