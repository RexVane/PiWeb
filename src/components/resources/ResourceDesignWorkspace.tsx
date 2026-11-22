"use client";

import { useEffect, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import type { WebResourceView } from "@/lib/resources/protocol";
import { ResourceFrame } from "./ResourceFrame";
import { useResourceNavigation } from "./ResourceNavigation";
import { useResourceText } from "./text";

export function ResourceDesignWorkspace({ cwd, reloadSeq }: { cwd: string; reloadSeq: number }) {
	const text = useResourceText();
	const navigation = useResourceNavigation();
	const canContinue = Boolean(navigation?.continueDesign);
	const [status, setStatus] = useState<{ design: boolean; hasWeb: boolean }>();
	const [views, setViews] = useState<WebResourceView[]>([]);
	const [selected, setSelected] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const url = `/api/resources/development?cwd=${encodeURIComponent(cwd)}`;

	useEffect(() => {
		if (!cwd || !canContinue) return;
		let active = true;
		void clientFetch(`${url}&status=1`).then((response) => response.json()).then((result) => {
			if (active) setStatus(result.success ? result.data : undefined);
		}).catch(() => { if (active) setStatus(undefined); });
		return () => { active = false; };
	}, [cwd, canContinue, reloadSeq, url]);

	if (!status?.design) return null;
	const openPreview = async () => {
		setBusy(true); setError("");
		try {
			const response = await clientFetch(url);
			const result = await response.json();
			if (!result.success || !result.data.views?.length) throw new Error(result.error || text.frameFailed);
			setSelected(0); setViews(result.data.views);
		} catch (failure) { setError(failure instanceof Error ? failure.message : text.frameFailed); }
		finally { setBusy(false); }
	};
	const view = views[selected];
	return <section aria-label={text.designWorkspace} className="space-y-3 rounded-xl border border-[var(--dsw-border-l2)] p-3">
		<div className="flex flex-wrap items-center justify-between gap-3">
			<div className="min-w-0 space-y-1"><h2 className="text-sm font-medium">{text.designWorkspace}</h2><p className="break-all text-xs text-[var(--dsw-label-caption)]">{cwd}</p></div>
			<div className="flex flex-wrap gap-2">
				<button type="button" className="btn-outline" onClick={() => navigation?.continueDesign?.(cwd)}>{text.continueDesign}</button>
				{status.hasWeb && <button type="button" className="btn-outline" disabled={busy} onClick={() => void openPreview()}>{text.preview}</button>}
			</div>
		</div>
		{error && <p role="alert" className="text-xs text-[var(--dsw-danger)]">{error}</p>}
		{view && <div className="space-y-2 rounded-lg bg-[var(--dsw-hover)] p-3">
			<div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-[var(--dsw-label-caption)]">{text.previewHint}</p><button type="button" className="btn-outline" onClick={() => setViews([])}>{text.close}</button></div>
			{views.length > 1 && <select aria-label={text.preview} value={selected} onChange={(event) => setSelected(Number(event.target.value))}>{views.map((item, index) => <option key={item.id} value={index}>{item.title}</option>)}</select>}
			<ResourceFrame view={view} cwd={cwd} onCancel={() => setViews([])} />
		</div>}
	</section>;
}
