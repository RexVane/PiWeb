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
	const effortLabel = hasModel && thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : undefined;
	const triggerTitle = hasModel
		? `${providerNames[model?.provider ?? ""] ?? model?.provider}/${modelName}${effortLabel ? ` · ${effortLabel}` : ""}`
		: t.selectModel;

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
								className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors"
								style={{ color: "var(--dsw-label-secondary)" }}
								onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
								onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
								onClick={() => setPane("model")}
							>
								<IconChevronLeft14 size={14} /> {t.thinking}
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
										className="flex w-full items-center justify-between px-4 py-2 text-left transition-colors"
										onMouseEnter={(e) => {
											if (!selected) e.currentTarget.style.background = "var(--dsw-hover)";
										}}
										onMouseLeave={(e) => {
											if (!selected) e.currentTarget.style.background = "transparent";
										}}
										onClick={() => {
											onSelectLevel(lv);
											setOpen(false);
										}}
									>
										<span style={{ fontSize: 14, color: "var(--dsw-label-primary)" }}>{lv}</span>
										{selected && (
											<span style={{ display: "inline-flex", color: "var(--dsw-label-primary)" }}>
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
							<div ref={listRef} className="max-h-[340px] overflow-y-auto py-1">
								{groups.length === 0 && (
									<div className="px-3 py-3" style={{ fontSize: 13, color: "var(--dsw-label-caption)" }}>
										{t.emptyModels}
									</div>
								)}
								{groups.map((g) => (
									<section key={g.provider} role="group" aria-label={g.label}>
										<div
											className="sticky top-0 z-[1] px-3 pb-1 pt-2"
											style={{ fontSize: 12, fontWeight: 500, color: "var(--dsw-label-caption)", background: "var(--dsw-glass-popover)" }}
										>
											{g.label}
										</div>
										{g.models.map((m) => {
											const selected = model?.provider === m.provider && model?.id === m.id;
											return (
												<button
													key={`${m.provider}/${m.id}`}
													type="button"
													role="menuitemradio"
											aria-checked={selected}
											data-selected={selected}
											className="flex min-h-10 w-full items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-left transition-colors"
											style={{ background: selected ? "var(--dsw-active)" : "transparent" }}
											onMouseEnter={(e) => {
												if (!selected) e.currentTarget.style.background = "var(--dsw-hover)";
											}}
											onMouseLeave={(e) => {
												if (!selected) e.currentTarget.style.background = "transparent";
											}}
													onClick={() => {
														onSelectModel(m.provider, m.id);
														setOpen(false);
													}}
												>
													<span className="min-w-0 flex-1 truncate" style={{ fontSize: 14, fontWeight: 500, color: "var(--dsw-label-primary)" }}>
														{m.name}
													</span>
													{selected && (
														<span style={{ display: "inline-flex", color: "var(--dsw-label-primary)", flex: "none" }}>
															<IconCheckOutline14 size={16} />
														</span>
													)}
												</button>
											);
										})}
									</section>
								))}
							</div>
							{thinkingLevels.length > 1 && (
								<button
									type="button"
									className="mt-1 flex w-full items-center justify-between gap-3 border-t px-3 pb-1 pt-2 text-left transition-colors"
									style={{ borderColor: "var(--dsw-border-l1)" }}
									onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
									onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
									onClick={() => setPane("effort")}
								>
									<span style={{ fontSize: 13.5, color: "var(--dsw-label-secondary)" }}>{t.thinking}</span>
									<span className="flex min-w-0 items-center gap-1">
										<span className="truncate" style={{ fontSize: 13, color: "var(--dsw-label-caption)" }}>
											{thinkingLevel ?? t.thinkingOff}
										</span>
										<IconChevronRight14 size={14} style={{ flex: "none", color: "var(--dsw-label-tertiary)" }} />
									</span>
								</button>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
