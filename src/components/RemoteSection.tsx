"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


/** 一张通用连接二维码，凭据用后或到期自动更新。 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import type { RemoteStatus } from "@/lib/remote/supervisor";

interface PairData {
	code: string;
	url: string;
	expiresAt: number;
	remainingMs: number;
	base: "lan" | "public";
}
interface DisplayPair extends PairData {
	qr: string;
	displayExpiresAt: number;
}

function Dot({ ready }: { ready: boolean }) {
	return <span className="inline-block h-[7px] w-[7px] flex-none rounded-full" style={{ background: ready ? "var(--dsw-success)" : "var(--dsw-label-caption)" }} />;
}

export function RemoteSection() {
	const { t } = useI18n();
	const [status, setStatus] = useState<RemoteStatus | null>(null);
	const [pair, setPair] = useState<DisplayPair | null>(null);
	const pairRef = useRef<DisplayPair | null>(null);
	const [clock, setClock] = useState(() => Date.now());
	const [error, setError] = useState("");
	const [refresh, setRefresh] = useState(0);
	const [copied, setCopied] = useState<"" | "ok" | "fail">("");
	const [confirmSignOut, setConfirmSignOut] = useState(false);
	const alive = useRef(true);

	useEffect(() => {
		alive.current = true;
		const timer = setInterval(() => setClock(Date.now()), 1_000);
		return () => { alive.current = false; clearInterval(timer); };
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let connected = false;
		const poll = async () => {
			let nextPoll = 3_000;
			const request = async (url: string, body?: object) => {
				const requestController = new AbortController();
				const cancel = () => requestController.abort();
				controller.signal.addEventListener("abort", cancel, { once: true });
				if (controller.signal.aborted) cancel();
				const timeout = setTimeout(cancel, 15_000);
				try {
					const response = await fetch(url, {
						cache: "no-store",
						signal: requestController.signal,
						...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
					});
					const result = await response.json();
					if (!response.ok || !result?.success) {
						const retryAfter = Number(response.headers?.get("retry-after"));
						if (retryAfter > 0) nextPoll = Math.min(60_000, Math.max(3_000, retryAfter * 1_000));
						throw new Error(response.status === 429 ? t.pairRetrying : result?.error || t.remoteFailed);
					}
					return result.data;
				} finally {
					clearTimeout(timeout);
					controller.signal.removeEventListener("abort", cancel);
				}
			};
			let stopPolling = false;
			try {
				let next = await request("/api/remote") as RemoteStatus;
				if (!next.blocked && !connected) {
					next = await request("/api/remote", { action: "connect" }) as RemoteStatus;
					connected = true;
				}
				if (controller.signal.aborted) return;
				setStatus(next);
				setError("");
				const publicReady = next.public.running && next.public.ready && Boolean(next.public.url);
				if (next.blocked) { stopPolling = true; setPair(null); return; }
				const lanReady = next.lan.running && next.lan.urls.length > 0;
				if (!publicReady && !lanReady) { setPair(null); return; }
				const data = await request("/api/remote/pair", { base: publicReady ? "public" : "lan", previousCode: pairRef.current?.code }) as PairData;
				const previous = pairRef.current;
				const qr = previous?.url === data.url
					? previous.qr
					: await (await import("qrcode")).default.toDataURL(data.url, { margin: 2, width: 240, errorCorrectionLevel: "M" });
				if (controller.signal.aborted) return;
				const nextPair = { ...data, qr, displayExpiresAt: Date.now() + Math.max(0, data.remainingMs) };
				pairRef.current = nextPair;
				setPair(nextPair);
				setClock(Date.now());
			} catch (failure) {
				if (!controller.signal.aborted) setError(failure instanceof Error && failure.name !== "AbortError" ? failure.message : t.remoteFailed);
			} finally {
				if (!controller.signal.aborted && !stopPolling) timer = setTimeout(() => void poll(), nextPoll);
			}
		};
		void poll();
		return () => { controller.abort(); clearTimeout(timer); };
	}, [refresh, t.remoteFailed, t.pairRetrying]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(""), 2_000);
		return () => clearTimeout(timer);
	}, [copied]);
	useEffect(() => {
		if (!confirmSignOut) return;
		const timer = setTimeout(() => setConfirmSignOut(false), 4_000);
		return () => clearTimeout(timer);
	}, [confirmSignOut]);

	const signOutAll = async () => {
		if (!confirmSignOut) { setConfirmSignOut(true); return; }
		setConfirmSignOut(false);
		try {
			const response = await fetch("/api/web-auth?scope=all", { method: "DELETE" });
			const result = await response.json().catch(() => null);
			if (!response.ok || !result?.success) throw new Error(result?.error ?? t.remoteFailed);
			window.location.href = "/login";
		} catch (failure) {
			if (alive.current) setError(failure instanceof Error ? failure.message : t.remoteFailed);
		}
	};

	const blocked = status?.blocked;
	const publicReady = Boolean(status?.public.running && status.public.ready && status.public.url);
	const lanReady = Boolean(status?.lan.running && status.lan.urls.length);
	const remaining = pair ? Math.max(0, Math.ceil((pair.displayExpiresAt - clock) / 1_000)) : 0;
	const visiblePair = pair && remaining > 0 && !blocked && (pair.base === "public" ? publicReady : lanReady) ? pair : null;

	return <div className="flex flex-col gap-5">
		<div>
			<div style={{ fontSize: "var(--dsh-ui-font-lg)", fontWeight: 500 }}>{t.setRemote}</div>
			<p style={{ marginTop: 6, fontSize: "var(--dsh-ui-font-125)", lineHeight: 1.6, color: "var(--dsw-label-secondary)" }}>{t.remoteUnifiedHint}</p>
		</div>

		{blocked ? <div role="status" style={{ fontSize: "var(--dsh-ui-font-125)", lineHeight: 1.6, color: "var(--dsw-label-secondary)" }}>
			{blocked === "auth" ? t.remoteBlockedAuth : t.remoteBlockedDev}
		</div> : !status ? <div className="flex items-center gap-3">
			<div role="status" aria-busy={!error} style={{ fontSize: "var(--dsh-ui-font-125)", color: "var(--dsw-label-secondary)" }}>
				{error ? t.pairRetrying : t.remoteWorking}
			</div>
			{error ? <button type="button" className="btn-outline" onClick={() => setRefresh((value) => value + 1)}>{t.remoteRetry}</button> : null}
		</div> : <div className="flex flex-col items-center gap-4 rounded-xl p-5" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
			<div style={{ fontSize: "var(--dsh-content-font-size)", fontWeight: 500 }}>{t.pairTitle}</div>
			{visiblePair ? <img src={visiblePair.qr} alt={t.pairQrLabel} width={220} height={220}
				style={{ background: "#fff", padding: 4, borderRadius: 10, maxWidth: "100%", height: "auto" }} />
				: <div className="flex items-center justify-center rounded-xl" role="status" aria-busy={!error}
					style={{ width: 220, minHeight: 220, maxWidth: "100%", padding: 20, textAlign: "center", fontSize: "var(--dsh-ui-font-sm)", color: "var(--dsw-label-caption)", background: "var(--dsw-hover)" }}>
					{error ? t.pairRetrying : t.pairPreparing}
				</div>}
			<div className="flex flex-col items-center gap-1" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-secondary)" }}>
				<span>{t.pairConnectHint}</span>
				<span style={{ color: "var(--dsw-label-caption)" }}>{visiblePair ? t.pairAutoExpires.replace("{s}", String(remaining)) : t.pairHint}</span>
			</div>
			{visiblePair ? <div className="flex items-center gap-3">
				<button type="button" className="btn-outline" style={{ height: "max(30px, calc(30px + var(--dsh-content-font-delta)))", fontSize: "var(--dsh-ui-font-xs)" }}
					onClick={() => void copyText(visiblePair.url).then((ok) => { if (alive.current) setCopied(ok ? "ok" : "fail"); })}>
					{copied === "ok" ? t.remoteLinkCopied : copied === "fail" ? t.copyFailed : t.pairCopyLink}
				</button>
			</div> : error ? <button type="button" className="btn-outline" onClick={() => setRefresh((value) => value + 1)}>{t.remoteRetry}</button> : null}
		</div>}

		{status && !blocked ? <div className="flex items-center gap-2" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-secondary)" }}>
			<Dot ready={publicReady || lanReady} />{publicReady || lanReady ? t.remoteConnected : status.public.error || status.lan.error ? t.remoteUnavailable : t.remoteWorking}
		</div> : null}
		{status?.public.error && !publicReady && !blocked ? <p role="status" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)" }}>
			{status.public.engineAvailable ? status.public.error : t.remoteEngineMissing}
		</p> : null}
		{error ? <div role="alert" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-danger)" }}>{error}</div> : null}
		{status?.lan.error && !lanReady && !blocked ? <div role="alert" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-danger)" }}>{status.lan.error}<button className="btn-outline" onClick={() => setRefresh((value) => value + 1)}>{t.remoteRetry}</button></div> : null}
		{status && blocked !== "auth" ? <div className={`flex flex-wrap items-center justify-between gap-3${lanReady ? " hairline-b pb-4" : ""}`}>
			<div className="min-w-0 flex-1">
				<div style={{ fontSize: "var(--dsh-content-font-size)" }}>{t.remoteSessionsTitle}</div>
				<p style={{ marginTop: 3, fontSize: "var(--dsh-ui-font-xs)", lineHeight: 1.6, color: "var(--dsw-label-caption)" }}>{t.remoteSessionsHint}</p>
			</div>
			<button type="button" className="btn-outline" style={{ height: "max(30px, calc(30px + var(--dsh-content-font-delta)))", fontSize: "var(--dsh-ui-font-xs)", color: confirmSignOut ? "var(--dsw-danger)" : undefined }} onClick={() => void signOutAll()}>
				{confirmSignOut ? t.remoteSignOutAllConfirm : t.remoteSignOutAll}
			</button>
		</div> : null}
		{lanReady && <div className="flex items-center gap-2 break-all" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)" }}>
			<span className="flex-1">{status?.lan.urls[0]}</span><button type="button" className="btn-outline" onClick={() => void copyText(status!.lan.urls[0]).then((ok) => setCopied(ok ? "ok" : "fail"))}>{t.copy}</button>
		</div>}
	</div>;

}
