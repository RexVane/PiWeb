"use client";

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from "react";

/** Shared single-select navigation; focus moves to an enabled candidate without committing the value. */
export function useSelectKeyboard({ value, options, open, setOpen, disabled, onChange, triggerRef }: {
	value: string;
	options: { value: string; label: string; disabled?: boolean }[];
	open: boolean;
	setOpen: Dispatch<SetStateAction<boolean>>;
	disabled?: boolean;
	onChange: (value: string) => void;
	triggerRef: RefObject<HTMLButtonElement | null>;
}) {
	const [activeIndex, setActiveIndex] = useState(-1);
	const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
	const closeMenu = () => { setOpen(false); triggerRef.current?.focus(); };
	const openMenu = (edge?: "first" | "last") => {
		if (disabled || !enabled.length) return;
		const selected = options.findIndex((option) => option.value === value && !option.disabled);
		setActiveIndex(edge === "first" ? enabled[0] : edge === "last" ? enabled.at(-1)! : selected < 0 ? enabled[0] : selected);
		setOpen(true);
	};
	useEffect(() => { if (disabled) setOpen(false); }, [disabled, setOpen]);
	useLayoutEffect(() => {
		if (!open) return;
		const option = optionRefs.current[activeIndex];
		if (!option || option.disabled) return;
		if (document.activeElement !== option) option.focus({ preventScroll: true });
		// Scroll only the popup: scrollIntoView can also move the dialog or the page.
		const menu = option.closest<HTMLElement>('[role="listbox"]');
		if (!menu || menu.clientHeight === 0) return;
		const visibleTop = menu.getBoundingClientRect().top + menu.clientTop;
		const visibleBottom = visibleTop + menu.clientHeight;
		const rect = option.getBoundingClientRect();
		if (rect.top < visibleTop) menu.scrollTop += rect.top - visibleTop;
		else if (rect.bottom > visibleBottom) menu.scrollTop += rect.bottom - visibleBottom;
	});
	const choose = (index: number) => {
		if (!options[index] || options[index].disabled) return;
		onChange(options[index].value);
		closeMenu();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (disabled || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
		if (event.key === "Escape" && open) {
			event.preventDefault();
			event.stopPropagation();
			closeMenu();
		} else if (event.key === "Tab" && open) {
			// Let native Tab move onward from the trigger after the popup disappears.
			closeMenu();
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			if (!open) openMenu();
			else if (enabled.length) {
				const current = enabled.indexOf(activeIndex);
				setActiveIndex(enabled[(current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]);
			}
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			event.stopPropagation();
			openMenu(event.key === "Home" ? "first" : "last");
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			if (open) choose(activeIndex);
			else openMenu();
		}
	};
	return { activeIndex, setActiveIndex, optionRefs, openMenu, closeMenu, choose, onKeyDown };
}
