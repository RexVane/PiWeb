"use client";

/**
 * 登录页：无密码配置时直接回主页；已认证（Cookie / Basic）自动放行。
 * ?next= 只接受同源相对路径（safeNextPath 白名单）。
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { I18nProvider, useI18n } from "@/i18n";
import { PiMark } from "@/components/PiMark";
import { safeNextPath } from "@/lib/web-auth-shared";

export default function LoginPage() {
	return (
		<I18nProvider>
			<Suspense fallback={<div className="flex min-h-screen items-center justify-center" aria-busy="true"><PiMark size={40} /></div>}>
				<LoginForm />
			</Suspense>
		</I18nProvider>
	);
}

function LoginForm() {
	const { t } = useI18n();
	const router = useRouter();
	const params = useSearchParams();
	const next = safeNextPath(params.get("next"));
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	// 认证未启用 / 已登录：不用停留
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const response = await fetch("/api/web-auth");
				const result = await response.json();
				if (!alive || !result?.success) return;
				if (!result.data.enabled || result.data.authenticated) router.replace(next);
			} catch {
				/* 网络异常时留在页面，提交时会再次尝试 */
			}
		})();
		return () => {
			alive = false;
		};
	}, [router, next]);

	const submit = async () => {
		if (busy || !password) return;
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/web-auth", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password, next }),
			});
			const result = await response.json();
			if (result.success) {
				router.replace(safeNextPath(result.data?.next ?? next));
				return;
			}
			setError(response.status === 401 ? t.loginFailed : result.error || t.loginFailed);
			setPassword("");
			requestAnimationFrame(() => inputRef.current?.focus());
		} catch {
			setError(t.loginFailed);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex min-h-screen items-center justify-center px-4" style={{ background: "var(--dsw-bg-base)" }}>
			<div className="glass-modal flex w-[min(92vw,380px)] flex-col gap-4 p-7" style={{ borderRadius: 24, boxShadow: "var(--dsw-elevation-prominent)" }}>
				<div className="flex flex-col items-center gap-2">
					<PiMark size={40} />
					<div style={{ fontSize: 16, fontWeight: 600 }}>{t.loginTitle}</div>
					<div className="text-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", lineHeight: 1.55 }}>{t.loginDesc}</div>
				</div>
				<input
					ref={inputRef}
					autoFocus
					type="password"
					autoComplete="current-password"
					aria-label={t.loginPassword}
					value={password}
					placeholder={t.loginPassword}
					onChange={(event) => setPassword(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit();
					}}
					className="w-full rounded-xl px-3 py-2.5"
					style={{ fontSize: 14, background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)" }}
				/>
				{error ? <div role="alert" style={{ fontSize: 12.5, color: "var(--dsw-danger)" }}>{error}</div> : null}
				<button
					className="btn-primary-white w-full"
					style={{ height: 38, opacity: busy || !password ? 0.55 : 1 }}
					disabled={busy || !password}
					onClick={() => void submit()}
				>
					{busy ? t.loginSubmitting : t.loginSubmit}
				</button>
			</div>
		</div>
	);
}
