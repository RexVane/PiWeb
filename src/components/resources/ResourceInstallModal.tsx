"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import { useDialog } from "@/hooks/useDialog";
import { notifyResourcesChanged } from "@/hooks/useResourceRegistry";
import { DirectoryPicker } from "@/components/DirectoryPicker";
import type { ResourceCatalogItem, ResourceSelection, ResourceType, WebResourceView } from "@/lib/resources/protocol";
import type { PreparedResource } from "@/lib/resources/development";
import { useResourceText } from "./text";
import { ResourceFrame } from "./ResourceFrame";

export type StartResourceSession = (cwd: string, prompt: string) => Promise<boolean>;

export function ResourceInstallModal({ open, cwd, mode = "install", busy: parentBusy = false, onClose, onSubmit, onStartSession }: {
	open: boolean; cwd: string; mode?: "install" | "design"; busy?: boolean; onClose: () => void;
	onSubmit: (source: string, local: boolean, selection?: ResourceSelection) => Promise<boolean>; onStartSession?: StartResourceSession;
}) {
	const text = useResourceText();
	const dialog = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const [tab, setTab] = useState<"market" | "pi" | "source">("market");
	const [items, setItems] = useState<ResourceCatalogItem[]>([]);
	const [query, setQuery] = useState("");
	const [type, setType] = useState<ResourceType | "all">("all");
	const [source, setSource] = useState("");
	const [local, setLocal] = useState(false);
	const [root, setRoot] = useState("");
	const [picker, setPicker] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [warning, setWarning] = useState(false);
	const [prepared, setPrepared] = useState<PreparedResource | null>(null);
	const [preview, setPreview] = useState<WebResourceView | null>(null);
	const [designPrompt, setDesignPrompt] = useState("");
	const [selected, setSelected] = useState<ResourceCatalogItem | null>(null);
	const busyRef = useRef(false);
	const operation = useRef(0);
	const requested = useRef<"inspect" | "adapt" | "design">("design");
	const callbacks = useRef({ onClose, onStartSession, onSubmit });
	callbacks.current = { onClose, onStartSession, onSubmit };
	useDialog({ open, ref: dialog, onClose: () => { if (!busy && !parentBusy) onClose(); } });

	const prepare = useCallback(async (action: "inspect" | "adapt" | "design", chosenRoot: string, existingSource?: string, previous?: PreparedResource | null) => {
		if (busyRef.current) return;
		busyRef.current = true; setBusy(true); setError("");
		const id = ++operation.current;
		try {
			const response = await clientFetch("/api/resources/development", { method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, root: chosenRoot || undefined, source: existingSource, preparedCwd: action === "adapt" ? previous?.cwd : undefined }) });
			const result = await response.json();
			if (id !== operation.current) return;
			if (!result.success) throw new Error(result.error || text.operationFailed);
			setPrepared(result.data.prepared); setDesignPrompt(result.data.prompt || "");
			notifyResourcesChanged();
			if (action !== "inspect" && callbacks.current.onStartSession) {
				const started = await callbacks.current.onStartSession(result.data.prepared.cwd, result.data.prompt);
				if (id !== operation.current) return;
				if (started) callbacks.current.onClose(); else setError(text.operationFailed);
			}
		} catch (failure) { if (id === operation.current) setError(failure instanceof Error ? failure.message : text.operationFailed); }
		finally { if (id === operation.current) { busyRef.current = false; setBusy(false); } }
	}, [text.operationFailed]);

	useEffect(() => {
		if (!open) { operation.current += 1; busyRef.current = false; return; }
		let active = true;
		setError(""); setPrepared(null); setPreview(null); setDesignPrompt(""); setSelected(null); setSource(""); setBusy(false); setPicker(false);
		void clientFetch(`/api/resources?cwd=${encodeURIComponent(cwd)}`).then((response) => response.json()).then((result) => {
			if (!active || !result.success) return;
			const directory = result.data.preferences?.developmentRoot || "";
			setRoot(directory);
			if (mode === "design" && directory) void prepare("design", directory);
		}).catch(() => undefined);
		return () => { active = false; operation.current += 1; busyRef.current = false; };
	}, [open, cwd, mode, prepare]);

	const loadMarket = useCallback(async (fresh = false) => {
		try {
			const response = await clientFetch(`/api/resources?cwd=${encodeURIComponent(cwd)}&market=1${fresh ? "&fresh=1" : ""}`);
			const result = await response.json();
			if (result.success) { setItems(result.data.items ?? []); setWarning(Boolean(result.data.warnings?.length)); }
			else setWarning(true);
		} catch { setWarning(true); }
	}, [cwd]);
	useEffect(() => { if (open && mode === "install" && tab === "market") void loadMarket(); }, [open, mode, tab, loadMarket]);

	if (!open) return null;
	const start = (action: "inspect" | "adapt" | "design") => {
		requested.current = action;
		if (!root) { setPicker(true); return; }
		void prepare(action, root, source.trim(), prepared);
	};
	const install = async () => {
		const installSource = prepared?.installSource || source.trim();
		if (!installSource || busyRef.current || parentBusy) return;
		busyRef.current = true; setBusy(true); setError("");
		const id = ++operation.current;
		try {
			const installed = selected?.selection
				? await callbacks.current.onSubmit(installSource, local, selected.selection)
				: await callbacks.current.onSubmit(installSource, local);
			if (id !== operation.current) return;
			if (installed) { notifyResourcesChanged(); callbacks.current.onClose(); } else setError(text.operationFailed);
		} finally { if (id === operation.current) { busyRef.current = false; setBusy(false); } }
	};
	const openPreview = async () => {
		if (!prepared) return;
		try {
			const response = await clientFetch(`/api/resources/development?cwd=${encodeURIComponent(prepared.cwd)}`);
			const result = await response.json();
			if (!result.success || !result.data.views?.length) throw new Error(result.error || text.frameFailed);
			setPreview(result.data.views[0]);
		} catch (failure) { setError(failure instanceof Error ? failure.message : text.frameFailed); }
	};
	const chosenCompatibility = prepared?.compatibility ?? selected?.compatibility;
	const visible = items.filter((item) => (type === "all" || item.types.includes(type)) && `${item.name} ${item.description} ${item.author}`.toLowerCase().includes(query.toLowerCase()));
	const disabled = busy || parentBusy;
	return <>
		<div className="modal-mask fixed inset-0 z-[110] flex items-center justify-center p-4">
			<div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} className="glass-modal flex w-full flex-col gap-4 p-5" style={{ maxWidth: 720, maxHeight: "90vh", overflowY: "auto" }}>
				<header className="flex items-center justify-between gap-3"><h2 id={titleId} style={{ fontSize: 16, fontWeight: 600 }}>{mode === "design" ? text.design : text.installExisting}</h2><button type="button" className="btn-outline" disabled={disabled} onClick={onClose}>{text.close}</button></header>
				{mode === "install" && <>
					<div role="tablist" className="flex flex-wrap gap-2">{(["market", "pi", "source"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} className="btn-outline" onClick={() => setTab(value)}>{value === "market" ? text.piwebMarket : value === "pi" ? text.piResources : text.sourceTab}</button>)}</div>
					{tab === "market" && <>
						<div className="flex flex-wrap gap-2"><input aria-label={text.search} placeholder={text.search} value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-lg bg-[var(--dsw-hover)] px-3 py-2" />
							<select aria-label={text.market} value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="all">{text.all}</option><option value="extensions">{text.extensions}</option><option value="skills">{text.skills}</option><option value="prompts">{text.prompts}</option></select>
							<button type="button" className="btn-outline" onClick={() => void loadMarket(true)}>{text.refresh}</button></div>
						{warning && <p role="status" style={{ fontSize: 12 }}>{text.marketUnavailable}</p>}
						<div className="flex max-h-64 flex-col gap-2 overflow-auto">{visible.map((item) => <button type="button" key={item.id} disabled={!item.source || disabled} className="rounded-xl border border-[var(--dsw-border-l2)] p-3 text-left" onClick={() => { setSelected(item); setSource(item.source || ""); setPrepared(null); }}>
							<span className="block font-medium">{item.name} <span style={{ fontSize: 11 }}>{item.version} · {item.author}</span></span><span className="mt-1 block" style={{ fontSize: 12 }}>{item.description}</span>
							<span className="mt-2 block" style={{ fontSize: 11, color: "var(--dsw-label-caption)" }}>{item.types.map((kind) => text[kind]).join(" · ")} · {item.compatibility === "web" ? text.web : item.compatibility === "adapt" ? text.adapt : text.unknown}{!item.source ? ` · ${text.unavailable}` : ""}</span>
						</button>)}{!visible.length && <p>{text.empty}</p>}</div>
					</>}
					{tab === "pi" && <p style={{ fontSize: 13 }}>{text.piGalleryHint} <a href="https://pi.dev/packages" target="_blank" rel="noopener noreferrer" className="underline">{text.piGallery}</a></p>}
					<label className="flex flex-col gap-1.5"><span>{text.source}</span><input value={source} placeholder="npm:@example/resource · git:github.com/owner/repo · /path/to/resource" disabled={disabled} onChange={(event) => { setSource(event.target.value); setSelected(null); setPrepared(null); }} className="rounded-lg bg-[var(--dsw-hover)] px-3 py-2" /></label>
					<div className="flex flex-wrap items-center gap-3"><span>{text.scope}</span><label><input type="radio" name={`${titleId}-scope`} checked={!local} onChange={() => setLocal(false)} disabled={disabled} /> {text.user}</label><label><input type="radio" name={`${titleId}-scope`} checked={local} onChange={() => setLocal(true)} disabled={!cwd || disabled} /> {text.project}</label></div>
				</>}
				<div className="flex flex-col gap-2"><span style={{ fontSize: 13 }}>{text.developmentRoot}</span><div className="flex items-center gap-2"><span className="min-w-0 flex-1 break-all" style={{ fontSize: 12 }}>{root || "—"}</span><button type="button" className="btn-outline" disabled={disabled} onClick={() => { requested.current = mode === "design" ? "design" : "inspect"; setPicker(true); }}>{text.chooseDirectory}</button></div><p style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{text.directoryHint}</p></div>
				{prepared && <div role="status" className="rounded-lg bg-[var(--dsw-hover)] p-3"><strong>{prepared.name}</strong><p style={{ fontSize: 12 }}>{prepared.compatibility === "web" ? text.web : prepared.compatibility === "adapt" ? text.adapt : text.unknown}</p><p className="break-all" style={{ fontSize: 11.5 }}>{prepared.cwd}</p><p style={{ fontSize: 11.5 }}>{text.checkedHint}</p></div>}
				{prepared && <button type="button" className="btn-outline" disabled={disabled} onClick={() => void openPreview()}>{text.preview}</button>}
				{preview && prepared && <div className="rounded-lg border border-[var(--dsw-border-l2)] p-3"><p style={{ fontSize: 12 }}>{text.previewHint}</p><ResourceFrame view={preview} cwd={prepared.cwd} onCancel={() => setPreview(null)} /></div>}
				{mode === "install" && <p style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{text.trustWarning}</p>}
				{error && <p role="alert" className="break-words" style={{ color: "var(--dsw-danger)", fontSize: 12 }}>{error}</p>}
				<footer className="flex flex-wrap justify-end gap-2">{disabled ? <span role="status">{text.creating}</span> : mode === "design" ? <button type="button" className="btn-primary-white" disabled={!onStartSession} onClick={() => {
					if (prepared && designPrompt && onStartSession) void onStartSession(prepared.cwd, designPrompt).then((started) => { if (started) onClose(); }); else start("design");
				}}>{text.startDesign}</button> : <>
					<button type="button" className="btn-outline" disabled={!source.trim()} onClick={() => start("inspect")}>{text.check}</button>
					{onStartSession && <button type="button" className="btn-outline" disabled={!source.trim()} onClick={() => start("adapt")}>{text.startAdapt}</button>}
					<button type="button" className="btn-primary-white" disabled={!source.trim()} onClick={() => chosenCompatibility === "adapt" ? start("adapt") : void install()}>{chosenCompatibility === "adapt" ? text.adaptInstall : text.install}</button>
				</>}</footer>
			</div>
		</div>
		{picker && <div className="relative z-[140]"><DirectoryPicker open onCancel={() => setPicker(false)} onConfirm={(directory) => {
			setPicker(false); setRoot(directory);
			if (mode === "design" || source.trim()) void prepare(requested.current, directory, source.trim(), prepared);
			else void clientFetch("/api/resources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "preferences", cwd, preferences: { developmentRoot: directory } }) }).then((response) => response.json()).then((result) => { if (!result.success) setError(result.error || text.operationFailed); });
		}} /></div>}
	</>;
}
