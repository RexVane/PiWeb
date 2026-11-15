"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown14, IconCheckOutline14 } from "@/components/icons";
import { useSelectKeyboard } from "@/hooks/useSelectKeyboard";

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
	const [rect, setRect] = useState<{ left: number; top: number; bottom: number } | null>(null);
	const anchorRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);
	const listId = useId();
	const keyboard = useSelectKeyboard({ value, options, open, setOpen, disabled, onChange, triggerRef: anchorRef });
	useEffect(() => {
		if (!open) return;
		// 弹层挂在 body（fixed 定位）：设置对话框 overflow-hidden 会裁掉 absolute 弹层
		const anchor = anchorRef.current?.getBoundingClientRect();
		if (anchor) setRect({ left: anchor.left, top: anchor.bottom + 6, bottom: anchor.top - 6 });
		const h = (e: MouseEvent) => {
			if (!anchorRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [open]);
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);
	const current = options.find((o) => o.value === value);
	// 下方放不下（按每项约 37px 估高，封顶 280）且上方更宽裕时向上翻转，并把高度限制在可用空间内。
	// 以前只把 top 钳到窗口底部上方 40px，靠近底部时只露出第一项，其余落到屏幕外
	const placement = (() => {
		if (!rect || typeof window === "undefined") return null;
		const margin = 8;
		const wanted = Math.min(280, options.length * 37 + 12);
		const below = window.innerHeight - rect.top - margin;
		const above = rect.bottom - margin;
		return below < wanted && above > below
			? { bottom: window.innerHeight - rect.bottom, maxHeight: Math.min(280, above) }
			: { top: rect.top, maxHeight: Math.min(280, Math.max(below, 80)) };
	})();
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
			{open && !disabled && rect && placement && createPortal(
				<div
					id={listId}
					ref={popRef}
					role="listbox"
					data-dialog-owner={anchorRef.current?.closest<HTMLElement>("[data-dialog-root]")?.dataset.dialogRoot}
					className="popover fixed z-[130] p-1.5 shadow-xl"
					data-placement={"bottom" in placement ? "top" : "bottom"}
					// 左右都对齐 chip 左缘
					style={{ left: rect.left, ...placement, minWidth: width ?? 140, width: "max-content", overflowY: "auto" }}
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
