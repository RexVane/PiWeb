"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDialog } from "@/hooks/useDialog";
import { useResourceRegistry } from "@/hooks/useResourceRegistry";
import type { ResourceDialogIntent, ResourceUiOutcome } from "@/lib/resources/protocol";
import { ResourceFrame } from "./ResourceFrame";

/** Generic UI navigation, supplied by the application shell. Never starts a model turn. */
export interface ResourceNavigation {
	openSession(sessionPath: string): void;
	createDraft(cwd: string, text: string): void;
	openView(intent: ResourceDialogIntent, signal: AbortSignal): Promise<ResourceUiOutcome>;
}
const Context = createContext<ResourceNavigation | null>(null);
interface PendingDialog { id: string; intent: ResourceDialogIntent; finish(outcome: ResourceUiOutcome): void }

export function ResourceNavigationProvider({ value, children }: { value: Omit<ResourceNavigation, "openView">; children: ReactNode }) {
	const [dialog, setDialog] = useState<PendingDialog | null>(null);
	const pending = useRef<PendingDialog | null>(null);
	const openView = useCallback((intent: ResourceDialogIntent, signal: AbortSignal): Promise<ResourceUiOutcome> => {
		if (pending.current) return Promise.reject(new Error("A resource dialog is already open"));
		if (signal.aborted) return Promise.resolve({ status: "cancelled" });
		return new Promise((resolve) => {
			let finished = false;
			const onAbort = () => request.finish({ status: "cancelled" });
			const request: PendingDialog = { id: crypto.randomUUID(), intent, finish(outcome) {
				if (finished) return;
				finished = true; signal.removeEventListener("abort", onAbort);
				if (pending.current === request) { pending.current = null; setDialog(null); }
				resolve(outcome);
			} };
			pending.current = request; signal.addEventListener("abort", onAbort, { once: true }); setDialog(request);
		});
	}, []);
	useEffect(() => () => pending.current?.finish({ status: "cancelled" }), []);
	const navigation = useMemo(() => ({ ...value, openView }), [value, openView]);
	return <Context.Provider value={navigation}>{children}{dialog && <ResourceDialog key={dialog.id} request={dialog} />}</Context.Provider>;
}
function ResourceDialog({ request }: { request: PendingDialog }) {
	const { intent } = request;
	const registry = useResourceRegistry(intent.cwd);
	const ref = useRef<HTMLDivElement>(null);
	const busy = useRef(false);
	const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const cancel = useCallback(() => { if (!busy.current) request.finish({ status: "cancelled" }); }, [request]);
	useEffect(() => () => clearTimeout(busyTimer.current), []);
	useDialog({ open: true, ref, onClose: cancel });
	useEffect(() => {
		if (registry.loaded && !registry.views.some((view) => view.id === intent.view.id)) request.finish({ status: "cancelled" });
	}, [registry.loaded, registry.views, intent.view.id, request]);
	return <div className="fixed inset-0 z-[125] flex items-center justify-center p-4" style={{ background: "var(--dsw-mask)" }} onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
		<div ref={ref} role="dialog" aria-modal="true" aria-label={intent.view.title} className="w-full" style={{ maxWidth: "min(92vw,640px)", maxHeight: "90vh", overflowY: "auto" }}>
			<ResourceFrame view={intent.view} cwd={intent.cwd} sessionPath={intent.sessionPath} data={intent.data}
				onAnswer={(value) => request.finish({ status: "answered", value })} onCancel={cancel}
				onBusyChange={(value) => { clearTimeout(busyTimer.current); busy.current = value; if (value) busyTimer.current = setTimeout(() => { busy.current = false; }, 30_000); }} />
		</div>
	</div>;
}
export function useResourceNavigation(): ResourceNavigation | null { return useContext(Context); }
