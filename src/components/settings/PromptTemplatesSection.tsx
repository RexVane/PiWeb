"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import type { PromptTemplateView } from "@/lib/prompt-template-view";
import { useI18n } from "@/i18n";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { IconFileOutline16, IconSearchOutline16 } from "@/components/icons";
import { ScopeWorkspaceFilterBar } from "./SharedControls";

type ScopeFilter = "all" | PromptTemplateView["scope"];
const SCOPE_STYLE = {
	user: { color: "#3b82f6", bg: "rgba(59, 130, 246, 0.12)" },
	project: { color: "#10b981", bg: "rgba(16, 185, 129, 0.12)" },
	temporary: { color: "#f59e0b", bg: "rgba(245, 158, 11, 0.12)" },
};

export function PromptTemplatesSection({ cwd, onOpenFileContent, reloadSeq = 0, workspaceOptions, onCwdChange }: {
	cwd: string;
	onOpenFileContent?: (path: string, content: string, sourceCwd: string) => void;
	reloadSeq?: number;
	workspaceOptions?: { value: string; label: string }[];
	onCwdChange?: (cwd: string) => void;
}) {
	const { t } = useI18n();
	const { confirm, confirmDialog } = useConfirmDialog();
	const [templates, setTemplates] = useState<PromptTemplateView[]>([]);
	const [scope, setScope] = useState<ScopeFilter>("all");
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const workspaceSeq = useRef(0);
	const loadSeq = useRef(0);
	const busyRef = useRef(false);

	useEffect(() => {
		workspaceSeq.current += 1;
		busyRef.current = false;
		setTemplates([]); setError(null); setBusy(false); setLoading(true);
		return () => { workspaceSeq.current += 1; loadSeq.current += 1; };
	}, [cwd]);

	const load = useCallback(async () => {
		const workspace = workspaceSeq.current;
		const request = ++loadSeq.current;
		setLoading(true);
		try {
			const response = await clientFetch(`/api/prompt-templates?cwd=${encodeURIComponent(cwd)}`);
			const result = await response.json();
			if (workspace !== workspaceSeq.current || request !== loadSeq.current) return;
			if (!result.success || !Array.isArray(result.data?.templates)) throw new Error(result.errorCode === "TRASH_UNAVAILABLE" ? t.apiErrorTrashUnavailable : result.error || t.toastError);
			setTemplates(result.data.templates); setError(null);
		} catch (failure) {
			if (workspace === workspaceSeq.current && request === loadSeq.current) setError(failure instanceof Error ? failure.message : t.toastError);
		} finally {
			if (workspace === workspaceSeq.current && request === loadSeq.current) setLoading(false);
		}
	}, [cwd, t.toastError, t.apiErrorTrashUnavailable]);
	useEffect(() => { void load(); }, [load, reloadSeq]);

	const perform = async (template: PromptTemplateView, action: "read" | "toggle" | "delete") => {
		if (busyRef.current) return;
		const workspace = workspaceSeq.current;
		busyRef.current = true; setBusy(true); setError(null);
		const post = async (payload: Record<string, unknown>) => {
			const response = await clientFetch("/api/prompt-templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, cwd, filePath: template.filePath }) });
			const result = await response.json();
			if (!result.success) throw new Error(result.errorCode === "TRASH_UNAVAILABLE" ? t.apiErrorTrashUnavailable : result.error || t.toastError);
			return result.data;
		};
		try {
			let expectedPath: string | undefined;
			if (action === "delete") {
				const preview = await post({ action: "previewDelete" });
				if (workspace !== workspaceSeq.current) return;
				if (typeof preview?.removed !== "string") throw new Error(t.toastError);
				expectedPath = preview.removed;
				if (!await confirm({ title: t.delete, message: `${t.promptTemplatesConfirmDelete.replace("{name}", template.name)}\n\n${expectedPath}`, confirmLabel: t.delete })) return;
				if (workspace !== workspaceSeq.current) return;
			}
			if (action !== "read") loadSeq.current += 1;
			const data = await post({ action, ...(expectedPath ? { expectedPath } : {}), ...(action === "toggle" ? { disabled: !template.disabled } : {}) });
			if (workspace !== workspaceSeq.current) return;
			if (action === "read") {
				if (typeof data?.content !== "string") throw new Error(t.toastError);
				onOpenFileContent?.(template.filePath, data.content, cwd);
			} else {
				await load();
				if (workspace === workspaceSeq.current && data?.warning) setError(t.promptTemplatesRefreshWarning);
			}
		} catch (failure) {
			if (workspace === workspaceSeq.current) setError(failure instanceof Error ? failure.message : t.toastError);
		} finally {
			if (workspace === workspaceSeq.current) { busyRef.current = false; setBusy(false); }
		}
	};

	const counts = useMemo(() => {
		const counts = { all: templates.length, user: 0, project: 0, temporary: 0 };
		for (const template of templates) counts[template.scope] += 1;
		return counts;
	}, [templates]);
	const deferredQuery = useDeferredValue(query);
	const filtered = useMemo(() => {
		const q = deferredQuery.trim().toLowerCase();
		return templates.filter((template) => (scope === "all" || template.scope === scope) && (!q
			|| `${template.name} /${template.name} ${template.description} ${template.filePath} ${template.sourceLabel}`.toLowerCase().includes(q)));
	}, [templates, scope, deferredQuery]);
	const tabs: { id: ScopeFilter; label: string; count: number }[] = [
		{ id: "all", label: t.skillFilterAll, count: counts.all },
		{ id: "user", label: t.skillScopeUser, count: counts.user },
		{ id: "project", label: t.skillScopeProject, count: counts.project },
		...(counts.temporary ? [{ id: "temporary" as const, label: t.skillScopeTemporary, count: counts.temporary }] : []),
	];

	return <div className="flex flex-col gap-4" aria-busy={busy || loading}>
		{error && <div role="alert" className="rounded-lg px-3 py-2" style={{ fontSize: 12.5, background: "var(--dsw-hover)", color: "var(--dsw-danger)" }}>{error}</div>}
		<ScopeWorkspaceFilterBar tabs={tabs} activeTab={scope} onTabChange={setScope} ariaLabel={t.skillScopeFilterLabel}
			workspace={{ visible: scope === "project", cwd, label: t.workspaceScope, options: workspaceOptions, onChange: onCwdChange }} />
		{templates.length > 0 && <div className="isx-search relative">
			<IconSearchOutline16 size={15} className="isx-search-icon pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: "var(--dsw-label-caption)" }} />
			<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.promptTemplatesSearch} aria-label={t.promptTemplatesSearch}
				className="w-full rounded-lg outline-none" style={{ height: 38, paddingLeft: 36, paddingRight: 12, fontSize: "var(--dsh-ui-font-sm)", background: "var(--dsw-bg-elevated, transparent)", border: "0.5px solid var(--dsw-border-l2)", color: "var(--dsw-label-primary)" }} />
		</div>}
		{!templates.length && <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
			<IconFileOutline16 size={24} style={{ color: "var(--dsw-label-caption)" }} />
			<div style={{ fontSize: "var(--dsh-ui-font-135)", color: "var(--dsw-label-tertiary)" }}>{loading ? t.promptLoading : t.promptTemplatesEmpty}</div>
			{!loading && <p className="max-w-lg" style={{ fontSize: 12, color: "var(--dsw-label-caption)", lineHeight: 1.6 }}>{t.promptTemplatesDirectoryHint}</p>}
		</div>}
		{templates.length > 0 && !filtered.length && <p className="py-12 text-center" style={{ fontSize: "var(--dsh-ui-font-135)", color: "var(--dsw-label-tertiary)" }}>{t.promptTemplatesNoMatches}</p>}
		<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
			{filtered.map((template) => {
				const accent = SCOPE_STYLE[template.scope];
				const scopeLabel = template.scope === "user" ? t.skillScopeUser : template.scope === "project" ? t.skillScopeProject : t.skillScopeTemporary;
				return <div key={template.filePath} className="flex flex-col justify-between rounded-lg px-4 py-3.5" style={{ border: "0.5px solid var(--dsw-border-l2)", opacity: template.disabled ? 0.68 : 1 }}>
					<div className="flex items-start gap-3">
						<span className="flex flex-none items-center justify-center rounded-lg" style={{ width: 38, height: 38, background: accent.bg, color: accent.color }}><IconFileOutline16 size={18} /></span>
						<div className="min-w-0 flex-1">
							<div className="flex items-center justify-between gap-2">
								<div className="flex min-w-0 flex-wrap items-center gap-1.5">
									<span className="truncate font-semibold" style={{ fontSize: "var(--dsh-ui-font-md)" }}>{template.name}</span>
									<span className="rounded-full px-2 py-0.5" style={{ fontSize: "var(--dsh-ui-font-2xs)", background: accent.bg, color: accent.color }}>{scopeLabel}</span>
									{template.origin === "package" && <span className="rounded-full px-2 py-0.5" style={{ fontSize: "var(--dsh-ui-font-2xs)", background: "rgba(139, 92, 246, 0.12)", color: "#8b5cf6" }}>{t.skillOriginPackage}</span>}
									{template.disabled && <span className="rounded-full bg-[var(--dsw-hover)] px-2 py-0.5" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>{t.skillDisabledBadge}</span>}
								</div>
								<button type="button" className="liq-sw flex-none" data-on={!template.disabled ? "true" : undefined} role="switch" aria-checked={!template.disabled} aria-label={template.name}
									disabled={busy || !template.canToggle} onClick={() => void perform(template, "toggle")}><span className="liq-thumb" /></button>
							</div>
							<p className="mt-1.5 line-clamp-2" title={template.description} style={{ fontSize: "var(--dsh-ui-font-125)", minHeight: 38, lineHeight: 1.5, color: "var(--dsw-label-secondary)" }}>{template.readError ? t.promptTemplatesUnreadable : template.description}</p>
						</div>
					</div>
					<div className="mt-3 flex flex-col gap-1.5 pl-[50px]" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>
						<code className="w-fit max-w-full truncate rounded bg-[var(--dsw-hover)] px-1.5 py-0.5" title={`/${template.name}${template.argumentHint ? ` ${template.argumentHint}` : ""}`}>/{template.name}{template.argumentHint ? ` ${template.argumentHint}` : ""}</code>
						<span className="truncate" title={template.filePath}>{template.filePath}</span>
						<span className="truncate" title={template.sourceLabel}>{t.skillSourceLabel}: {template.sourceLabel}</span>
					</div>
					<div className="hairline-t mt-3 flex items-center justify-between gap-2 pt-2.5">
						<button type="button" className="btn-outline" style={{ height: "max(28px, calc(28px + var(--dsh-content-font-delta)))", fontSize: "var(--dsh-ui-font-xs)", padding: "0 10px" }} disabled={busy} onClick={() => void perform(template, "read")}><IconFileOutline16 size={13} />{t.promptTemplatesView}</button>
						{template.canDelete ? <button type="button" className="rounded-lg px-2.5 py-1 hover:bg-[var(--dsw-hover)]" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-danger)" }} title={t.promptTemplatesDeleteHint} disabled={busy} onClick={() => void perform(template, "delete")}>{t.delete}</button>
							: <span className="truncate" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }} title={template.origin === "package" ? t.promptTemplatesPackageHint : t.promptTemplatesExternalHint}>{template.origin === "package" ? t.promptTemplatesPackageHint : t.promptTemplatesExternalHint}</span>}
					</div>
				</div>;
			})}
		</div>
		{confirmDialog}
	</div>;
}
