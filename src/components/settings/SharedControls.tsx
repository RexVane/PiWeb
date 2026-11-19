"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown14, IconCheckOutline14 } from "@/components/icons";
import { useSelectKeyboard } from "@/hooks/useSelectKeyboard";

const SELECT_OPEN_EVENT = "piweb:settings-select-open";
interface SelectPosition {
	left: number;
	top?: number;
	bottom?: number;
	maxHeight: number;
	minWidth: number;
	maxWidth: number;
}

/** 通用下选芯片：自定义深色圆角浮层，替代原生 select */
export function SelectOption({
	value,
	label,
	options,
	onChange,
	width,
	disabled,
}: {
	value: string;
	label?: string;
	options: { value: string; label: string; disabled?: boolean; dotColor?: string }[];
	onChange: (v: string) => void;
	width?: number;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<SelectPosition | null>(null);
	const anchorRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);
	const listId = useId();
	// 点击和键盘共用同一条打开路径；关闭旧菜单不抢回焦点。
	const setMenuOpen = useCallback<typeof setOpen>((next) => {
		if (next === true) document.dispatchEvent(new CustomEvent(SELECT_OPEN_EVENT, { detail: listId }));
		setOpen(next);
	}, [listId]);
	const keyboard = useSelectKeyboard({ value, options, open, setOpen: setMenuOpen, disabled, onChange, triggerRef: anchorRef });
	useEffect(() => {
		const closeOther = (event: Event) => {
			if ((event as CustomEvent<string>).detail !== listId) setOpen(false);
		};
		document.addEventListener(SELECT_OPEN_EVENT, closeOther);
		return () => document.removeEventListener(SELECT_OPEN_EVENT, closeOther);
	}, [listId]);

	const measure = useCallback(() => {
		const anchor = anchorRef.current?.getBoundingClientRect();
		if (!anchor) return;
		const viewport = window.visualViewport;
		const margin = 8;
		const viewportTop = (viewport?.offsetTop ?? 0) + margin;
		const viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - margin;
		const viewportLeft = (viewport?.offsetLeft ?? 0) + margin;
		const viewportRight = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - margin;
		const maxWidth = Math.max(0, viewportRight - viewportLeft);
		const minWidth = Math.min(width ?? 140, maxWidth);
		// offsetWidth 不受入场动画 scale 影响；初次渲染后、内容尺寸改变时再测真实宽度。
		const menuWidth = Math.min(popRef.current?.offsetWidth || minWidth, maxWidth);
		const wanted = Math.min(280, popRef.current?.scrollHeight || options.length * 37 + 14);
		const top = Math.max(viewportTop, Math.min(anchor.bottom + 6, viewportBottom));
		const aboveEnd = Math.max(viewportTop, Math.min(anchor.top - 6, viewportBottom));
		const below = Math.max(0, viewportBottom - top);
		const above = Math.max(0, aboveEnd - viewportTop);
		const placement = below < wanted && above > below
			? { bottom: window.innerHeight - aboveEnd, maxHeight: Math.min(280, above) }
			: { top, maxHeight: Math.min(280, below) };
		const next = { left: Math.max(viewportLeft, Math.min(anchor.left, viewportRight - menuWidth)), ...placement, minWidth, maxWidth };
		setPosition((current) => current && current.left === next.left && current.top === next.top && current.bottom === next.bottom
			&& current.maxHeight === next.maxHeight && current.minWidth === minWidth && current.maxWidth === maxWidth ? current : next);
	}, [options.length, width]);
	// 浮层挂 body，不能用 absolute；初次挂载后补测实际宽度，避免长选项越出右侧。
	useLayoutEffect(() => { if (open) measure(); });
	const positioned = position !== null;
	useLayoutEffect(() => {
		if (!open) return;
		const outside = (event: Event) => {
			if (!anchorRef.current?.contains(event.target as Node) && !popRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const scroll = (event: Event) => {
			if (event.target instanceof Node && popRef.current?.contains(event.target)) return;
			measure();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("mousedown", outside);
		window.addEventListener("scroll", scroll, true); // 捕获设置面板的非冒泡 scroll
		window.addEventListener("resize", measure);
		window.visualViewport?.addEventListener("resize", measure);
		window.visualViewport?.addEventListener("scroll", measure);
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
		if (anchorRef.current) observer?.observe(anchorRef.current);
		if (popRef.current) observer?.observe(popRef.current);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("mousedown", outside);
			window.removeEventListener("scroll", scroll, true);
			window.removeEventListener("resize", measure);
			window.visualViewport?.removeEventListener("resize", measure);
			window.visualViewport?.removeEventListener("scroll", measure);
			observer?.disconnect();
		};
	}, [open, measure, positioned]);
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);
	const current = options.find((o) => o.value === value);
	return (
		<div className="relative" onKeyDown={keyboard.onKeyDown}>
			<button ref={anchorRef} type="button" className="select-chip" data-open={open} disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => open ? keyboard.closeMenu() : keyboard.openMenu()}>
				<span className="flex items-center gap-2">
					{current?.dotColor && <span className="inline-block flex-none rounded-full" aria-hidden="true" style={{ width: 8, height: 8, background: current.dotColor }} />}
					<span>{current?.label ?? value}</span>
				</span>
				<span className="chevron">
					<IconChevronDown14 size={14} />
				</span>
			</button>
			{open && !disabled && position && createPortal(
				<div
					id={listId}
					ref={popRef}
					role="listbox"
					data-dialog-owner={anchorRef.current?.closest<HTMLElement>("[data-dialog-root]")?.dataset.dialogRoot}
					className="popover pw-select-popover fixed z-[130] p-1.5 shadow-xl"
					data-placement={position.bottom !== undefined ? "top" : "bottom"}
					style={{ ...position, width: "max-content", boxSizing: "border-box", overflowY: "auto" }}
				>
					{options.map((o, index) => {
						const selected = o.value === value;
						return (
							<button
								key={o.value}
								ref={(element) => { keyboard.optionRefs.current[index] = element; }}
								type="button"
								role="option"
								aria-selected={selected}
								disabled={o.disabled}
								tabIndex={-1}
								className="flex w-full items-center justify-between gap-3 rounded-lg px-3.5 py-2 text-left transition-colors"
								style={{
									padding: "8px 14px",
									background: keyboard.activeIndex === index ? "var(--dsw-hover)" : selected ? "var(--dsw-accent-soft)" : "transparent",
								}}
								onMouseEnter={(e) => {
									if (!selected) e.currentTarget.style.background = "var(--dsw-hover)";
								}}
								onMouseLeave={(e) => {
									if (!selected) e.currentTarget.style.background = "transparent";
								}}
								onFocus={() => keyboard.setActiveIndex(index)}
								onClick={() => keyboard.choose(index)}
							>
								<span className="flex items-center gap-2" style={{ fontSize: "var(--dsh-ui-font-135)", color: selected ? "var(--dsw-accent)" : "var(--dsw-label-primary)", whiteSpace: "nowrap" }}>
									{o.dotColor && (
										<span
											className="inline-block flex-none rounded-full"
											aria-hidden="true"
											style={{ width: 8, height: 8, background: o.dotColor }}
										/>
									)}
									{o.label}
								</span>
								{selected && (
									<span style={{ display: "inline-flex", color: "var(--dsw-accent)", flex: "none" }}>
										<IconCheckOutline14 size={14} />
									</span>
								)}
							</button>
						);
					})}
				</div>,
				document.body,
			)}
		</div>
	);
}

