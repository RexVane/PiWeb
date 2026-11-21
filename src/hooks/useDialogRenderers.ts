"use client";
import { useState } from "react";
import type { ExtensionDialog } from "@/hooks/usePiWeb";
import type { ResourcePreferences, WebResourceView } from "@/lib/resources/protocol";

export interface DialogRendererRegistry {
	views: readonly WebResourceView[];
	preferences: Pick<ResourcePreferences, "renderers">;
	loaded: boolean;
	error: string;
	registryCwd: string;
}

type DialogPlacement = "dialog" | "aboveEditor" | "belowEditor";
interface RendererChoice {
	signature: string;
	ready: boolean;
	renderer?: WebResourceView;
	placement: DialogPlacement;
}
interface RendererState {
	context: string;
	choices: ReadonlyMap<string, RendererChoice>;
	embeddedId: string | null;
	modalId: string | null;
}
export interface RenderedExtensionDialog {
	dialog: ExtensionDialog;
	renderer?: WebResourceView;
	placement: DialogPlacement;
}

function signatureOf(dialog: ExtensionDialog): string {
	return JSON.stringify([dialog.method, dialog.resourceView?.id, dialog.resourceView?.resourceId, dialog.resourceView?.scope]);
}
function supports(view: WebResourceView, method: ExtensionDialog["method"]): boolean {
	return typeof view.id === "string" && view.id.length > 0
		&& (method === "resource" || Array.isArray(view.methods) && view.methods.includes(method));
}
function isAvailable(view: WebResourceView, dialog: ExtensionDialog, registry: DialogRendererRegistry): boolean {
	return registry.views.some((candidate) => candidate.id === view.id && candidate.resourceId === view.resourceId
		&& candidate.scope === view.scope && supports(candidate, dialog.method));
}
function basic(signature: string): RendererChoice {
	return { signature, ready: true, placement: "dialog" };
}
function choiceFor(dialog: ExtensionDialog, registry: DialogRendererRegistry, cwd: string): RendererChoice {
	const signature = signatureOf(dialog);
	const current = registry.registryCwd === cwd && registry.loaded;
	const authoritative = current && !registry.error;
	const explicit = dialog.resourceView;
	if (explicit) {
		// A resource request carries its own view, including its placement, before polling finishes.
		if (!supports(explicit, dialog.method) || (authoritative && !isAvailable(explicit, dialog, registry))) return basic(signature);
		return { signature, ready: true, renderer: explicit, placement: placementOf(explicit) };
	}
	if (dialog.method === "resource") return basic(signature);
	// Do not mount a basic dialog only to move this same request when preferences arrive.
	if (!current) return { signature, ready: false, placement: "dialog" };
	if (!authoritative) return basic(signature);
	const preferred = registry.preferences.renderers[dialog.method];
	const renderer = registry.views.find((view) => view.id === preferred && supports(view, dialog.method));
	return renderer ? { signature, ready: true, renderer, placement: placementOf(renderer) } : basic(signature);
}
function placementOf(view: WebResourceView): DialogPlacement {
	return view.placement === "aboveEditor" || view.placement === "belowEditor" ? view.placement : "dialog";
}

function advance(state: RendererState, context: string, dialogs: readonly ExtensionDialog[], registry: DialogRendererRegistry, cwd: string): RendererState {
	const previous = state.context === context ? state : { context, choices: new Map<string, RendererChoice>(), embeddedId: null, modalId: null };
	const choices = new Map<string, RendererChoice>();
	let changed = previous !== state || previous.choices.size !== dialogs.length;
	const authoritative = registry.registryCwd === cwd && registry.loaded && !registry.error;
	for (const dialog of dialogs) {
		const existing = previous.choices.get(dialog.id);
		let choice = existing;
		if (!choice || choice.signature !== signatureOf(dialog) || (!choice.ready && registry.registryCwd === cwd && registry.loaded)) choice = choiceFor(dialog, registry, cwd);
		else if (choice.renderer && authoritative && !isAvailable(choice.renderer, dialog, registry)) {
			// Successful discovery may revoke a disabled/uninstalled renderer. Poll failures cannot.
			choice = basic(choice.signature);
		}
		choices.set(dialog.id, choice);
		if (choice !== existing) changed = true;
	}
	const inSlot = (id: string | null, embedded: boolean) => {
		const choice = id ? choices.get(id) : undefined;
		return choice?.ready && (choice.placement !== "dialog") === embedded;
	};
	// Keep visible requests in their slots; newly ready or reordered requests must not preempt them.
	const embeddedId = inSlot(previous.embeddedId, true) ? previous.embeddedId : dialogs.find((dialog) => inSlot(dialog.id, true))?.id ?? null;
	const modalId = inSlot(previous.modalId, false) ? previous.modalId : dialogs.find((dialog) => inSlot(dialog.id, false))?.id ?? null;
	if (embeddedId !== previous.embeddedId || modalId !== previous.modalId) changed = true;
	return changed ? { context, choices, embeddedId, modalId } : state;
}

/** Select once per request; only an authoritative resource removal can revoke a fixed renderer. */
export function useDialogRenderers(dialogs: readonly ExtensionDialog[], registry: DialogRendererRegistry, cwd: string, sessionPath: string | null) {
	const context = `${cwd}\0${sessionPath ?? ""}`;
	const [state, setState] = useState<RendererState>(() => advance({ context, choices: new Map(), embeddedId: null, modalId: null }, context, dialogs, registry, cwd));
	const next = advance(state, context, dialogs, registry, cwd);
	if (next !== state) setState(next);
	const rendered = (id: string | null): RenderedExtensionDialog | null => {
		const dialog = dialogs.find((item) => item.id === id);
		const choice = id ? next.choices.get(id) : undefined;
		if (!dialog || !choice?.ready) return null;
		// ExtensionDialogHost also reads dialog.resourceView; never let it bypass validation or a pin.
		return { dialog: dialog.resourceView !== choice.renderer ? { ...dialog, resourceView: choice.renderer } : dialog, renderer: choice.renderer, placement: choice.placement };
	};
	return { embedded: rendered(next.embeddedId), modal: rendered(next.modalId) };
}
