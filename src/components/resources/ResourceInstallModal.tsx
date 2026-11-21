"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import { useDialog } from "@/hooks/useDialog";
import { notifyResourcesChanged } from "@/hooks/useResourceRegistry";
import { DirectoryPicker } from "@/components/DirectoryPicker";
import { IconChevronRight14, IconCloseOutline14, IconExternalLink12, IconFolderOpenOutline16 } from "@/components/icons";
import type { WebResourceView } from "@/lib/resources/protocol";
import type { PreparedResource } from "@/lib/resources/development";
import { useResourceText } from "./text";
import { ResourceFrame } from "./ResourceFrame";

export type StartResourceSession = (cwd: string, prompt?: string) => Promise<boolean>;

function normalizeInstallSource(value: string) {
	const source = value.trim();
	const npmPage = /^https?:\/\/(?:www\.)?npmjs\.com\/package\/((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:\/v\/([a-z0-9][a-z0-9.+-]*))?\/?(?:[?#].*)?$/i.exec(source);
	if (!npmPage) return source;
	const [, name, version] = npmPage;
	return `npm:${name}${version ? `@${version}` : ""}`;
}

export function ResourceInstallModal({ open, cwd, mode = "install", busy: parentBusy = false, onClose, onSubmit, onStartSession }: {
	open: boolean; cwd: string; mode?: "install" | "design"; busy?: boolean; onClose: () => void;
	onSubmit: (source: string, local: boolean) => Promise<boolean>; onStartSession?: StartResourceSession;
}) {
	const text = useResourceText();
	const dialog = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [source, setSource] = useState("");
	const [local, setLocal] = useState(false);
	const [root, setRoot] = useState("");
	const [picker, setPicker] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [prepared, setPrepared] = useState<PreparedResource | null>(null);
	const [preview, setPreview] = useState<WebResourceView | null>(null);
	const [rootLoading, setRootLoading] = useState(false);
	const busyRef = useRef(false);
	const operation = useRef(0);
	const callbacks = useRef({ onClose, onStartSession, onSubmit });
	callbacks.current = { onClose, onStartSession, onSubmit };
	useDialog({ open, ref: dialog, onClose: () => { if (!busy && !parentBusy) onClose(); } });

	const prepare = useCallback(async (action: "inspect" | "adapt" | "design", chosenRoot: string, existingSource?: string, previous?: PreparedResource | null) => {
		if (busyRef.current) return;
		busyRef.current = true; setBusy(true); setError("");
		const id = ++operation.current;
		try {
			let workspace = action === "design" ? previous : undefined;
			let prompt: string | undefined;
			if (!workspace) {
				const response = await clientFetch("/api/resources/development", { method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action, root: chosenRoot || undefined, source: existingSource, preparedCwd: action === "adapt" ? previous?.cwd : undefined }) });
				const result = await response.json();
				if (id !== operation.current) return;
				if (!result.success) throw new Error(result.error || text.operationFailed);
				workspace = result.data.prepared as PreparedResource;
				if (action === "adapt") prompt = result.data.prompt;
				setPrepared(workspace); setPreview(null);
				notifyResourcesChanged();
			}
			if (action !== "inspect" && callbacks.current.onStartSession) {
				const started = await callbacks.current.onStartSession(workspace.cwd, prompt);
				if (id !== operation.current) return;
				if (started) callbacks.current.onClose(); else setError(text.operationFailed);
			}
		} catch (failure) { if (id === operation.current) setError(failure instanceof Error ? failure.message : text.operationFailed); }
		finally { if (id === operation.current) { busyRef.current = false; setBusy(false); } }
	}, [text.operationFailed]);

	useEffect(() => {
		if (!open) { operation.current += 1; busyRef.current = false; return; }
		let active = true;
		setError(""); setPrepared(null); setPreview(null); setAdvancedOpen(false); setSource(""); setBusy(false); setPicker(false);
		setRoot(""); setRootLoading(mode === "design");
		if (mode === "design") void clientFetch(`/api/resources?cwd=${encodeURIComponent(cwd)}`).then((response) => response.json()).then((result) => {
			if (active && result.success) setRoot(result.data.preferences?.developmentRoot || "");
		}).catch(() => undefined).finally(() => { if (active) setRootLoading(false); });
		return () => { active = false; operation.current += 1; busyRef.current = false; };
	}, [open, cwd, mode]);

	if (!open) return null;
	const changeSource = (value: string) => { setSource(value); setPrepared(null); setPreview(null); setError(""); };
	const installSource = normalizeInstallSource(source);
	const applyDirectory = (directory: string) => {
		if (mode === "design") setRoot(directory);
		else changeSource(directory);
	};
	const pickLocalDirectory = async () => {
		if (busyRef.current || parentBusy) return;
		busyRef.current = true; setBusy(true); setError("");
		const id = ++operation.current;
		try {
			const response = await clientFetch("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "pickDirectory" }), timeoutMs: 310_000 });
			const result = await response.json();
			if (id !== operation.current) return;
			if (!response.ok || !result.success) throw new Error(result.error || text.operationFailed);
			if (result.data?.remote || result.data?.browse) setPicker(true);
			else if (typeof result.data?.path === "string" && result.data.path) applyDirectory(result.data.path);
		} catch (failure) { if (id === operation.current) setError(failure instanceof Error ? failure.message : text.operationFailed); }
		finally { if (id === operation.current) { busyRef.current = false; setBusy(false); } }
	};
	const start = (action: "inspect" | "adapt" | "design") => {
		if (parentBusy || action === "design" && (rootLoading || !onStartSession)) return;
		void prepare(action, action === "design" ? root : "", action === "design" ? undefined : installSource, prepared);
	};
	const install = async () => {
		if (!installSource || (local && !cwd) || busyRef.current || parentBusy) return;
		busyRef.current = true; setBusy(true); setError("");
		const id = ++operation.current;
		try {
			const installed = await callbacks.current.onSubmit(installSource, local);
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
	const disabled = busy || parentBusy;
	const errorMessage = error && <p role="alert" className="break-words text-xs text-[var(--dsw-danger)]">{error}</p>;
	const preparedContent = prepared && <>
		<div role="status" className="space-y-1 rounded-lg bg-[var(--dsw-hover)] p-3 text-xs"><strong>{prepared.name}</strong><p>{prepared.compatibility === "web" ? text.web : prepared.compatibility === "adapt" ? text.adapt : text.unknown}</p><p className="break-all">{prepared.cwd}</p><p className="text-[var(--dsw-label-caption)]">{text.checkedHint}</p></div>
		<button type="button" className="btn-outline self-start" disabled={disabled} onClick={() => void openPreview()}>{text.preview}</button>
		{preview && <div className="space-y-2 rounded-lg border border-[var(--dsw-border-l2)] p-3"><p className="text-xs">{text.previewHint}</p><ResourceFrame view={preview} cwd={prepared.cwd} onCancel={() => setPreview(null)} /></div>}
	</>;
	return <>
		<div className="modal-mask fixed inset-0 z-[110] flex items-center justify-center p-4">
			<div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} className="glass-modal flex max-h-[90vh] w-full flex-col gap-4 overflow-y-auto p-5" style={{ maxWidth: mode === "install" ? 520 : 720 }}>
				<header className="flex items-center justify-between gap-3">
					<h2 id={titleId} className="text-base font-semibold">{mode === "design" ? text.design : text.installExisting}</h2>
					<button type="button" aria-label={text.close} disabled={disabled} onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-lg text-[var(--dsw-label-secondary)] hover:bg-[var(--dsw-hover)] disabled:opacity-50"><IconCloseOutline14 aria-hidden="true" /></button>
				</header>
				{mode === "install" ? <form className="flex flex-col gap-4" aria-busy={disabled} onSubmit={(event) => { event.preventDefault(); void install(); }}>
					<div className="flex flex-col gap-2">
						<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
							<label htmlFor={`${titleId}-source`} className="text-sm font-medium">{text.source}</label>
							<a href="https://pi.dev/packages" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-[var(--dsw-label-secondary)] underline decoration-[var(--dsw-border-l2)] underline-offset-2 hover:text-[var(--dsw-label-primary)]">{text.piGallery}<IconExternalLink12 aria-hidden="true" /></a>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<input id={`${titleId}-source`} value={source} placeholder="https://github.com/owner/repo" disabled={disabled} onChange={(event) => changeSource(event.target.value)} className="min-w-0 grow basis-48 rounded-lg border border-[var(--dsw-border-l2)] bg-[var(--dsw-hover)] px-3 py-2.5 text-sm" />
							<button type="button" className="btn-outline" aria-haspopup="dialog" disabled={disabled} onClick={() => void pickLocalDirectory()}><IconFolderOpenOutline16 aria-hidden="true" />{text.pickLocalDirectory}</button>
						</div>
					</div>
					<fieldset className="min-w-0" disabled={disabled}>
						<legend className="mb-2 text-sm font-medium">{text.scope}</legend>
						<div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
							<label className="inline-flex items-center gap-2"><input type="radio" name={`${titleId}-scope`} checked={!local} onChange={() => setLocal(false)} />{text.user}</label>
							<label className="inline-flex items-center gap-2"><input type="radio" name={`${titleId}-scope`} checked={local} onChange={() => setLocal(true)} disabled={!cwd} />{text.project}</label>
						</div>
					</fieldset>
					<div className="border-t border-[var(--dsw-border-l2)] pt-2">
						<button type="button" aria-expanded={advancedOpen} aria-controls={`${titleId}-advanced`} onClick={() => setAdvancedOpen(!advancedOpen)} className="inline-flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-xs text-[var(--dsw-label-secondary)] hover:text-[var(--dsw-label-primary)]"><IconChevronRight14 aria-hidden="true" className={advancedOpen ? "rotate-90" : undefined} />{text.advancedOptions}</button>
						<div id={`${titleId}-advanced`} hidden={!advancedOpen}>
							{advancedOpen && <div className="flex flex-col gap-3 pt-2">
								<p className="text-xs text-[var(--dsw-label-caption)]">{text.nativeInstallHint}</p>
								<div className="flex flex-wrap gap-2">
									<button type="button" className="btn-outline" disabled={disabled || !source.trim()} onClick={() => start("inspect")}>{text.check}</button>
									{onStartSession && <button type="button" className="btn-outline" disabled={disabled || !source.trim()} onClick={() => start("adapt")}>{text.startAdapt}</button>}
								</div>
								{preparedContent}
							</div>}
						</div>
					</div>
					{errorMessage}
					<footer className="flex justify-end"><button type="submit" className="btn-primary-white" disabled={disabled || !source.trim() || (local && !cwd)}>{text.install}</button></footer>
				</form> : <form className="flex flex-col gap-4" aria-busy={disabled} onSubmit={(event) => { event.preventDefault(); start("design"); }}>
					<div className="flex flex-col gap-2"><span className="text-sm">{text.designDirectory}</span><div className="flex items-center gap-2"><span className="min-w-0 flex-1 break-all text-xs">{prepared?.cwd || root || "—"}</span><button type="button" className="btn-outline" disabled={disabled || rootLoading || Boolean(prepared)} onClick={() => void pickLocalDirectory()}>{text.chooseDirectory}</button></div><p className="text-xs text-[var(--dsw-label-caption)]">{text.designDirectoryHint}</p></div>
					{errorMessage}
					<footer className="flex justify-end"><button type="submit" className="btn-primary-white" disabled={disabled || rootLoading || !onStartSession}>{disabled ? text.creating : prepared ? text.continueDesign : text.startDesign}</button></footer>
				</form>}
			</div>
		</div>
		{picker && <div className="relative z-[140]"><DirectoryPicker open title={text.pickLocalDirectory} onCancel={() => setPicker(false)} onConfirm={(directory) => {
			setPicker(false);
			applyDirectory(directory);
		}} /></div>}
	</>;
}
