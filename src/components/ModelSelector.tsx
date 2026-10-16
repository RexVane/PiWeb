"use client";

/**
 * 模型选择菜单：打开即显示 Provider 分组模型列表；思考级别保留为独立子页。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconCheckOutline14, IconChevronDown14, IconChevronLeft14, IconChevronRight14 } from "@/components/icons";
import { useI18n } from "@/i18n";

export interface ModelChoice {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevels?: string[];
	contextWindow: number;
}

export function ModelSelector({
	model,
	thinkingLevel,
	thinkingLevels,
	models,
	providerNames,
	authByProvider,
	onSelectModel,
	onSelectLevel,
	open: openProp,
	onOpenChange,
	modelOnly = false,
	disabled = false,
	defaultOption,
}: {
	model?: { provider: string; id: string; name: string };
	thinkingLevel?: string;
	thinkingLevels: string[];
	models: ModelChoice[];
	providerNames: Record<string, string>;
	authByProvider: Record<string, boolean>;
	onSelectModel: (provider: string, id: string) => void;
	onSelectLevel: (level: string) => void;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** Compact consumers can show just the model list. */
	modelOnly?: boolean;
	disabled?: boolean;
	defaultOption?: { label: string; selected: boolean; onSelect: () => void };
}) {
	const [openState, setOpenState] = useState(false);
	const open = openProp ?? openState;
	const setOpen = (v: boolean) => {
		setOpenState(v);
		onOpenChange?.(v);
	};
	const [pane, setPane] = useState<"model" | "effort">("model");
	const ref = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const { t } = useI18n();

	useEffect(() => {
		if (!open) {
			setPane("model");
			return;
		}
		const onPointerDown = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (pane === "effort") setPane("model");
			else setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, pane]);

	const groups = useMemo(() => {
		const byProvider = new Map<string, ModelChoice[]>();
		for (const m of models) {
			if (authByProvider[m.provider] === false) continue;
			if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
			byProvider.get(m.provider)!.push(m);
		}
		const out = [...byProvider.entries()].map(([provider, list]) => ({
			provider,
			label: providerNames[provider] ?? provider,
			models: [...list].sort((a, b) => a.name.localeCompare(b.name)),
		}));
		out.sort((a, b) => a.label.localeCompare(b.label));
		if (model) {
			const idx = out.findIndex((g) => g.provider === model.provider);
			if (idx > 0) {
				const [g] = out.splice(idx, 1);
				out.unshift(g);
			}
		}
		return out;
	}, [models, providerNames, authByProvider, model]);

	// 进入模型列表时滚动到选中项
	useEffect(() => {
		if (!open || pane !== "model") return;
		requestAnimationFrame(() => {
			listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "center" });
		});
	}, [open, pane]);

	const hasModel = Boolean(model?.id);
	const modelName = hasModel ? (model?.name || model?.id || "") : "";
	const effortLabel = !modelOnly && hasModel && thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : undefined;
	const triggerTitle = (defaultOption?.selected ? `${defaultOption.label} · ` : "") + (hasModel
		? `${providerNames[model?.provider ?? ""] ?? model?.provider}/${modelName}${effortLabel ? ` · ${effortLabel}` : ""}`
		: t.selectModel);

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				className="chip"
				data-open={open}
				title={triggerTitle}
				aria-label={triggerTitle}
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => {
					setOpen(!open);
					setPane("model");
				}}
			>
				<span className="max-w-[220px] truncate" suppressHydrationWarning>{hasModel ? modelName : t.selectModel}</span>
				{effortLabel && (
					<span style={{ color: "var(--dsw-label-caption)", flex: "none", fontSize: 13 }}>
						{effortLabel}
					</span>
				)}
				<span className="chevron">
					<IconChevronDown14 size={14} />
				</span>
			</button>

			{open && (
				<div
					className="popover absolute bottom-10 right-0 z-50 flex w-[312px] max-w-[calc(100vw-24px)] flex-col"
					role="menu"
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						event.preventDefault();
						if (pane === "effort") setPane("model");
						else setOpen(false);
					}}
				>
					{pane === "effort" && (
						<div className="py-1">
							<button
								type="button"
								className="isx-menu-item flex w-full items-center gap-2 px-3 py-2 text-left"
								style={{ color: "var(--dsw-label-secondary)" }}
								onClick={() => setPane("model")}
							>
								<IconChevronLeft14 size={14} /> <span className="isx-menu-shift">{t.thinking}</span>
							</button>
							{thinkingLevels.length === 0 && (
								<div className="px-4 py-3" style={{ fontSize: 13, color: "var(--dsw-label-caption)" }}>
									{t.emptyEfforts}
								</div>
							)}
							{thinkingLevels.map((lv) => {
								const selected = thinkingLevel === lv;
								return (
									<button
										key={lv}
										type="button"
										role="menuitemradio"
										aria-checked={selected}
										data-active={selected ? "true" : undefined}
										className="isx-menu-item flex w-full items-center justify-between px-4 py-2 text-left"
										onClick={() => {
											onSelectLevel(lv);
											setOpen(false);
										}}
									>
										<span className="isx-menu-shift" style={{ fontSize: 14 }}>{lv}</span>
										{selected && (
											<span className="pr-2" style={{ display: "inline-flex" }}>
												<IconCheckOutline14 size={14} />
											</span>
										)}
									</button>
								);
							})}
						</div>
					)}

					{pane === "model" && (
						<div className="flex min-h-0 flex-col">
							{/* overflow-y-auto 会把 overflow-x 一并提升成 auto：Iconsax 悬停位移（.isx-menu-shift
							    translateX(4px)）加上全局 10px 高的横向滚动条，会在列表底部露出一条横杠。
							   显式锁掉横向，去掉那条横条。 */}
							<div ref={listRef} className="max-h-[340px] overflow-x-hidden overflow-y-auto py-1">
								{defaultOption && (
									<button
										type="button"
										role="menuitemradio"
										aria-checked={defaultOption.selected}
										data-selected={defaultOption.selected}
										data-active={defaultOption.selected ? "true" : undefined}
										className="isx-menu-item flex min-h-10 w-full items-center justify-between gap-3 rounded-[12px] px-3 py-2 text-left"
										style={{ fontSize: 13 }}
										onClick={() => { defaultOption.onSelect(); setOpen(false); }}
									>
										<span className="isx-menu-shift">{defaultOption.label}</span>
										{defaultOption.selected && <span className="pr-2" style={{ display: "inline-flex" }}><IconCheckOutline14 size={14} /></span>}
									</button>
								)}
								{groups.length === 0 && (
									<div className="px-3 py-3" style={{ fontSize: 13, color: "var(--dsw-label-caption)" }}>
										{t.emptyModels}
									</div>
								)}
								{groups.map((g) => (
									<section key={g.provider} role="group" aria-label={g.label}>
										{/* 提供商名不吸顶：吸顶会在滚动时钉住并被下一组顶出成半截文字（"卡住"观感） */}
										<div
											className="px-3 pb-1 pt-2"
											style={{ fontSize: 12, fontWeight: 500, color: "var(--dsw-label-caption)" }}
										>
											{g.label}
										</div>
										{g.models.map((m) => {
											const selected = !defaultOption?.selected && model?.provider === m.provider && model?.id === m.id;
											return (
												<button
													key={`${m.provider}/${m.id}`}
													type="button"
													role="menuitemradio"
													aria-checked={selected}
													data-selected={selected}
													data-active={selected ? "true" : undefined}
													className="isx-menu-item flex min-h-10 w-full items-center justify-between gap-3 rounded-[12px] px-3 py-2 text-left"
													onClick={() => {
														onSelectModel(m.provider, m.id);
														setOpen(false);
													}}
												>
													<span className="isx-menu-shift min-w-0 flex-1 truncate" style={{ fontSize: 14, fontWeight: 500 }}>
														{m.name}
													</span>
													{selected && (
														<span className="pr-2" style={{ display: "inline-flex", flex: "none" }}>
															<IconCheckOutline14 size={16} />
														</span>
													)}
												</button>
											);
										})}
									</section>
								))}
							</div>
							{/* 思考档位入口：模型只有一档（非推理模型 / models.json 没写 reasoning: true）时也显示，
							    但置灰并说明是模型不支持，而不是让入口凭空消失 */}
							{hasModel && !modelOnly && (thinkingLevels.length > 1 ? (
								<button
									type="button"
									className="isx-menu-item mt-1 flex w-full items-center justify-between gap-3 border-t px-3 pb-1.5 pt-2 text-left"
									style={{ borderColor: "var(--dsw-border-l2)" }}
									onClick={() => setPane("effort")}
								>
									<span className="isx-menu-shift" style={{ fontSize: 13.5 }}>{t.thinking}</span>
									<span className="isx-menu-sub flex min-w-0 items-center gap-1 pr-2">
										<span className="truncate" style={{ fontSize: 13, color: "var(--dsw-label-caption)" }}>
											{thinkingLevel ?? t.thinkingOff}
										</span>
										<IconChevronRight14 size={14} style={{ flex: "none" }} />
									</span>
								</button>
							) : (
								<div
									className="mt-1 flex w-full items-center justify-between gap-3 border-t px-3 pb-1 pt-2"
									style={{ borderColor: "var(--dsw-border-l1)", opacity: 0.6 }}
									title={t.thinkingUnsupportedHint}
								>
									<span style={{ fontSize: 13.5, color: "var(--dsw-label-secondary)" }}>{t.thinking}</span>
									<span className="truncate" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.thinkingUnsupported}</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
