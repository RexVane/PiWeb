"use client";

/** Searchable provider groups; thinking levels remain on their own page. */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { IconCheckOutline14, IconChevronDown14, IconChevronLeft14, IconChevronRight14, IconSearchOutline16 } from "@/components/icons";
import { ProviderBrand } from "@/components/ProviderBrand";
import { useI18n } from "@/i18n";
import styles from "./ModelSelector.module.css";

export interface ModelChoice {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevels?: string[];
	contextWindow: number;
}

type Candidate = { key: string; model: ModelChoice | null; selected: boolean };
const DEFAULT_KEY = "default";
const modelKey = (model: { provider: string; id: string }) => JSON.stringify([model.provider, model.id]);

export function ModelSelector({
	model, thinkingLevel, thinkingLevels, models, providerNames, authByProvider,
	onSelectModel, onSelectLevel, open: openProp, onOpenChange,
	modelOnly = false, disabled = false, defaultOption, routedModel,
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
	/** 虚拟模型：最近一次回复实际路由到的物理模型（与选中项相同就不显示） */
	routedModel?: { provider: string; id: string; thinkingLevel?: string } | null;
}) {
	const { t } = useI18n();
	const id = useId();
	const [openState, setOpenState] = useState(false);
	const open = !disabled && (openProp ?? openState);
	const [pane, setPane] = useState<"model" | "effort">("model");
	const [query, setQuery] = useState("");
	const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(() => new Set());
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const effortRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const setOpen = useCallback((value: boolean) => {
		setOpenState(value);
		onOpenChange?.(value);
	}, [onOpenChange]);
	const closeMenu = () => {
		setOpen(false);
		triggerRef.current?.focus({ preventScroll: true });
	};

	useEffect(() => {
		if (!open) {
			setPane("model");
			setQuery("");
			setActiveKey(null);
			return;
		}
		if (pane === "model") searchRef.current?.focus({ preventScroll: true });
		else {
			const selected = thinkingLevels.indexOf(thinkingLevel ?? "");
			effortRefs.current[Math.max(0, selected)]?.focus({ preventScroll: true });
		}
	}, [open, pane]);

	useEffect(() => {
		if (!open) return;
		const outside = (event: MouseEvent) => {
			if (!ref.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", outside);
		return () => document.removeEventListener("mousedown", outside);
	}, [open, setOpen]);

	useLayoutEffect(() => {
		if (!open || !menuRef.current) return;
		const menu = menuRef.current;
		const align = () => {
			// Preserve the trigger's vertical anchor while keeping every consumer inside the viewport.
			menu.style.setProperty("--model-menu-offset", "0px");
			const rect = menu.getBoundingClientRect();
			const viewport = window.visualViewport;
			const left = (viewport?.offsetLeft ?? 0) + 12;
			const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? (document.documentElement.clientWidth || window.innerWidth)) - 12;
			const offset = rect.left < left ? left - rect.left : rect.right > right ? right - rect.right : 0;
			menu.style.setProperty("--model-menu-offset", `${offset}px`);
		};
		align();
		window.addEventListener("resize", align);
		window.visualViewport?.addEventListener("resize", align);
		window.visualViewport?.addEventListener("scroll", align);
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(align);
		observer?.observe(menu);
		if (ref.current) observer?.observe(ref.current);
		return () => {
			window.removeEventListener("resize", align);
			window.visualViewport?.removeEventListener("resize", align);
			window.visualViewport?.removeEventListener("scroll", align);
			observer?.disconnect();
		};
	}, [open]);

	const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
	const groups = useMemo(() => {
		const byProvider = new Map<string, ModelChoice[]>();
		for (const entry of models) {
			if (authByProvider[entry.provider] === false) continue;
			const label = providerNames[entry.provider] ?? entry.provider;
			const searchable = `${entry.name} ${entry.id} ${entry.provider} ${label}`.toLowerCase();
			if (!words.every((word) => searchable.includes(word))) continue;
			if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
			byProvider.get(entry.provider)!.push(entry);
		}
		const result = [...byProvider].map(([provider, list]) => ({
			provider,
			label: providerNames[provider] ?? provider,
			models: [...list].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
		}));
		result.sort((a, b) => a.label.localeCompare(b.label));
		const selectedGroup = result.findIndex((group) => group.provider === model?.provider);
		if (selectedGroup > 0) result.unshift(...result.splice(selectedGroup, 1));
		return result;
	}, [models, providerNames, authByProvider, model?.provider, words]);
	const showDefault = defaultOption && words.every((word) => defaultOption.label.toLowerCase().includes(word));
	const candidates: Candidate[] = useMemo(() => [
		...(showDefault ? [{ key: DEFAULT_KEY, model: null, selected: defaultOption!.selected }] : []),
		...groups.flatMap((group) => collapsedProviders.has(group.provider) ? [] : group.models.map((entry) => ({
			key: modelKey(entry), model: entry,
			selected: !defaultOption?.selected && model?.provider === entry.provider && model?.id === entry.id,
		}))),
	], [groups, collapsedProviders, showDefault, defaultOption?.selected, model?.provider, model?.id]);
	const active = candidates.find((candidate) => candidate.key === activeKey)
		?? (!words.length ? candidates.find((candidate) => candidate.selected) : undefined)
		?? candidates[0];
	const optionIds = new Map(candidates.map((candidate, index) => [candidate.key, `${id}-model-${index}`]));

	useEffect(() => {
		if (!open || pane !== "model" || !active || !listRef.current?.clientHeight) return;
		const option = document.getElementById(optionIds.get(active.key)!);
		if (!option) return;
		// Keep scrolling local to the list; opening a menu must not move the conversation.
		const list = listRef.current;
		const top = list.getBoundingClientRect().top + list.clientTop;
		const bottom = top + list.clientHeight;
		const rect = option.getBoundingClientRect();
		if (rect.top < top) list.scrollTop += rect.top - top;
		else if (rect.bottom > bottom) list.scrollTop += rect.bottom - bottom;
	}, [open, pane, active?.key, query]);

	const choose = (candidate: Candidate | undefined) => {
		if (disabled || !candidate) return;
		if (candidate.model) onSelectModel(candidate.model.provider, candidate.model.id);
		else defaultOption?.onSelect();
		closeMenu();
	};
	const toggleProvider = (provider: string) => {
		setCollapsedProviders((previous) => {
			const next = new Set(previous);
			if (next.has(provider)) next.delete(provider);
			else next.add(provider);
			return next;
		});
		setActiveKey(null);
	};
	const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
		if (event.key === "Escape" || (pane === "effort" && event.key === "ArrowLeft")) {
			event.preventDefault();
			event.stopPropagation();
			if (pane === "effort") setPane("model");
			else closeMenu();
			return;
		}
		if (pane === "effort") {
			const index = effortRefs.current.indexOf(document.activeElement as HTMLButtonElement);
			if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && thinkingLevels.length) {
				event.preventDefault();
				event.stopPropagation();
				const next = event.key === "Home" ? 0 : event.key === "End" ? thinkingLevels.length - 1
					: index < 0 ? (event.key === "ArrowDown" ? 0 : thinkingLevels.length - 1)
						: (index + (event.key === "ArrowDown" ? 1 : -1) + thinkingLevels.length) % thinkingLevels.length;
				effortRefs.current[next]?.focus();
			} else if ((event.key === "Enter" || event.key === " ") && index >= 0) {
				event.preventDefault();
				event.stopPropagation();
				onSelectLevel(thinkingLevels[index]);
				closeMenu();
			}
			return;
		}
		const target = event.target as HTMLElement;
		if (target !== searchRef.current && !target.closest('[role="option"]')) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			if (candidates.length) {
				const index = candidates.findIndex((candidate) => candidate.key === active?.key);
				setActiveKey(candidates[(index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length].key);
			}
			searchRef.current?.focus({ preventScroll: true });
		} else if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			choose(active);
		}
	};

	const hasModel = Boolean(model?.id);
	const modelName = hasModel ? (model?.name || model?.id || "") : "";
	const effortLabel = !modelOnly && hasModel && thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : undefined;
	// 虚拟模型（如按任务路由的 hero model）会让实际后端和选中项不同：显示出来，用户才知道到底是谁在回答
	const routed = routedModel && (routedModel.provider !== model?.provider || routedModel.id !== model?.id) ? routedModel : null;
	const routedLabel = routed ? t.routedModel.replace("{model}", routed.id) : "";
	const triggerTitle = (defaultOption?.selected ? `${defaultOption.label} · ` : "") + (hasModel
		? `${providerNames[model?.provider ?? ""] ?? model?.provider}/${modelName}${effortLabel ? ` · ${effortLabel}` : ""}${routed ? ` · ${routedLabel}` : ""}`
		: t.selectModel);

	return (
		<div ref={ref} className="relative" onBlurCapture={(event) => {
			if (event.relatedTarget instanceof Node && !ref.current?.contains(event.relatedTarget)) setOpen(false);
		}}>
			<button ref={triggerRef} type="button" className={`chip ${styles.trigger}`} data-open={open}
				title={triggerTitle} aria-label={triggerTitle} aria-haspopup="dialog" aria-expanded={open}
				aria-controls={open ? `${id}-popup` : undefined} disabled={disabled}
				onClick={() => { setPane("model"); setOpen(!open); }}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						event.stopPropagation();
						setPane("model");
						setOpen(true);
					} else if (event.key === "Escape" && open) {
						event.preventDefault();
						event.stopPropagation();
						closeMenu();
					}
				}}>
				<span className={styles.triggerName} suppressHydrationWarning>{hasModel ? modelName : t.selectModel}</span>
				{routed && <span className={styles.routedLabel} title={routedLabel}>→ {routed.id}</span>}
				{effortLabel && <span className={styles.effortLabel}>{effortLabel}</span>}
				<span className="chevron"><IconChevronDown14 size={14} /></span>
			</button>
			{open && (
				<div ref={menuRef} id={`${id}-popup`} className={`popover ${styles.menu}`} role="dialog" aria-label={t.selectModel} onKeyDown={onMenuKeyDown}>
					{pane === "effort" ? (
						<div className={styles.effortPage}>
							<button type="button" className={styles.back} onClick={() => setPane("model")}>
								<IconChevronLeft14 size={14} /><span>{t.thinking}</span>
							</button>
							<div role="menu" aria-label={t.thinking}>
								{thinkingLevels.length === 0 && <p className={styles.empty}>{t.emptyEfforts}</p>}
								{thinkingLevels.map((level, index) => (
									<button key={level} ref={(element) => { effortRefs.current[index] = element; }} type="button"
										role="menuitemradio" aria-checked={thinkingLevel === level} className={styles.option}
										onClick={() => { onSelectLevel(level); closeMenu(); }}>
										<span className={styles.optionCopy}>{level}</span>
										{thinkingLevel === level && <IconCheckOutline14 size={15} />}
									</button>
								))}
							</div>
						</div>
					) : (
						<>
							<div className={styles.search}>
								<IconSearchOutline16 size={15} />
								<input ref={searchRef} type="search" role="combobox" aria-label={t.modelSearchPlaceholder}
									placeholder={t.modelSearchPlaceholder} value={query} autoComplete="off" spellCheck={false}
									aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`}
									aria-activedescendant={active ? optionIds.get(active.key) : undefined}
									onChange={(event) => { setQuery(event.target.value); setActiveKey(null); setCollapsedProviders(new Set()); }} />
								<kbd aria-hidden="true">↑↓</kbd>
							</div>
							<div ref={listRef} id={`${id}-list`} className={styles.list} role="listbox" aria-label={t.selectModel}>
								{showDefault && <button id={optionIds.get(DEFAULT_KEY)} type="button" role="option" tabIndex={-1}
									aria-selected={defaultOption!.selected} data-selected={defaultOption!.selected} data-focused={active?.key === DEFAULT_KEY}
									className={styles.option} onFocus={() => setActiveKey(DEFAULT_KEY)} onClick={() => choose(candidates.find((candidate) => candidate.key === DEFAULT_KEY))}>
									<span className={styles.optionCopy}>{defaultOption!.label}</span>
									{defaultOption!.selected && <IconCheckOutline14 size={15} />}
								</button>}
								{groups.length === 0 && !showDefault && <p className={styles.empty} role="status">{words.length ? t.modelSearchEmpty : t.emptyModels}</p>}
								{groups.map((group, groupIndex) => (
									<section key={group.provider} role="group" aria-labelledby={`${id}-provider-${groupIndex}`} className={styles.group}>
										<button type="button" id={`${id}-provider-${groupIndex}`} className={styles.groupTitle} title={group.label}
											aria-label={group.label} aria-expanded={!collapsedProviders.has(group.provider)} aria-controls={`${id}-provider-models-${groupIndex}`}
											onClick={() => toggleProvider(group.provider)}>
											<ProviderBrand id={group.provider} name={group.label} size={22} />
											<span>{group.label}</span><span className={styles.count} aria-hidden="true">{group.models.length}</span>
											<IconChevronDown14 className={styles.groupChevron} size={13} />
										</button>
										<div id={`${id}-provider-models-${groupIndex}`} hidden={collapsedProviders.has(group.provider)}>
										{!collapsedProviders.has(group.provider) && group.models.map((entry) => {
											const key = modelKey(entry);
											const candidate = candidates.find((item) => item.key === key)!;
											return <button key={key} id={optionIds.get(key)} type="button" role="option" tabIndex={-1}
												aria-selected={candidate.selected} aria-label={entry.name && entry.name !== entry.id ? `${entry.name} · ${entry.id}` : entry.id}
												data-selected={candidate.selected} data-focused={active?.key === key}
												className={styles.option} title={`${entry.name || entry.id}\n${entry.id}`}
												onFocus={() => setActiveKey(key)} onClick={() => choose(candidate)}>
												<span className={styles.optionCopy}><span className={styles.optionName}>{entry.name || entry.id}</span>
													{entry.name && entry.name !== entry.id && <span className={styles.optionId}>{entry.id}</span>}</span>
												{candidate.selected && <IconCheckOutline14 size={15} />}
											</button>;
										})}
										</div>
									</section>
								))}
							</div>
							{hasModel && !modelOnly && (thinkingLevels.length > 1 ? (
								<button type="button" className={styles.effortLink} aria-label={`${t.thinking}: ${thinkingLevel ?? t.thinkingOff}`} onClick={() => setPane("effort")}>
									<span>{t.thinking}</span><span className={styles.effortValue}>{thinkingLevel ?? t.thinkingOff}<IconChevronRight14 size={14} /></span>
								</button>
							) : <div className={styles.unsupported} title={t.thinkingUnsupportedHint}>
								<span>{t.thinking}</span><span>{t.thinkingUnsupported}</span>
							</div>)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
