"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconCheckOutline14, IconRefreshOutline14, IconWarningOutline16 } from "@/components/icons";
import { SelectOption } from "@/components/settings/SharedControls";
import { useI18n } from "@/i18n";
import type { DetectedProxy, ProxyChoice, ProxyTestCode, ProxyTestResult } from "@/lib/proxy-status";

type AutomaticProxyData = ProxyChoice & { detected?: DetectedProxy[] };
const CUSTOM_SENTINEL = "__custom__";

function formatAddressLabel(raw: string): string {
	try {
		return new URL(raw).host;
	} catch {
		return raw.replace(/^https?:\/\//i, "");
	}
}

export function ProxySettings({ value, disabled, onChange, onCommit }: {
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
	onCommit: (override?: string) => void;
}) {
	const { t } = useI18n();
	const [automatic, setAutomatic] = useState<AutomaticProxyData | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [customMode, setCustomMode] = useState(false);
	const [loading, setLoading] = useState(true);
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<ProxyTestResult | null>(null);
	const active = useRef<AbortController | null>(null);
	const generation = useRef(0);
	const customInputRef = useRef<HTMLInputElement>(null);

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
		generation.current += 1;
		active.current?.abort();
		setResult(null);
		setTesting(false);
	}, [value]);

	useEffect(() => () => {
		active.current?.abort();
	}, []);

	const address = automatic?.https || automatic?.http || null;
	const detected = useMemo<DetectedProxy[]>(() => {
		const items = Array.isArray(automatic?.detected) ? automatic.detected : [];
		if (items.length > 0) return items;
		if (!address || (automatic?.source !== "system" && automatic?.source !== "env")) return [];
		return [{ url: address, source: automatic.source }];
	}, [automatic, address]);

	const trimmedValue = value.trim();
	const isPresetValue = trimmedValue === "" || trimmedValue === "direct" || detected.some((item) => item.url === trimmedValue);
	const showCustom = customMode || (!isPresetValue && trimmedValue !== "");
	const selectValue = showCustom ? CUSTOM_SENTINEL : trimmedValue;

	const options = useMemo(() => {
		const list = [
			{ value: "", label: address ? `${t.proxySystem} (${formatAddressLabel(address)})` : t.proxySystem },
			{ value: "direct", label: t.proxyDirect },
			...detected.map((item) => ({
				value: item.url,
				label: `${item.url} (${item.source === "system" ? t.proxySourceSystem : t.proxySourceEnv})`,
			})),
			{ value: CUSTOM_SENTINEL, label: t.proxyCustom },
		];
		return list;
	}, [address, detected, t.proxySystem, t.proxyDirect, t.proxyCustom, t.proxySourceSystem, t.proxySourceEnv]);

	const activeDraft = draft ?? value;
	const testTarget = showCustom ? activeDraft.trim() : selectValue;
	const canTest = selectValue === "direct" || (selectValue === "" ? Boolean(address) : Boolean(testTarget));

	const test = async () => {
		const requestId = ++generation.current;
		const controller = new AbortController(); active.current = controller;
		setTesting(true); setResult(null);
		try {
			const response = await fetch("/api/proxy", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ proxy: testTarget }),
				signal: controller.signal,
			});
			const json = await response.json();
			if (!response.ok || !json.success) throw new Error("test");
			if (requestId === generation.current && !controller.signal.aborted) { setAutomatic(json.data.automatic); setResult(json.data.test); }
		} catch {
			if (requestId === generation.current && !controller.signal.aborted) {
				setResult({ ok: false, proxy: { source: "none", http: null, https: null }, latencyMs: 0, code: "failed" });
			}
		} finally {
			if (requestId === generation.current && !controller.signal.aborted) setTesting(false);
		}
	};

	const handleSelect = (next: string) => {
		setDraft(null);
		if (next === CUSTOM_SENTINEL) {
			setCustomMode(true);
			if (trimmedValue === "direct") onChange("");
			queueMicrotask(() => customInputRef.current?.focus());
			return;
		}
		setCustomMode(false);
		onChange(next);
		onCommit(next);
	};

	const errors: Record<ProxyTestCode, string> = {
		no_proxy: t.proxyNone,
		invalid: t.proxyInvalid,
		unsupported: t.proxyUnsupported,
		timeout: t.proxyTimeout,
		unreachable: t.proxyUnreachable,
		http: t.proxyHttpError,
		failed: t.proxyTestFailed,
	};

	return (
		<div className="flex min-w-0 flex-col gap-2" style={{ width: 320, maxWidth: "100%" }}>
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<SelectOption
						variant="field"
						label={t.httpProxy}
						value={selectValue}
						disabled={disabled}
						options={options}
						onChange={handleSelect}
					/>
				</div>
				<button
					type="button"
					className="pw-chip shrink-0"
					data-proxy-test="true"
					disabled={testing || loading || !canTest}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => void test()}
				>
					{testing && <IconRefreshOutline14 size={13} className="animate-spin" />}{testing ? t.proxyTesting : t.proxyTest}
				</button>
			</div>
			{showCustom && (
				<input
					ref={customInputRef}
					type="text"
					aria-label={t.httpProxy}
					value={draft ?? (value === "direct" ? "" : value)}
					placeholder={t.proxyCustomPlaceholder}
					spellCheck={false}
					disabled={disabled}
					onChange={(event) => { setDraft(event.target.value); onChange(event.target.value); }}
					onBlur={(event) => {
						if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.dataset.proxyTest) return;
						const next = (draft ?? value).trim();
						setDraft(null);
						if (!next) setCustomMode(false);
						onCommit(next);
					}}
					onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.keyCode !== 229 && event.key === "Enter") event.currentTarget.blur(); }}
					className="w-full rounded-lg px-2.5 py-1.5"
					style={{ fontSize: 12, background: "var(--dsw-hover)", fontFamily: "var(--font-mono)" }}
				/>
			)}
			{result && (
				<span role="status" className="flex min-w-0 items-center gap-1" style={{ fontSize: 12, color: result.ok ? "var(--dsw-label-primary)" : "var(--dsw-danger)" }}>
					{result.ok ? <IconCheckOutline14 size={14} /> : <IconWarningOutline16 size={14} />}
					{result.ok ? `${t.proxyConnected} · ${result.latencyMs} ms` : `${errors[result.code ?? "failed"]}${result.status ? ` (HTTP ${result.status})` : ""}`}
				</span>
			)}
		</div>
	);
}
