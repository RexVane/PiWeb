"use client";

/**
 * 登录页：认证未启用或已认证自动回主页。这里只有启动令牌提示 ——
 * 密码登录已移除，本页不再收集任何凭据。
 * ?next= 只接受同源相对路径（safeNextPath 白名单）。
 */
import { Suspense, useEffect } from "react";
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

	return (
		<div className="flex min-h-screen items-center justify-center px-4" style={{ background: "var(--dsw-bg-base)" }}>
			<div className="glass-modal flex w-[min(92vw,380px)] flex-col gap-4 p-7" style={{ borderRadius: 24, boxShadow: "var(--dsw-elevation-prominent)" }}>
				<div className="flex flex-col items-center gap-2">
					<PiMark size={40} />
					<div style={{ fontSize: 16, fontWeight: 600 }}>{t.loginTokenTitle}</div>
					<div className="text-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)", lineHeight: 1.55 }}>{t.loginTokenDesc}</div>
				</div>
			</div>
		</div>
	);
}
