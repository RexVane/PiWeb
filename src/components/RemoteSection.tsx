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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";

interface LanState {
	running: boolean;
	port: number | null;
	urls: string[];
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
	targetPort: number;
	/** 非空时服务端拒绝开任何入口（没开认证 / 开发模式） */
	blocked: "auth" | "dev" | null;
	lan: LanState;
	public: PublicState;
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

	const lan = status?.lan;
	const pub = status?.public;
	const blocked = status?.blocked ?? null;
	const lanTone: "on" | "off" = lan?.running ? "on" : "off";
	const pubTone: "on" | "pending" | "off" = pub?.running ? (pub.ready ? "on" : "pending") : "off";

	return (
		<div className="flex flex-col gap-6">
			{/* 插件抬头 */}
			<div className="flex items-center gap-2.5">
				<div style={{ fontSize: 15, fontWeight: 500 }}>{t.setRemote}</div>
				<span
					className="rounded-md px-2 py-[2px]"
					style={{ fontSize: 11, background: "var(--dsw-hover)", color: "var(--dsw-label-secondary)" }}
				>
					{t.remoteBuiltin}
				</span>
			</div>

			{/* 局域网入口 */}
			<Row title={t.remoteLanTitle} hint={t.remoteLanHint}>
				<div className="flex flex-col items-end gap-1.5">
					<div className="flex items-center gap-2" style={{ fontSize: 13 }}>
						<Dot tone={lanTone} />
						<span style={{ color: lan?.running ? "var(--dsw-label-primary)" : "var(--dsw-label-caption)" }}>
							{lan?.running ? t.remoteRunning : t.remoteStopped}
						</span>
					</div>
					{(lan?.urls ?? []).map((url) => (
						<a key={url} href={url} target="_blank" rel="noreferrer" className="font-mono hover:underline" style={{ fontSize: 12 }}>
							{url}
						</a>
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
					{pub?.url ? (
						<a href={pub.url} target="_blank" rel="noreferrer" className="font-mono hover:underline" style={{ fontSize: 12 }}>
							{pub.url}
						</a>
					) : null}
					<div className="flex items-center gap-2">
						{pub?.running ? (
							<button className="btn-outline" style={{ height: 30, fontSize: 13 }} disabled={busy} onClick={() => void act("stop")}>
								{t.remoteStop}
							</button>
						) : (
							<button className="btn-primary-white" style={{ height: 30, fontSize: 13 }} disabled={busy || blocked !== null} onClick={() => void act("start")}>
								{busy ? t.remoteWorking : t.remoteStart}
							</button>
						)}
					</div>
				</div>
			</Row>

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
