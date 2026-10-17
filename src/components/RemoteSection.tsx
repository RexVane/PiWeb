"use client";

/**
 * 设置 → 远程连接（内置插件）。
 *
 * 显示一个内置插件「远程连接」，它有两层入口：
 *   - 局域网入口：注入代理，默认就开着；手机连同一个 WiFi 用这个地址，排版是手机版。
 *   - 公网入口：cloudflared 快速隧道，由这里的按钮开关；开了之后任何浏览器都能打开。
 *
 * 公开地址由 Cloudflare 随机分配且每次启动都变；拿到地址后还要十几秒才在全球 DNS 生效，
 * 所以状态里区分「已生成」和「已生效」，没生效时按钮区域给出说明而不是假装好了。
 *
 * 入口链接带启动令牌：手机打开就直接登录，不用再去终端里抄令牌。屏幕上只显示裸地址，
 * 令牌只在链接和复制出来的文本里——截图、共享屏幕时不会露出来。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { copyText } from "@/lib/clipboard";

interface LanState {
	running: boolean;
	port: number | null;
	urls: string[];
	/** 是否在注入手机排版；插件关闭时为 false。旧服务端的响应里可能没有这个字段 */
	styled?: boolean;
	error: string | null;
}

interface PublicState {
	running: boolean;
	url: string | null;
	ready: boolean;
	engine: string | null;
	engineAvailable: boolean;
	error: string | null;
}

interface RemoteStatus {
	plugin: string;
	/** 内置插件总开关；关闭后局域网入口仍在（纯转发），但没有手机排版与公网入口。
	 *  旧服务端的响应里可能没有这个字段，界面按「已启用」处理 */
	pluginEnabled?: boolean;
	targetPort: number;
	/** 非空时服务端拒绝开任何入口（没开认证 / 开发模式） */
	blocked: "auth" | "dev" | null;
	lan: LanState;
	public: PublicState;
	/** 本次启动的令牌；认证没开时为 null */
	loginToken: string | null;
}

/** 带令牌的登录链接。令牌只在根路径的 GET 上被换成 Cookie（见 proxy.ts），所以拼成 <地址>/?token=… */
export function loginLink(url: string, token: string | null | undefined): string {
	if (!token) return url;
	return `${url.replace(/\/+$/, "")}/?token=${encodeURIComponent(token)}`;
}

/** 状态点：绿=在跑，蓝=过渡中，灰=没开 */
function Dot({ tone }: { tone: "on" | "pending" | "off" }) {
	const color = tone === "on" ? "var(--dsw-success)" : tone === "pending" ? "var(--dsw-accent)" : "var(--dsw-label-caption)";
	return <span className="inline-block h-[7px] w-[7px] flex-none rounded-full" style={{ background: color }} />;
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="hairline-b flex flex-wrap items-start justify-between gap-4 pb-5">
			<div className="min-w-0 flex-1" style={{ minWidth: "45%" }}>
				<div style={{ fontSize: 14 }}>{title}</div>
				{hint ? <div style={{ fontSize: 12, color: "var(--dsw-label-caption)", lineHeight: 1.55, marginTop: 2 }}>{hint}</div> : null}
			</div>
			<div className="flex-none">{children}</div>
		</div>
	);
}

/** 一个入口地址：显示裸地址，链接和复制的都是带令牌的版本 */
function EntryLink({ url, token }: { url: string; token: string | null | undefined }) {
	const { t } = useI18n();
	const [copied, setCopied] = useState<"" | "ok" | "fail">("");
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(""), 2_000);
		return () => clearTimeout(timer);
	}, [copied]);
	const href = loginLink(url, token);
	return (
		<div className="flex items-center gap-2">
			<a href={href} target="_blank" rel="noreferrer" className="font-mono hover:underline" style={{ fontSize: 12 }}>
				{url}
			</a>
			<button
				type="button"
				className="btn-outline"
				style={{ height: 24, fontSize: 12, paddingInline: 8 }}
				onClick={() => void copyText(href).then((ok) => setCopied(ok ? "ok" : "fail"))}
			>
				{copied === "ok" ? t.remoteLinkCopied : copied === "fail" ? t.copyFailed : t.copy}
			</button>
		</div>
	);
}

