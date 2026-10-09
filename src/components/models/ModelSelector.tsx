"use client";

/**
 * 模型选择菜单：打开即显示 Provider 分组模型列表；思考级别保留为独立子页。
 * 传入 pi 的默认值时标出默认模型与新会话会用的档位，并提供「设为默认」（对应 pi 终端里 /model、/thinking 的 Ctrl+S）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconCheckOutline14, IconChevronDown14, IconChevronLeft14, IconChevronRight14 } from "@/components/common/icons";
import { useI18n } from "@/i18n";
import { defaultThinkingFor, type ModelDefaults } from "@/lib/models/thinking";

type Dict = ReturnType<typeof useI18n>["t"];

const LEVEL_DESC_KEYS = {
	off: "thinkingDescOff",
	minimal: "thinkingDescMinimal",
	low: "thinkingDescLow",
	medium: "thinkingDescMedium",
	high: "thinkingDescHigh",
	xhigh: "thinkingDescXhigh",
	max: "thinkingDescMax",
} as const satisfies Record<string, keyof Dict>;

/** 档位说明（与 pi 终端 /thinking 的描述一致）；未知档位返回空串 */
function thinkingLevelDesc(t: Dict, level: string): string {
	const key = LEVEL_DESC_KEYS[level as keyof typeof LEVEL_DESC_KEYS];
	return key ? t[key] : "";
}

function DefaultTag({ label }: { label: string }) {
	return <span className="pw-default-tag">{label}</span>;
}

export interface ModelChoice {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevels?: string[];
	contextWindow: number;
	/** 能看图（模型 input 含 image）：点选的页面元素会附上裁剪图 */
	vision?: boolean;
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
	defaults,
	onSaveDefault,
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
	/** pi 的默认模型 / 默认强度（settings.json）：列表标「默认」，思考子页标出新会话会用的档位 */
	defaults?: ModelDefaults | null;
	/** 设为新会话默认；level 为空表示模型只有 off，不改默认强度 */
	onSaveDefault?: (provider: string, id: string, level: string | undefined) => Promise<boolean>;
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
	const [savingDefault, setSavingDefault] = useState(false);
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
	const thinks = thinkingLevels.length > 1;
	const isDefaultModel = (provider: string, id: string) => defaults?.provider === provider && defaults?.modelId === id;
	// 当前模型在新会话里会用的档位（按模型设置 → 默认强度 → medium，再钳到模型支持的档位）
	const defaultLevel = defaults && model?.id && thinks ? defaultThinkingFor(defaults, model.provider, model.id, thinkingLevels) : undefined;
	const alreadyDefault = Boolean(model?.id) && isDefaultModel(model!.provider, model!.id) && (!thinks || !thinkingLevel || defaultLevel === thinkingLevel);
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
										<span className="flex min-w-0 flex-col">
											<span className="flex items-center gap-1.5" style={{ fontSize: 14, color: "var(--dsw-label-primary)" }}>
												{lv}
												{lv === defaultLevel && <DefaultTag label={t.defaultTag} />}
											</span>
											{thinkingLevelDesc(t, lv) && (
												<span style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{thinkingLevelDesc(t, lv)}</span>
											)}
										</span>
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
										{/* 提供商名不吸顶：吸顶会在滚动时钉住并被下一组顶出成半截文字（"卡住"观感） */}
										<div
											className="px-3 pb-1 pt-2"
											style={{ fontSize: 12, fontWeight: 500, color: "var(--dsw-label-caption)" }}
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
													<span className="flex min-w-0 flex-1 items-center gap-1.5">
														<span className="min-w-0 truncate" style={{ fontSize: 14, fontWeight: 500, color: "var(--dsw-label-primary)" }}>
															{m.name}
														</span>
														{isDefaultModel(m.provider, m.id) && <DefaultTag label={t.defaultTag} />}
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
							{/* 思考档位入口：模型只有一档（非推理模型 / models.json 没写 reasoning: true）时也显示，
							    但置灰并说明是模型不支持，而不是让入口凭空消失 */}
							{hasModel && (thinkingLevels.length > 1 ? (
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
							{hasModel && onSaveDefault && (
								<div className="flex w-full items-center justify-between gap-3 px-3 pb-2 pt-1.5">
									<span className="truncate" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>
										{t.newSessionDefault}
									</span>
									{alreadyDefault ? (
										<span className="flex flex-none items-center gap-1" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>
											<IconCheckOutline14 size={13} /> {t.isDefaultNow}
										</span>
									) : (
										<button
											type="button"
											className="pw-chip flex-none"
											disabled={savingDefault}
											onClick={async () => {
												if (!model) return;
												setSavingDefault(true);
												try {
													await onSaveDefault(model.provider, model.id, thinks ? thinkingLevel : undefined);
												} finally {
													setSavingDefault(false);
												}
											}}
										>
											{t.saveAsDefault}
										</button>
									)}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
