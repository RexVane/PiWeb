"use client";
import { useEffect, useRef, useState } from "react";
import { useResourceRegistry, notifyResourcesChanged } from "@/hooks/useResourceRegistry";
import { useDialog } from "@/hooks/useDialog";
import { clientFetch } from "@/lib/client-fetch";
import type { ResourceDialogMethod, WebResourceView } from "@/lib/resources/protocol";
import { ResourceFrame } from "./ResourceFrame";
import { SelectOption } from "@/components/settings/SharedControls";
import { useResourceText } from "./text";
import { useI18n } from "@/i18n";

export function ResourceControls({ cwd, sessionPath }: { cwd: string; sessionPath?: string }) {
	const text = useResourceText();
	const { t, lang } = useI18n();
	const labelOf = (view: WebResourceView) => view.titles?.[lang as keyof NonNullable<typeof view.titles>] ?? view.title;
	const registry = useResourceRegistry(cwd);
	const [selected, setSelected] = useState<WebResourceView | null>(null);
	const [error, setError] = useState("");
	const [warning, setWarning] = useState("");
	const dialog = useRef<HTMLDivElement>(null);
	useEffect(() => { if (selected && !registry.views.some((view) => view.id === selected.id)) setSelected(null); }, [registry.views, selected]);
	useDialog({ open: !!selected, ref: dialog, onClose: () => setSelected(null) });
	const methods: ResourceDialogMethod[] = ["select", "confirm", "input", "editor", "web"];
	const supported = methods.filter((method) => registry.views.some((view) => view.methods.includes(method)));
	const updateResources = async (payload: Record<string, unknown>) => {
		try {
			const response = await clientFetch("/api/resources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, cwd }) });
			const result = await response.json();
			const applied = result.data?.applied === true;
			if (!result.success && !applied) throw new Error(result.error || text.operationFailed);
			const detail = typeof result.data?.warning === "string" ? result.data.warning : "";
			setWarning(applied && (detail || !result.success) ? `${t.promptTemplatesRefreshWarning}${detail ? ` ${detail}` : ""}` : detail);
			setError("");
			// Persisted changes still need discovery refresh when live-session reload is incomplete.
			notifyResourcesChanged();
		} catch (failure) { setError(failure instanceof Error ? failure.message : text.operationFailed); }
	};
	const saveRenderer = (method: ResourceDialogMethod, id: string) => updateResources({ action: "preferences", preferences: { renderers: { ...registry.preferences.renderers, [method]: id } } });
	const toggle = (resource: typeof registry.packages[number]) => updateResources({ action: "setEnabled", resourceId: resource.id, scope: resource.scope, enabled: !resource.enabled });
	if (!registry.packages.length && !registry.views.length && !registry.hosts.length && !selected && !error && !warning) return null;
	return <section className="flex flex-col gap-3">
		<h2 style={{ fontSize: 13, fontWeight: 500 }}>{text.panels}</h2>
		{registry.packages.filter((resource) => Array.isArray(resource.extensionPaths) && resource.extensionPaths.length > 0).map((resource) => <label key={`${resource.scope}:${resource.id}`} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--dsw-border-l2)] px-3 py-2" style={{ fontSize: 12 }}>
			<span className="min-w-0 break-all">{resource.name} · {resource.enabled ? t.enabled : t.disabled}</span>
			<input type="checkbox" role="switch" aria-label={resource.name} checked={resource.enabled} onChange={() => void toggle(resource)} />
		</label>)}
		{supported.map((method) => <div key={method} className="flex flex-wrap items-center justify-between gap-2" style={{ fontSize: 12 }}>
			<span>{text.renderer} · {method}</span>
			<SelectOption value={registry.preferences.renderers[method] || ""} label={`${text.renderer} · ${method}`}
				options={[{ value: "", label: text.basic }, ...registry.views.filter((view) => view.methods.includes(method)).map((view) => ({ value: view.id, label: labelOf(view) }))]}
				onChange={(value) => void saveRenderer(method, value)} />
		</div>)}
		<div className="flex flex-wrap gap-2">{registry.views.filter((view) => view.placement === "panel").map((view) => <button key={view.id} type="button" className="btn-outline" onClick={() => setSelected(view)}>{labelOf(view)} · {text.openPanel}</button>)}</div>
		{registry.hosts.map((host) => <p key={`${host.scope}:${host.id}`} style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{host.id} · {host.state} · {host.services.join(", ")}{host.active ? ` (${host.active})` : ""}</p>)}
		{warning && <p role="status" style={{ color: "var(--dsw-warn)" }}>{warning}</p>}
		{error && <p role="alert">{error}</p>}
		{selected && <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" style={{ background: "var(--dsw-mask)" }}>
			<div ref={dialog} role="dialog" aria-modal="true" aria-label={labelOf(selected)} className="glass-modal flex w-full flex-col gap-3 p-5" style={{ maxWidth: 800, maxHeight: "90vh", overflowY: "auto" }}>
				<header className="flex items-center justify-between"><h3>{labelOf(selected)}</h3><button type="button" className="btn-outline" onClick={() => setSelected(null)}>{text.close}</button></header>
				<ResourceFrame view={selected} cwd={cwd} sessionPath={sessionPath} onCancel={() => setSelected(null)} />
			</div>
		</div>}
	</section>;
}
