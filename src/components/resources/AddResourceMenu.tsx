"use client";
import { useEffect, useId, useRef, useState } from "react";
import { IconChevronDown14 } from "@/components/icons";
import { useResourceText } from "./text";

export function AddResourceMenu({ label, onInstall, onDesign, disabled = false }: {
	label: string; onInstall: () => void; onDesign: () => void; disabled?: boolean;
}) {
	const text = useResourceText();
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const items = useRef<Array<HTMLButtonElement | null>>([]);
	const id = useId();
	useEffect(() => {
		if (!open) return;
		items.current[0]?.focus();
		const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false); };
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [open]);
	const select = (operation: () => void) => { setOpen(false); button.current?.focus(); operation(); };
	return <div ref={anchor} className="relative" onKeyDown={(event) => {
		if (event.key === "Escape") { setOpen(false); button.current?.focus(); event.stopPropagation(); }
		if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			const current = items.current.findIndex((element) => element === document.activeElement);
			items.current[(current + (event.key === "ArrowDown" ? 1 : 1)) % 2]?.focus();
		}
	}}>
		<button ref={button} type="button" className="btn-primary-white" style={{ height: 32, padding: "0 14px", fontSize: 13 }}
			disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
			+ {label} <IconChevronDown14 size={13} />
		</button>
		{open && <div id={id} role="menu" className="popover absolute right-0 z-[110] mt-2 flex flex-col gap-1 p-1.5" style={{ width: "min(310px,85vw)" }}>
			{[{ title: text.installExisting, hint: text.installHint, action: onInstall }, { title: text.design, hint: text.designHint, action: onDesign }].map((item, index) =>
				<button key={item.title} ref={(element) => { items.current[index] = element; }} role="menuitem" type="button" className="rounded-lg p-3 text-left hover:bg-[var(--dsw-hover)]" onClick={() => select(item.action)}>
					<span className="block" style={{ fontSize: 13 }}>{item.title}</span>
					<span className="mt-1 block" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{item.hint}</span>
				</button>)}
		</div>}
	</div>;
}
