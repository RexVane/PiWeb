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
	const [draft, setDraft] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<ProxyTestResult | null>(null);
	const active = useRef<AbortController | null>(null);
	const generation = useRef(0);
	useEffect(() => {
		const controller = new AbortController();
		void fetch("/api/proxy", { signal: controller.signal }).then(async (response) => {
			const json = await response.json();
			if (!response.ok || !json.success || !json.data || !("source" in json.data)) throw new Error("load");
			if (!controller.signal.aborted) setAutomatic(json.data);
		}).catch(() => {})
			.finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, []);
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
	return <div className="flex min-w-0 flex-col gap-2" style={{ width: 320, maxWidth: "100%" }}>
		<div className="flex items-center gap-2">
			<input type="text" aria-label={t.httpProxy} value={draft ?? (value || address || "")} spellCheck={false} disabled={disabled}
				onChange={(event) => { setDraft(event.target.value); onChange(event.target.value); }}
				onBlur={(event) => { if (!(event.relatedTarget instanceof HTMLElement && event.relatedTarget.dataset.proxyTest)) { setDraft(null); onCommit(); } }}
				onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
				className="min-w-0 flex-1 rounded-lg px-2 py-1.5" style={{ fontSize: 12, background: "var(--dsw-hover)", fontFamily: "var(--font-mono)" }} />
			<button type="button" className="pw-chip shrink-0" data-proxy-test="true" disabled={testing || loading || (!value.trim() && !address)} onMouseDown={(event) => event.preventDefault()} onClick={() => void test()}>
				{testing && <IconRefreshOutline14 size={13} className="animate-spin" />}{testing ? t.proxyTesting : t.proxyTest}
			</button>
		</div>
		{result && <span role="status" className="flex min-w-0 items-center gap-1" style={{ fontSize: 12, color: result.ok ? "var(--dsw-label-primary)" : "var(--dsw-danger)" }}>
			{result.ok ? <IconCheckOutline14 size={14} /> : <IconWarningOutline16 size={14} />}
			{result.ok ? `${t.proxyConnected} · ${result.latencyMs} ms` : `${errors[result.code ?? "failed"]}${result.status ? ` (HTTP ${result.status})` : ""}`}
		</span>}
	</div>;
}
