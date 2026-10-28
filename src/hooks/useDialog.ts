"use client";

import { useEffect, useRef, type RefObject } from "react";

interface DialogEntry {
	root: HTMLElement;
	close: () => void;
	lastFocus: HTMLElement | null;
	owner: string;
}

const dialogs: DialogEntry[] = [];
let nextOwner = 0;
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

function scopes(entry: DialogEntry): HTMLElement[] {
	return [entry.root, ...[...document.querySelectorAll<HTMLElement>("[data-dialog-owner]")].filter((element) => element.dataset.dialogOwner === entry.owner)];
}

function contains(entry: DialogEntry, target: Node | null): boolean {
	return target !== null && scopes(entry).some((scope) => scope.contains(target));
}

function focusable(entry: DialogEntry): HTMLElement[] {
	return scopes(entry).flatMap((scope) => [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)]).filter((element) => {
		if (element.tabIndex < 0 || element.matches(":disabled") || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
		for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
			const style = window.getComputedStyle(parent);
			if (style.display === "none" || style.visibility === "hidden") return false;
		}
		return true;
	});
}

function focusInside(entry: DialogEntry): void {
	const remembered = entry.lastFocus;
	const target = remembered?.isConnected && contains(entry, remembered) ? remembered : focusable(entry)[0] ?? entry.root;
	target.focus({ preventScroll: true });
}

function onFocus(event: FocusEvent): void {
	const top = dialogs.at(-1);
	if (!top) return;
	if (contains(top, event.target as Node)) top.lastFocus = event.target as HTMLElement;
	else focusInside(top);
}

function onKeyDown(event: KeyboardEvent): void {
	const top = dialogs.at(-1);
	if (!top || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopImmediatePropagation();
		top.close();
		return;
	}
	if (event.key !== "Tab") return;
	const items = focusable(top);
	const active = document.activeElement;
	const index = items.indexOf(active as HTMLElement);
	if (!items.length) {
		event.preventDefault();
		top.root.focus({ preventScroll: true });
	} else if (index === -1 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
		event.preventDefault();
		(event.shiftKey ? items.at(-1)! : items[0]).focus({ preventScroll: true });
	}
}

/** One modal stack owns Escape and focus. Popovers can identify their portal with data-dialog-owner. */
export function useDialog({ open, onClose, ref }: { open: boolean; onClose: () => void; ref: RefObject<HTMLElement | null> }): void {
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const wasOpen = useRef(false);
	const returnFocus = useRef<HTMLElement | null>(null);
	if (open && !wasOpen.current && typeof document !== "undefined") returnFocus.current = document.activeElement as HTMLElement | null;
	wasOpen.current = open;
	useEffect(() => {
		const root = ref.current;
		if (!open || !root) return;
		const owner = `dialog-${++nextOwner}`;
		const oldOwner = root.getAttribute("data-dialog-root");
		const oldTabIndex = root.getAttribute("tabindex");
		root.dataset.dialogRoot = owner;
		if (oldTabIndex === null) root.tabIndex = -1;
		const entry: DialogEntry = { root, close: () => closeRef.current(), lastFocus: null, owner };
		// Effects in a child run before its parent; keep a nested modal above its parent either way.
		const childIndex = dialogs.findIndex((dialog) => root.contains(dialog.root));
		if (childIndex < 0) dialogs.push(entry);
		else dialogs.splice(childIndex, 0, entry);
		if (dialogs.length === 1) {
			document.addEventListener("keydown", onKeyDown);
			document.addEventListener("focusin", onFocus);
		}
		if (dialogs.at(-1) === entry) {
			if (contains(entry, document.activeElement)) entry.lastFocus = document.activeElement as HTMLElement;
			else focusInside(entry);
		}
		return () => {
			const wasTop = dialogs.at(-1) === entry;
			const index = dialogs.indexOf(entry);
			if (index >= 0) dialogs.splice(index, 1);
			if (oldOwner === null) delete root.dataset.dialogRoot;
			else root.setAttribute("data-dialog-root", oldOwner);
			if (oldTabIndex === null) root.removeAttribute("tabindex");
			if (!dialogs.length) {
				document.removeEventListener("keydown", onKeyDown);
				document.removeEventListener("focusin", onFocus);
			}
			if (wasTop) {
				const previous = returnFocus.current;
				const top = dialogs.at(-1);
				if (previous?.isConnected && (!top || contains(top, previous))) previous.focus({ preventScroll: true });
				else if (top) focusInside(top);
			}
		};
	}, [open, ref]);
}
