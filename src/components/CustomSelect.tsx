"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { IconCheckOutline14, IconChevronDown14 } from "@/components/icons";
import styles from "./CustomSelect.module.css";
import { useSelectKeyboard } from "@/hooks/useSelectKeyboard";

export interface SelectOption {
	value: string;
	label: string;
	disabled?: boolean;
}

export interface CustomSelectProps {
	value: string;
	onChange: (value: string) => void;
	options: SelectOption[];
	placeholder?: string;
	disabled?: boolean;
	size?: "sm" | "md";
	className?: string;
	style?: CSSProperties;
	"aria-label"?: string;
	"data-testid"?: string;
}

export function CustomSelect({
	value,
	onChange,
	options,
	placeholder,
	disabled = false,
	size = "md",
	className = "",
	style,
	"aria-label": ariaLabel,
	"data-testid": testId,
}: CustomSelectProps) {
	const [open, setOpen] = useState(false);
	const [flip, setFlip] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const listId = useId();
	const keyboard = useSelectKeyboard({ value, options, open, setOpen, disabled, onChange, triggerRef });

	const selectedOption = options.find((opt) => opt.value === value);

	useEffect(() => {
		if (!open) return;
		// 检查下方空间是否足够，不足则向上展开
		if (triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			const spaceBelow = window.innerHeight - rect.bottom;
			setFlip(spaceBelow < 220 && rect.top > 220);
		}

		const handlePointerDown = (e: MouseEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) {
				setOpen(false);
			}
		};

		document.addEventListener("mousedown", handlePointerDown);
		return () => {
			document.removeEventListener("mousedown", handlePointerDown);
		};
	}, [open]);

	return (
		<div ref={wrapRef} className={`${styles.wrap} ${className}`} style={style} onKeyDown={keyboard.onKeyDown}>
			{/* 原生隐藏 select：保证测试、表单无障碍与自动化脚本完全兼容 */}
			<select
				tabIndex={-1}
				value={value}
				disabled={disabled}
				aria-label={ariaLabel}
				onChange={(e) => onChange(e.target.value)}
				style={{
					position: "absolute",
					width: 1,
					height: 1,
					padding: 0,
					margin: -1,
					overflow: "hidden",
					clip: "rect(0, 0, 0, 0)",
					whiteSpace: "nowrap",
					border: 0,
					opacity: 0,
					pointerEvents: "none",
				}}
			>
				{options.map((opt) => (
					<option key={opt.value} value={opt.value} disabled={opt.disabled}>
						{opt.label}
					</option>
				))}
			</select>

			<button
				ref={triggerRef}
				type="button"
				disabled={disabled}
				data-open={open ? "true" : undefined}
				data-testid={testId}
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				className={`${styles.trigger} ${size === "sm" ? styles.sizeSm : styles.sizeMd}`}
				onClick={() => open ? keyboard.closeMenu() : keyboard.openMenu()}
			>
				<span className={styles.label}>{selectedOption?.label ?? placeholder ?? value}</span>
				<IconChevronDown14 size={size === "sm" ? 13 : 15} className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} />
			</button>

			{open && (
				<div id={listId} className={`${styles.menu} ${flip ? styles.menuFlip : ""}`} role="listbox" aria-label={ariaLabel}>
					{options.map((opt, index) => {
						const isSelected = opt.value === value;
						return (
							<button
								key={opt.value}
								ref={(element) => { keyboard.optionRefs.current[index] = element; }}
								type="button"
								role="option"
								aria-selected={isSelected}
								tabIndex={-1}
								disabled={opt.disabled}
								className={`${styles.option} ${isSelected ? styles.optionSelected : ""}`}
								onFocus={() => keyboard.setActiveIndex(index)}
								onClick={() => keyboard.choose(index)}
							>
								<span className="truncate">{opt.label}</span>
								{isSelected ? <IconCheckOutline14 size={14} className={styles.check} /> : null}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