export function RemoteSection() {
	const { t } = useI18n();
	const [status, setStatus] = useState<RemoteStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const alive = useRef(true);

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/remote", { cache: "no-store" });
			const result = await response.json();
			if (!alive.current) return;
			if (result?.success) {
				setStatus(result.data as RemoteStatus);
				setError("");
			} else {
				setError(result?.error ?? t.remoteFailed);
			}
		} catch {
			if (alive.current) setError(t.remoteFailed);
		}
	}, [t]);

	useEffect(() => {
		alive.current = true;
		void load();
		return () => {
			alive.current = false;
		};
	}, [load]);

	// 地址已生成但还没生效时，短轮询到生效为止（实测这段要十几秒）
	const waiting = Boolean(status?.public.running && !status.public.ready);
	useEffect(() => {
		if (!waiting) return;
		const timer = setInterval(() => void load(), 2_500);
		return () => clearInterval(timer);
	}, [waiting, load]);

	const act = async (action: "start" | "stop") => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/remote", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action }),
			});
			const result = await response.json();
			if (result?.success) setStatus(result.data as RemoteStatus);
			else setError(result?.error ?? t.remoteFailed);
		} catch {
			setError(t.remoteFailed);
		} finally {
			if (alive.current) setBusy(false);
		}
	};

	// 「让所有设备重新登录」点两下才生效（第一下只把按钮换成确认文案，4 秒后复原）
	const [confirmSignOut, setConfirmSignOut] = useState(false);
	useEffect(() => {
		if (!confirmSignOut) return;
		const timer = setTimeout(() => setConfirmSignOut(false), 4_000);
		return () => clearTimeout(timer);
	}, [confirmSignOut]);
	const signOutAll = async () => {
		if (!confirmSignOut) {
			setConfirmSignOut(true);
			return;
		}
		setConfirmSignOut(false);
		setError("");
		try {
			const response = await fetch("/api/web-auth?scope=all", { method: "DELETE" });
			const result = await response.json().catch(() => null);
			if (!response.ok || !result?.success) throw new Error(result?.error ?? t.remoteFailed);
			window.location.href = "/login";
		} catch (e) {
			if (alive.current) setError(e instanceof Error ? e.message : t.remoteFailed);
		}
	};

	const lan = status?.lan;
	const pub = status?.public;
	const blocked = status?.blocked ?? null;
	// 开关未取到状态前按「已启用」显示，避免首帧闪一下「已关闭」
	const pluginOn = status?.pluginEnabled ?? true;
	const lanTone: "on" | "off" = lan?.running ? "on" : "off";
	const pubTone: "on" | "pending" | "off" = pub?.running ? (pub.ready ? "on" : "pending") : "off";

	/** 切换内置插件总开关；局域网入口照旧（关掉后退化成纯转发），公网入口会一并停掉 */
	const togglePlugin = async () => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/remote", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "set-plugin", enabled: !pluginOn }),
			});
			const result = await response.json();
			if (result?.success) setStatus(result.data as RemoteStatus);
			else setError(result?.error ?? t.remoteFailed);
		} catch {
			setError(t.remoteFailed);
		} finally {
			if (alive.current) setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-6">
			{/* 插件抬头 + 总开关 */}
			<div className="flex items-center gap-2.5">
				<div style={{ fontSize: 15, fontWeight: 500 }}>{t.setRemote}</div>
				<span
					className="rounded-md px-2 py-[2px]"
					style={{ fontSize: 11, background: "var(--dsw-hover)", color: "var(--dsw-label-secondary)" }}
				>
					{t.remoteBuiltin}
				</span>
				<div className="flex-1" />
				<span style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{pluginOn ? t.remotePluginOn : t.remotePluginOff}</span>
				<button
					type="button"
					className="relative h-5 w-9 flex-none rounded-full transition-colors"
					style={{ background: pluginOn ? "var(--dsw-accent)" : "var(--dsw-border-l3)" }}
					role="switch"
					aria-checked={pluginOn}
					aria-label={t.remotePluginToggle}
					title={t.remotePluginHint}
					disabled={busy || !status}
					onClick={() => void togglePlugin()}
				>
					<span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all" style={{ left: pluginOn ? 18 : 2 }} />
				</button>
			</div>
			<div style={{ fontSize: 12, color: "var(--dsw-label-secondary)", lineHeight: 1.6, marginTop: -12 }}>{t.remotePluginHint}</div>

			{/* 局域网入口 */}
			<Row title={t.remoteLanTitle} hint={t.remoteLanHint}>
				<div className="flex flex-col items-end gap-1.5">
					<div className="flex items-center gap-2" style={{ fontSize: 13 }}>
						<Dot tone={lanTone} />
						<span style={{ color: lan?.running ? "var(--dsw-label-primary)" : "var(--dsw-label-caption)" }}>
							{lan?.running ? t.remoteRunning : t.remoteStopped}
						</span>
						{/* 只在服务端明确回了 styled:false 时才说「纯转发」：
						    字段缺失（旧服务端、缓存的响应）不能当成关闭，否则会误报 */}
						{lan?.running && lan.styled === false ? (
							<span style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>· {t.remoteLanPlain}</span>
						) : null}
					</div>
					{(lan?.urls ?? []).map((url) => (
						<EntryLink key={url} url={url} token={status?.loginToken} />
					))}
					{lan?.error ? <div style={{ fontSize: 12, color: "var(--dsw-danger)" }}>{lan.error}</div> : null}
				</div>
			</Row>

			{/* 公网入口 */}
			<Row title={t.remotePublicTitle} hint={t.remotePublicHint}>
				<div className="flex flex-col items-end gap-2">
					<div className="flex items-center gap-2" style={{ fontSize: 13 }}>
						<Dot tone={pubTone} />
						<span style={{ color: pub?.running ? "var(--dsw-label-primary)" : "var(--dsw-label-caption)" }}>
							{pub?.running ? (pub.ready ? t.remoteRunning : t.remotePending) : t.remoteStopped}
						</span>
					</div>
					{pub?.url ? <EntryLink url={pub.url} token={status?.loginToken} /> : null}
					<div className="flex items-center gap-2">
						{pub?.running ? (
							<button className="btn-outline" style={{ height: 30, fontSize: 13 }} disabled={busy} onClick={() => void act("stop")}>
								{t.remoteStop}
							</button>
						) : (
							<button className="btn-primary-white" style={{ height: 30, fontSize: 13 }} disabled={busy || blocked !== null || !pluginOn} onClick={() => void act("start")}>
								{busy ? t.remoteWorking : t.remoteStart}
							</button>
						)}
					</div>
					{!pluginOn ? <div style={{ fontSize: 11.5, color: "var(--dsw-label-caption)", textAlign: "right" }}>{t.remotePublicNeedsPlugin}</div> : null}
				</div>
			</Row>

			{/* 没开认证就没有登录这回事 */}
			{status && blocked !== "auth" ? (
				<Row title={t.remoteSessionsTitle} hint={t.remoteSessionsHint}>
					<button
						className="btn-outline"
						style={{ height: 30, fontSize: 13, color: confirmSignOut ? "var(--dsw-danger)" : undefined }}
						onClick={() => void signOutAll()}
					>
						{confirmSignOut ? t.remoteSignOutAllConfirm : t.remoteSignOutAll}
					</button>
				</Row>
			) : null}

			{blocked ? (
				<div style={{ fontSize: 12, color: "var(--dsw-label-secondary)", lineHeight: 1.6 }}>
					{blocked === "auth" ? t.remoteBlockedAuth : t.remoteBlockedDev}
				</div>
			) : null}
			{pub && !pub.engineAvailable ? (
				<div style={{ fontSize: 12, color: "var(--dsw-danger)", lineHeight: 1.6 }}>{t.remoteEngineMissing}</div>
			) : null}
			{pub?.error ? <div style={{ fontSize: 12, color: "var(--dsw-danger)", lineHeight: 1.6 }}>{pub.error}</div> : null}
			{error ? <div role="alert" style={{ fontSize: 12, color: "var(--dsw-danger)" }}>{error}</div> : null}
		</div>
	);
}