export function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
	return (
		<div className="hairline-b flex items-center justify-between gap-6 pb-5">
			<div className="min-w-0">
				<div style={{ fontSize: "var(--dsh-content-font-size)", fontWeight: 400 }}>{title}</div>
				{desc && (
					<div className="mt-0.5" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)" }}>
						{desc}
					</div>
				)}
			</div>
			<div className="flex-none">{children}</div>
		</div>
	);
}

/** 标题在上、内容整行在下（dsh 外观三卡的排布） */
export function RowColumn({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
	return (
		<div className="hairline-b flex flex-col gap-3 pb-5">
			<div>
				<div style={{ fontSize: "var(--dsh-content-font-size)", fontWeight: 400 }}>{title}</div>
				{desc && (
					<div className="mt-0.5" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)" }}>
						{desc}
					</div>
				)}
			</div>
			{children}
		</div>
	);
}

/** 字号步进器：− 值 ＋（越界禁用；点中间数值回到 14 默认） */
export function FontSizeStepper({ value, onChange, max }: { value: number; onChange: (v: number) => void; max: number }) {
	return (
		<div className="flex items-center gap-2">
			<button
				className="icon-btn"
				style={{ width: 26, height: 26, border: "0.5px solid var(--dsw-border-l3)", borderRadius: 8 }}
				disabled={value <= 12}
				onClick={() => onChange(value - 1)}
				aria-label="decrease font size"
			>
				−
			</button>
			<button
				style={{ minWidth: 48, textAlign: "center", fontSize: "var(--dsh-ui-font-sm)", color: value === 14 ? "var(--dsw-label-tertiary)" : "var(--dsw-label-primary)" }}
				title="reset"
				onClick={() => onChange(14)}
			>
				{value} px
			</button>
			<button
				className="icon-btn"
				style={{ width: 26, height: 26, border: "0.5px solid var(--dsw-border-l3)", borderRadius: 8 }}
				disabled={value >= max}
				onClick={() => onChange(value + 1)}
				aria-label="increase font size"
			>
				＋
			</button>
		</div>
	);
}

