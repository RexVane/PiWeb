"use client";

/**
 * 登录页：认证未启用或已认证自动回主页；否则提示如何获取令牌/配对码，
 * 并支持直接粘贴启动令牌、配对码或完整登录/配对链接兑换会话 Cookie。
 * 密码登录已永久移除；?next= 只接受同源相对路径（safeNextPath 白名单）。
 */
import { type FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { I18nProvider, useI18n } from "@/i18n";
import { PiMark } from "@/components/PiMark";
import { safeNextPath } from "@/lib/web-auth-shared";

export default function LoginPage() {
	return (
		<I18nProvider>
			<Suspense fallback={<div className="flex min-h-screen items-center justify-center" aria-busy="true"><PiMark size={40} /></div>}>
				<LoginNotice />
			</Suspense>
		</I18nProvider>
	);
}

function LoginNotice() {
	const { t } = useI18n();
	const router = useRouter();
	const params = useSearchParams();
	const next = safeNextPath(params.get("next"));
	// 扫码兑换失败时 /pair 带着原因跳到这里：说清楚为什么没登录上
	const pair = params.get("pair");
	const pairNotice = pair === "expired" ? t.loginPairExpired : pair === "unknown" ? t.loginPairUnknown : null;
	const [credential, setCredential] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

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
				/* 网络异常时留在页面：提示里已经写清怎么拿登录链接 */
			}
		})();
		return () => {
			alive = false;
		};
	}, [router, next]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const trimmed = credential.trim();
		if (!trimmed || submitting) return;
		setSubmitting(true);
		setError(null);
		try {
			const response = await fetch("/api/web-auth", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credential: trimmed }),
			});
			const result = await response.json().catch(() => null);
			if (response.ok && result?.success) {
				router.replace(next);
				return;
			}
			if (response.status === 429) {
				setError(t.loginErrorRateLimited);
			} else if (typeof result?.error === "string" && result.error.includes("expired")) {
				setError(t.loginPairExpired);
			} else if (response.status === 401) {
				setError(t.loginErrorInvalid);
			} else {
				setError(typeof result?.error === "string" && result.error ? result.error : t.loginErrorGeneric);
			}
		} catch {
			setError(t.loginErrorGeneric);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="flex min-h-screen items-center justify-center px-4" style={{ background: "var(--dsw-bg-base)" }}>
			<div className="glass-modal flex w-[min(92vw,380px)] flex-col gap-4 p-7" style={{ borderRadius: 24, boxShadow: "var(--dsw-elevation-prominent)" }}>
				<div className="flex flex-col items-center gap-2">
					<PiMark size={40} />
					<div style={{ fontSize: 16, fontWeight: 600 }}>{t.loginTokenTitle}</div>
					{pairNotice && <div className="text-center" role="alert" style={{ fontSize: 12.5, color: "var(--dsw-danger)", lineHeight: 1.55 }}>{pairNotice}</div>}
					<div className="text-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", lineHeight: 1.55 }}>{t.loginTokenDesc}</div>
				</div>
				<form className="flex flex-col gap-2.5" onSubmit={(event) => void submit(event)}>
					<input
						type="password"
						value={credential}
						onChange={(event) => {
							setCredential(event.target.value);
							if (error) setError(null);
						}}
						aria-label={t.loginCredentialLabel}
						placeholder={t.loginCredentialPlaceholder}
						autoComplete="off"
						spellCheck={false}
						disabled={submitting}
						className="w-full rounded-xl px-3 py-2"
						style={{
							fontSize: 12.5,
							fontFamily: "var(--font-mono)",
							background: "var(--dsw-hover)",
							color: "var(--dsw-label-primary)",
							border: "0.5px solid var(--dsw-border-l3)",
						}}
					/>
					{error && (
						<div className="text-center" role="alert" style={{ fontSize: 12.5, color: "var(--dsw-danger)", lineHeight: 1.5 }}>
							{error}
						</div>
					)}
					<button
						type="submit"
						className="btn-primary-white w-full rounded-xl py-2"
						style={{ fontSize: 13.5, fontWeight: 500 }}
						disabled={submitting || !credential.trim()}
					>
						{submitting ? t.loginSubmitting : t.loginSubmit}
					</button>
				</form>
			</div>
		</div>
	);
}
