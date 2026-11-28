"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheckOutline14, IconChevronDown14, IconChevronRight14, IconCloseOutline14, IconCopyOutline16, IconRefreshOutline14 } from "@/components/icons";
import { useDialog } from "@/hooks/useDialog";
import { useI18n } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import {
	CONTEXT_CATEGORY_KEYS,
	extractClientEffectiveContext,
	type ContextCategoryKey,
	type ContextInspectItem,
	type ContextMessageLike,
	type EffectiveContextResponse,
} from "@/lib/effective-context";
import { fmtTokens } from "@/lib/format";

export interface ContextCategoryMeta {
	key: ContextCategoryKey;
	label: string;
	color: string;
	chars: number;
}

const CATEGORY_COLORS: Record<ContextCategoryKey, string> = {
	system: "#3b82f6",
	builtin: "#8b5cf6",
	custom: "#a855f7",
	memory: "#06b6d4",
	skills: "#10b981",
	user: "#22c55e",
	text: "#84cc16",
	thinking: "#eab308",
	call: "#f97316",
	output: "#f59e0b",
	compacted: "#ec4899",
};

const PAGE_SIZE = 20;

const TEMPORAL_CATEGORIES = new Set<ContextCategoryKey>(["user", "text", "thinking", "call", "output", "compacted"]);

function sortContextItemsByTimeDesc(items: ContextInspectItem[], category: ContextCategoryKey): ContextInspectItem[] {
	const indexed = items.map((item, index) => ({ item, index }));
	const isTemporal = TEMPORAL_CATEGORIES.has(category);
	indexed.sort((a, b) => {
		const ta = typeof a.item.timestamp === "number" && Number.isFinite(a.item.timestamp) ? a.item.timestamp : null;
		const tb = typeof b.item.timestamp === "number" && Number.isFinite(b.item.timestamp) ? b.item.timestamp : null;
		if (ta !== null && tb !== null && ta !== tb) return tb - ta;
		if (ta !== null && tb === null) return -1;
		if (ta === null && tb !== null) return 1;
		const turnA = typeof a.item.turn === "number" ? a.item.turn : null;
		const turnB = typeof b.item.turn === "number" ? b.item.turn : null;
		if (turnA !== null && turnB !== null && turnA !== turnB) return turnB - turnA;
		if (turnA !== null && turnB === null) return -1;
		if (turnA === null && turnB !== null) return 1;
		return isTemporal ? b.index - a.index : a.index - b.index;
	});
	return indexed.map((entry) => entry.item);
}

interface InnerProps {
	initialCategory: ContextCategoryKey;
	categoryMeta: ContextCategoryMeta[];
	messages: ContextMessageLike[];
	model?: { provider: string; id: string } | null;
	sessionId?: string | null;
	refreshKey?: unknown;
	cold?: boolean;
	onLoadFull?: () => Promise<unknown> | unknown;
	onClose: () => void;
}

