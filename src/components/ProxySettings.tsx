"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheckOutline14, IconRefreshOutline14, IconWarningOutline16 } from "@/components/icons";
import { useI18n } from "@/i18n";
import type { ProxyChoice, ProxyTestCode, ProxyTestResult } from "@/lib/proxy-status";

export function ProxySettings({ value, disabled, onChange, onCommit }: {
	value: string; disabled: boolean; onChange: (value: string) => void; onCommit: () => void;
}) {
	const { t } = useI18n();
	const [automatic, setAutomatic] = useState<ProxyChoice | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadFailed, setLoadFailed] = useState(false);
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<ProxyTestResult | null>(null);
	const active = useRef<AbortController | null>(null);
	const generation = useRef(0);
	const [reload, setReload] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true); setLoadFailed(false);
		void fetch("/api/proxy", { signal: controller.signal }).then(async (response) => {
			const json = await response.json();
			if (!response.ok || !json.success || !json.data || !("source" in json.data)) throw new Error("load");
			if (!controller.signal.aborted) setAutomatic(json.data);
		}).catch(() => { if (!controller.signal.aborted) setLoadFailed(true); })
			.finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, [reload]);
	useEffect(() => {
		generation.current++; active.current?.abort(); setResult(null); setTesting(false);
		return () => { generation.current++; active.current?.abort(); };
	}, [value]);
	const test = async () => {
		const requestId = ++generation.current;
		const controller = new AbortController(); active.current = controller;
		setTesting(true); setResult(null);
		try {
			const response = await fetch("/api/proxy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proxy: value.trim() }), signal: controller.signal });
			const json = await response.json();
			if (!response.ok || !json.success) throw new Error("test");
			if (requestId === generation.current) { setAutomatic(json.data.automatic); setResult(json.data.test); }
		} catch {
			if (requestId === generation.current && !controller.signal.aborted) setResult({ ok: false, proxy: { source: "none", http: null, https: null }, latencyMs: 0, code: "failed" });
		} finally { if (requestId === generation.current) setTesting(false); }
	};
	const address = automatic?.https || automatic?.http;
	const errors: Record<ProxyTestCode, string> = { no_proxy: t.proxyNone, invalid: t.proxyInvalid, unsupported: t.proxyUnsupported, timeout: t.proxyTimeout, unreachable: t.proxyUnreachable, http: t.proxyHttpError, failed: t.proxyTestFailed };
	return <div className="flex min-w-0 flex-col gap-2" style={{ width: 260, maxWidth: "100%" }}>
		<div className="flex items-start gap-2" style={{ fontSize: 12, color: "var(--dsw-label-secondary)" }}>
			<div className="min-w-0 flex-1" aria-live="polite">
				<div>{loading ? t.proxyReading : loadFailed ? t.proxyReadFailed : automatic?.source === "env" ? t.proxyFromEnv : t.proxyFromSystem}</div>
				{!loading && !loadFailed && <div className="mt-1 break-all" style={{ color: "var(--dsw-label-primary)", fontFamily: address ? "var(--font-mono)" : undefined }}>{address || t.proxyNone}</div>}
				{automatic?.http && automatic.https && automatic.http !== automatic.https && <div className="mt-1 break-all" style={{ fontFamily: "var(--font-mono)" }}>HTTP: {automatic.http}</div>}
			</div>
			<button type="button" className="icon-btn shrink-0" aria-label={t.proxyRefresh} title={t.proxyRefresh} disabled={loading || testing} onClick={() => { setResult(null); setReload((n) => n + 1); }}><IconRefreshOutline14 size={14} /></button>
		</div>
		<input type="text" aria-label={t.proxyManualAddress} value={value} placeholder={t.proxyManualPlaceholder} spellCheck={false} disabled={disabled}
			onChange={(event) => onChange(event.target.value)} onBlur={(event) => { if (!(event.relatedTarget instanceof HTMLElement && event.relatedTarget.dataset.proxyTest)) onCommit(); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
			className="w-full rounded-lg px-2 py-1.5" style={{ minWidth: 0, fontSize: 12, background: "var(--dsw-hover)", fontFamily: "var(--font-mono)" }} />
		<div className="flex flex-wrap items-center gap-2">
			<button type="button" className="pw-chip" data-proxy-test="true" disabled={testing || loading || (!value.trim() && !address)} onMouseDown={(event) => event.preventDefault()} onClick={() => void test()}>
				{testing && <IconRefreshOutline14 size={13} className="animate-spin" />}{testing ? t.proxyTesting : t.proxyTest}
			</button>
			{result && <span role="status" className="flex min-w-0 items-center gap-1" style={{ fontSize: 12, color: result.ok ? "var(--dsw-label-primary)" : "var(--dsw-danger)" }}>
				{result.ok ? <IconCheckOutline14 size={14} /> : <IconWarningOutline16 size={14} />}
				{result.ok ? `${t.proxyConnected} · ${result.latencyMs} ms` : `${errors[result.code ?? "failed"]}${result.status ? ` (HTTP ${result.status})` : ""}`}
			</span>}
		</div>
		<div style={{ fontSize: 11.5, color: "var(--dsw-label-tertiary)" }}>{t.proxyTestHint}</div>
	</div>;
}