export const fieldCls = "w-full rounded-xl px-3 py-2";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="mb-1" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)" }}>
				{label}
			</div>
			{children}
		</div>
	);
}

/** 作用域筛选（全部 / 个人 / 项目…）与右侧可选的工作区切换共用同一行，避免「项目」页签多占一行 */
export function ScopeWorkspaceFilterBar<T extends string>({
	tabs,
	activeTab,
	onTabChange,
	ariaLabel,
	workspace,
}: {
	tabs: readonly { id: T; label: string; count: number }[];
	activeTab: T;
	onTabChange: (id: T) => void;
	ariaLabel: string;
	workspace?: {
		visible: boolean;
		cwd: string;
		label: string;
		options?: { value: string; label: string }[];
		onChange?: (cwd: string) => void;
	};
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={ariaLabel}>
				{tabs.map((tab) => {
					const active = activeTab === tab.id;
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={active}
							onClick={() => onTabChange(tab.id)}
							className="rounded-lg transition-colors"
							style={{
								padding: "6px 12px",
								fontSize: "var(--dsh-ui-font-sm)",
								fontWeight: active ? 500 : 400,
								background: active ? "var(--dsw-active)" : "transparent",
								color: active ? "var(--dsw-label-primary)" : "var(--dsw-label-tertiary)",
							}}
						>
							<span>{tab.label}</span>
							<span className="ml-1.5 tabular-nums opacity-70" style={{ fontSize: "max(9.5px, calc(11.5px + var(--dsh-content-font-delta)))" }}>
								{tab.count}
							</span>
						</button>
					);
				})}
			</div>

			{workspace?.visible && workspace.options && workspace.options.length > 0 && workspace.onChange && (
				<div className="ml-auto flex items-center gap-2">
					<span style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)" }}>{workspace.label}</span>
					<SelectOption
						value={workspace.cwd}
						label={workspace.label}
						options={workspace.options}
						onChange={workspace.onChange}
						width={200}
					/>
				</div>
			)}
		</div>
	);
}