function ContextInspectorModalInner({
	initialCategory,
	categoryMeta,
	messages,
	model,
	sessionId,
	refreshKey,
	cold = false,
	onLoadFull,
	onClose,
}: InnerProps) {
	const { t } = useI18n();
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const reqSeq = useRef(0);
	const prevCold = useRef(cold);

	useDialog({ open: true, onClose, ref: dialogRef });

	const [activeCategory, setActiveCategory] = useState<ContextCategoryKey>(initialCategory);
	const [serverData, setServerData] = useState<EffectiveContextResponse | null>(null);
	const [loading, setLoading] = useState(Boolean(sessionId));
	const [error, setError] = useState<string | null>(null);
	const [limit, setLimit] = useState(PAGE_SIZE);
	const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	const loadFromServer = useCallback(async () => {
		if (!sessionId) return;
		const seq = ++reqSeq.current;
		setLoading(true);
		setError(null);
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context`);
			const body = (await response.json().catch(() => null)) as { success?: boolean; data?: EffectiveContextResponse; error?: string } | null;
			if (seq !== reqSeq.current) return;
			if (!response.ok || !body?.success || !body.data) {
				throw new Error(body?.error || `request failed (${response.status})`);
			}
			setServerData(body.data);
		} catch (err) {
			if (seq === reqSeq.current) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (seq === reqSeq.current) setLoading(false);
		}
	}, [sessionId]);

	useEffect(() => {
		if (sessionId) {
			void loadFromServer();
		} else {
			setServerData(null);
			setLoading(false);
			setError(null);
		}
	}, [sessionId, loadFromServer, refreshKey]);

	useEffect(() => {
		if (prevCold.current && !cold && sessionId) {
			setStarting(false);
			void loadFromServer();
		}
		prevCold.current = cold;
	}, [cold, sessionId, loadFromServer]);

	const clientFallback = useMemo(
		() => (sessionId ? null : extractClientEffectiveContext(messages, model)),
		[sessionId, messages, model],
	);
	const effectiveData = sessionId ? serverData : clientFallback;
	const effectiveCold = effectiveData?.cold ?? cold;

	const categoryLabel = useCallback((key: ContextCategoryKey): string => {
		switch (key) {
			case "system": return t.contextSystemPrompt;
			case "builtin": return t.contextSystemTools;
			case "custom": return t.contextCustomTools;
			case "memory": return t.contextMemory;
			case "skills": return t.contextSkills;
			case "user": return t.contextUserMessages;
			case "text": return t.contextAgentText;
			case "thinking": return t.contextAgentThinking;
			case "call": return t.contextAgentToolCall;
			case "output": return t.contextToolOutput;
			case "compacted": return t.contextCompacted;
		}
	}, [t]);

	const tabs = useMemo(() => {
		const metaByKey = new Map(categoryMeta.map((c) => [c.key, c]));
		return CONTEXT_CATEGORY_KEYS
			.filter((key) => key === activeCategory || (effectiveData ? (effectiveData.totals[key] ?? 0) > 0 : metaByKey.has(key)))
			.map((key) => {
				const meta = metaByKey.get(key);
				const chars = effectiveData ? (effectiveData.totals[key] ?? 0) : (meta?.chars ?? 0);
				return {
					key,
					label: meta?.label ?? categoryLabel(key),
					color: meta?.color ?? CATEGORY_COLORS[key],
					chars,
				};
			})
			.sort((a, b) => b.chars - a.chars || CONTEXT_CATEGORY_KEYS.indexOf(a.key) - CONTEXT_CATEGORY_KEYS.indexOf(b.key));
	}, [activeCategory, categoryMeta, effectiveData, categoryLabel]);

	const activeMeta = tabs.find((tab) => tab.key === activeCategory) ?? {
		key: activeCategory,
		label: categoryLabel(activeCategory),
		color: CATEGORY_COLORS[activeCategory],
		chars: effectiveData?.totals[activeCategory] ?? 0,
	};

	const switchCategory = (next: ContextCategoryKey) => {
		setActiveCategory(next);
		setLimit(PAGE_SIZE);
	};

	const displayTitle = useCallback((item: ContextInspectItem): string => {
		if (item.id === "memory:injected") return t.contextInspectorInjectedMemory;
		if (item.id === "skills:injected") return t.contextInspectorInjectedSkills;
		if (item.id === "system:main") return t.contextSystemPrompt;
		if (item.category === "compacted" && item.tag === "compaction") return t.promptCompactedKey;
		if (!item.title && item.turn) return t.contextInspectorTurn.replace("{n}", String(item.turn));
		if (!item.title) return categoryLabel(item.category);
		return item.title;
	}, [t, categoryLabel]);

	const displayTag = useCallback((item: ContextInspectItem): string | undefined => {
		if (item.tag === "builtin") return t.promptToolBuiltin;
		if (item.tag === "extension") return t.promptToolExtension;
		if (item.tag === "piweb") return t.promptOriginPiweb;
		if (item.tag === "shell") return "shell";
		if (item.tag === "hidden") return t.contextInspectorHiddenTag;
		if (item.tag === "compaction") return t.contextInspectorCompactionTag;
		if (item.tag === "branch") return t.contextInspectorBranchTag;
		if (item.tag === "aborted") return "aborted";
		if (item.tag === "error") return t.error;
		return item.tagText;
	}, [t]);

	const rawItems = useMemo(
		() => effectiveData?.categories[activeCategory] ?? [],
		[effectiveData, activeCategory],
	);

	const sortedItems = useMemo(
		() => sortContextItemsByTimeDesc(rawItems, activeCategory),
		[rawItems, activeCategory],
	);

	const visibleItems = sortedItems.slice(0, limit);
	const maxChars = useMemo(() => Math.max(1, ...sortedItems.map((item) => item.chars)), [sortedItems]);
	const totalChars = useMemo(() => rawItems.reduce((sum, item) => sum + item.chars, 0), [rawItems]);

	const handleCopy = async (item: ContextInspectItem) => {
		await copyText(item.content);
		setCopiedId(item.id);
		window.setTimeout(() => {
			setCopiedId((current) => (current === item.id ? null : current));
		}, 1800);
	};

	const showColdStartPrompt = effectiveCold && !loading && rawItems.length === 0 && (activeCategory === "system" || activeCategory === "builtin" || activeCategory === "custom");

	if (typeof document === "undefined") return null;

	return createPortal(
		<div
			className="modal-mask fixed inset-0 z-[9990] flex items-center justify-center p-3 sm:p-5 animate-in fade-in duration-150"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				className="glass-modal pw-ctx-inspector flex max-h-[86vh] w-full max-w-[820px] flex-col overflow-hidden"
				style={{ boxShadow: "var(--pw-shadow-modal)", color: "var(--dsw-label-primary)" }}
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				data-testid="context-inspector-modal"
			>
				{/* Header */}
				<div className="hairline-b flex flex-none items-center gap-2.5 px-4 py-3 sm:px-5">
					<span className="inline-block h-2.5 w-2.5 flex-none rounded-full" style={{ background: activeMeta.color }} />
					<h2 id={titleId} className="min-w-0 truncate font-semibold" style={{ fontSize: "calc(15px + var(--dsh-content-font-delta))" }}>
						{activeMeta.label}
					</h2>
					<span className="ml-auto flex-none font-mono" style={{ fontSize: 11.5, color: "var(--dsw-label-tertiary)" }}>
						{t.contextInspectorItemsCount.replace("{count}", String(rawItems.length))} · {fmtTokens(totalChars || activeMeta.chars)} {t.contextChars}
					</span>
					{sessionId && (
						<button
							type="button"
							className="icon-btn flex-none"
							style={{ width: 28, height: 28 }}
							title={t.promptRefresh}
							aria-label={t.promptRefresh}
							disabled={loading}
							onClick={() => void loadFromServer()}
						>
							<span className={loading ? "piweb-spin" : undefined} style={{ display: "inline-flex" }}>
								<IconRefreshOutline14 size={14} />
							</span>
						</button>
					)}
					<button
						type="button"
						className="icon-btn flex-none"
						style={{ width: 28, height: 28 }}
						title={t.close}
						aria-label={t.close}
						onClick={onClose}
					>
						<IconCloseOutline14 size={15} />
					</button>
				</div>

				{/* Category Switcher */}
				<div className="hairline-b pw-ctx-inspector-tabs flex flex-none flex-wrap items-center gap-2 px-4 py-2.5 sm:px-5" role="tablist" aria-label={t.contextWindowLabel}>
					{tabs.map((tab) => {
						const active = tab.key === activeCategory;
						return (
							<button
								key={tab.key}
								type="button"
								role="tab"
								aria-selected={active}
								data-active={active || undefined}
								className="pw-ctx-inspector-tab flex flex-none items-center gap-1.5"
								onClick={() => switchCategory(tab.key)}
							>
								<span className="inline-block h-2 w-2 rounded-full" style={{ background: tab.color }} />
								<span>{tab.label}</span>
								<span className="font-mono" style={{ opacity: 0.72, fontSize: "0.9em" }}>{fmtTokens(tab.chars)}</span>
							</button>
						);
					})}
				</div>

				{/* Body */}
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
					{error && (
						<div className="mb-3 rounded-lg px-3 py-2" role="alert" style={{ background: "var(--dsw-hover)", color: "var(--dsw-danger)", fontSize: "var(--dsh-content-font-size-secondary)" }}>
							{error}
						</div>
					)}

					{loading && !effectiveData ? (
						<div className="py-8 text-center" style={{ color: "var(--dsw-label-tertiary)", fontSize: "var(--dsh-content-font-size-secondary)" }}>
							{t.contextInspectorLoading}
						</div>
					) : showColdStartPrompt ? (
						<div className="flex flex-col items-center gap-3 rounded-xl px-4 py-6 text-center" style={{ background: "var(--dsw-hover)", color: "var(--dsw-label-secondary)", fontSize: "var(--dsh-content-font-size-secondary)" }}>
							<p>{t.contextInspectorColdEmpty}</p>
							{onLoadFull && (
								<button
									type="button"
									className="btn-outline"
									disabled={starting}
									onClick={() => {
										setStarting(true);
										void Promise.resolve(onLoadFull()).then((result) => {
											if ((result as { success?: boolean } | undefined)?.success === false) setStarting(false);
										}, () => setStarting(false));
									}}
								>
									{starting ? t.contextCounting : t.contextCountNow}
								</button>
							)}
						</div>
					) : visibleItems.length === 0 ? (
						<div className="py-8 text-center" style={{ color: "var(--dsw-label-tertiary)", fontSize: "var(--dsh-content-font-size-secondary)" }}>
							{t.contextInspectorEmpty}
						</div>
					) : (
						<div className="flex flex-col gap-2">
							{visibleItems.map((item) => {
								const expanded = sortedItems.length === 1 || Boolean(expandedIds[item.id]);
								const title = displayTitle(item);
								const tagLabel = displayTag(item);
								const barPct = Math.max(2, Math.min(100, (item.chars / maxChars) * 100));
								const isCopied = copiedId === item.id;
								return (
									<div key={item.id} className="pw-ctx-inspector-item" data-open={expanded || undefined}>
										<button
											type="button"
											className="pw-ctx-inspector-item-head"
											aria-expanded={expanded}
											onClick={() => setExpandedIds((prev) => ({ ...prev, [item.id]: !expanded }))}
										>
											<span className="flex-none" style={{ color: "var(--dsw-label-tertiary)" }}>
												{expanded ? <IconChevronDown14 size={13} /> : <IconChevronRight14 size={13} />}
											</span>
											<span className="min-w-0 flex-1 truncate text-left font-medium" style={{ color: "var(--dsw-label-primary)" }}>
												{title}
												{item.subtitle && item.subtitle !== title && (
													<span className="ml-2 font-normal" style={{ color: "var(--dsw-label-tertiary)", fontSize: "0.92em" }}>
														{item.subtitle}
													</span>
												)}
											</span>
											{tagLabel && (
												<span
													className="pw-ctx-inspector-tag flex-none"
													data-error={item.isError || undefined}
												>
													{tagLabel}
												</span>
											)}
											<span className="pw-ctx-inspector-minibar hidden sm:inline-block" aria-hidden>
												<span style={{ width: `${barPct}%`, background: activeMeta.color }} />
											</span>
											<span
												className="flex-none font-mono"
												title={`${item.chars} ${t.contextChars}`}
												style={{ fontSize: 11.5, color: "var(--dsw-label-secondary)", fontVariantNumeric: "tabular-nums" }}
											>
												{fmtTokens(item.chars)} {t.contextChars}
											</span>
										</button>
										{expanded && (
											<div className="pw-ctx-inspector-item-body">
												<div className="mb-1.5 flex items-center justify-between gap-2">
													<span style={{ fontSize: 11, color: "var(--dsw-label-caption)" }}>
														{item.truncated
															? t.contextInspectorTruncated
																.replace("{shown}", fmtTokens(item.content.length))
																.replace("{total}", fmtTokens(item.chars))
															: `${item.chars.toLocaleString("en-US")} ${t.contextChars}`}
													</span>
													<button
														type="button"
														className="btn-outline flex items-center gap-1"
														style={{ height: 22, padding: "0 8px", fontSize: 11 }}
														onClick={() => void handleCopy(item)}
													>
														{isCopied ? <IconCheckOutline14 size={12} /> : <IconCopyOutline16 size={12} />}
														<span>{isCopied ? t.contextInspectorCopied : t.copy}</span>
													</button>
												</div>
												<pre className="pw-ctx-inspector-pre">{item.content}</pre>
											</div>
										)}
									</div>
								);
							})}
							{sortedItems.length > visibleItems.length && (
								<button
									type="button"
									className="btn-outline mt-1 self-center"
									onClick={() => setLimit((n) => n + PAGE_SIZE)}
								>
									{t.contextInspectorShowMore.replace("{count}", String(sortedItems.length - visibleItems.length))}
								</button>
							)}
						</div>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}

export function ContextInspectorModal({
	open,
	initialCategory,
	categoryMeta,
	messages,
	model,
	sessionId,
	refreshKey,
	cold,
	onLoadFull,
	onClose,
}: {
	open: boolean;
	initialCategory: ContextCategoryKey;
	categoryMeta: ContextCategoryMeta[];
	messages: ContextMessageLike[];
	model?: { provider: string; id: string } | null;
	sessionId?: string | null;
	refreshKey?: unknown;
	cold?: boolean;
	onLoadFull?: () => Promise<unknown> | unknown;
	onClose: () => void;
}) {
	if (!open) return null;
	return (
		<ContextInspectorModalInner
			key={initialCategory}
			initialCategory={initialCategory}
			categoryMeta={categoryMeta}
			messages={messages}
			model={model}
			sessionId={sessionId}
			refreshKey={refreshKey}
			cold={cold}
			onLoadFull={onLoadFull}
			onClose={onClose}
		/>
	);
}
