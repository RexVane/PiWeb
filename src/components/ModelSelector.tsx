"use client";

/**
 * 模型选择菜单 —— 照 dsh 两级结构：
 * 点芯片 → 根菜单（模型 / 思考 两行钻入）→ 分组模型列表（Provider 分组 + ✓）或思考级别。
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
	const [pane, setPane] = useState<"root" | "model" | "effort">("root");
	const ref = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const { t } = useI18n();

	useEffect(() => {
		if (!open) return;
		const h = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [open]);

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
		? (effortLabel ? `${modelName} · ${effortLabel}` : modelName)
		: t.selectModel;

	return (
		<div ref={ref} className="relative">
			<button
				className="chip"
				data-open={open}
				title={triggerTitle}
				onClick={() => {
					setOpen(!open);
					setPane("root");
				}}
			>
				<span className="max-w-[220px] truncate">{hasModel ? modelName : t.selectModel}</span>
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
				<div className="popover absolute bottom-10 right-0 z-50 w-[340px]">
					{pane === "root" && (
						<div className="py-1">
							<button
								className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors"
								onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
								onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
								onClick={() => setPane("model")}
							>
								<span style={{ fontSize: 14, color: "var(--dsw-label-primary)", flex: "none" }}>{t.model}</span>
								<span className="flex min-w-0 items-center gap-1">
									<span className="min-w-0 truncate" style={{ fontSize: 13.5, color: "var(--dsw-label-secondary)" }}>
										{hasModel ? modelName : t.selectModel}
									</span>
									<IconChevronRight14 size={14} style={{ flex: "none", color: "var(--dsw-label-tertiary)" }} />
								</span>
							</button>
							<button
								className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors"
								onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
								onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
								onClick={() => setPane("effort")}
							>
								<span style={{ fontSize: 14, color: "var(--dsw-label-primary)", flex: "none" }}>{t.thinking}</span>
								<span className="flex min-w-0 items-center gap-1">
									<span className="truncate" style={{ fontSize: 13.5, color: "var(--dsw-label-secondary)" }}>
										{thinkingLevel ?? t.thinkingOff}
									</span>
									<IconChevronRight14 size={14} style={{ flex: "none", color: "var(--dsw-label-tertiary)" }} />
								</span>
							</button>
						</div>
					)}

					{pane === "effort" && (
						<div className="py-1">
							<button
								className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors"
								style={{ color: "var(--dsw-label-secondary)" }}
								onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
								onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
								onClick={() => setPane("root")}
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
						<div ref={listRef} className="max-h-[380px] overflow-y-auto py-1.5">
							<button
								className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors"
								style={{ color: "var(--dsw-label-secondary)", position: "sticky", top: 0, background: "var(--dsw-glass-popover)", zIndex: 1 }}
								onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
								onClick={() => setPane("root")}
							>
								<IconChevronLeft14 size={14} /> {t.model}
							</button>
							{groups.length === 0 && (
								<div className="px-4 py-3" style={{ fontSize: 13, color: "var(--dsw-label-caption)" }}>
									{t.emptyModels}
								</div>
							)}
							{groups.map((g) => (
								<div key={g.provider}>
									<div className="px-4 pb-1 pt-2" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
										{g.label}
									</div>
									{g.models.map((m) => {
										const selected = model?.provider === m.provider && model?.id === m.id;
										return (
											<button
												key={`${m.provider}/${m.id}`}
												data-selected={selected}
												className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left transition-colors"
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
												<span className="min-w-0 flex-1 truncate" style={{ fontSize: 14, color: "var(--dsw-label-primary)" }}>
													{m.name}
												</span>
												{m.reasoning && (
													<span style={{ fontSize: 11, color: "var(--dsw-label-caption)", flex: "none" }}>◎</span>
												)}
												{selected && (
													<span style={{ display: "inline-flex", color: "var(--dsw-label-primary)", flex: "none" }}>
														<IconCheckOutline14 size={14} />
													</span>
												)}
											</button>
										);
									})}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
