"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheckOutline14, IconChevronDown14 } from "@/components/icons";
import { useSelectKeyboard } from "@/hooks/useSelectKeyboard";
import { useI18n } from "@/i18n";
import type { ToolPreset } from "@/lib/types";
import styles from "./PermissionSelector.module.css";

export type PermissionChangeResult = { success: boolean; error?: string };

function PermissionShield({ size = 14 }: { size?: number }) {
	return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
		<path d="M8 1.5 13 3.4v3.8c0 3-1.9 5.5-5 7.1-3.1-1.6-5-4.1-5-7.1V3.4L8 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
	</svg>;
}

/** Chooses the server's actual tool preset; it is not an operation approval or sandbox setting. */
export function PermissionSelector({ value, custom, disabled, disabledReason, saving, onChange }: {
	value: ToolPreset;
	custom?: boolean;
	disabled?: boolean;
	disabledReason?: string;
	saving?: boolean;
	onChange: (value: ToolPreset) => Promise<PermissionChangeResult>;
}) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const [error, setError] = useState("");
	const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const mounted = useRef(true);
	const menuId = useId();
	const options = [
		{ value: "readonly", label: t.permissionReadonly, description: t.permissionReadonlyDesc },
		{ value: "standard", label: t.permissionStandard, description: t.permissionStandardDesc },
		{ value: "full", label: t.permissionFull, description: t.permissionFullDesc },
	];
	const selected = options.find((option) => option.value === value)!;
	const label = custom ? t.permissionCustom : selected.label;
	const change = async (preset: string) => {
		setError("");
		try {
			const result = await onChange(preset as ToolPreset);
			if (mounted.current && !result.success && result.error !== "session changed") setError(result.error || t.permissionSaveFailed);
		} catch (failure) {
			if (mounted.current) setError(failure instanceof Error ? failure.message : t.permissionSaveFailed);
		}
	};
	const keyboard = useSelectKeyboard({ value: custom ? "custom" : value, options, open, setOpen, disabled: disabled || saving, onChange: (preset) => void change(preset), triggerRef });
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	useEffect(() => { setError(""); }, [value, custom]);
	useEffect(() => {
		if (!open) return;
		const updatePosition = () => {
			const rect = triggerRef.current?.getBoundingClientRect();
			if (!rect) return;
			const viewport = window.visualViewport;
			const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
			const topEdge = (viewport?.offsetTop ?? 0) + 8;
			const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16;
			const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
			const width = Math.max(0, Math.min(360, rightEdge - leftEdge));
			const above = rect.top - topEdge - 8;
			const below = bottomEdge - rect.bottom - 8;
			const placeAbove = above >= 240 || above >= below;
			const maxHeight = Math.max(80, placeAbove ? above : below);
			const height = Math.min((menuRef.current?.scrollHeight ?? 260) + 2, maxHeight);
			setPosition({ left: Math.max(leftEdge, Math.min(rect.left, rightEdge - width)), top: placeAbove ? Math.max(topEdge, rect.top - 8 - height) : rect.bottom + 8, width, maxHeight });
		};
		updatePosition();
		const clickOutside = (event: PointerEvent) => {
			if (!triggerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
		};
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		window.visualViewport?.addEventListener("resize", updatePosition);
		window.visualViewport?.addEventListener("scroll", updatePosition);
		document.addEventListener("pointerdown", clickOutside);
		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
			window.visualViewport?.removeEventListener("resize", updatePosition);
			window.visualViewport?.removeEventListener("scroll", updatePosition);
			document.removeEventListener("pointerdown", clickOutside);
		};
	}, [open, custom]);

	return <>
		<button ref={triggerRef} type="button" className={styles.trigger} data-level={custom ? "custom" : value}
			aria-label={`${t.permissionLabel}: ${label}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined}
			disabled={disabled || saving} title={saving ? t.permissionSaving : disabledReason || selected.description}
			onClick={() => open ? keyboard.closeMenu() : keyboard.openMenu()} onKeyDown={keyboard.onKeyDown} data-testid="permission-trigger">
			<PermissionShield /><span>{saving ? t.permissionSaving : label}</span><IconChevronDown14 size={11} />
		</button>
		{error && <span role="alert" className={styles.error}>{error}</span>}
		{open && createPortal(<div ref={menuRef} className={styles.menu} onKeyDown={keyboard.onKeyDown}
			style={position ? position : { visibility: "hidden" }}>
			{custom && <div className={styles.hint}>{t.permissionCustomHint}</div>}
			<div id={menuId} role="listbox" aria-label={t.permissionLabel}>
				{options.map((option, index) => <button key={option.value} ref={(element) => { keyboard.optionRefs.current[index] = element; }}
					type="button" role="option" aria-selected={!custom && option.value === value} tabIndex={-1}
					className={styles.option} data-level={option.value} onFocus={() => keyboard.setActiveIndex(index)} onClick={() => keyboard.choose(index)}>
					<PermissionShield size={16} />
					<span className={styles.copy}><span className={styles.label}>{option.label}</span><span className={styles.description}>{option.description}</span></span>
					{!custom && option.value === value && <IconCheckOutline14 size={15} />}
				</button>)}
			</div>
		</div>, document.body)}
	</>;
}
