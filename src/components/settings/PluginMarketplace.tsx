"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { IconCheckOutline14, IconPluginOutline16, IconRefreshOutline14, IconSearchOutline16 } from "@/components/icons";
import { useI18n } from "@/i18n";
import type {
	CompatibilityBlocker,
	CompatibilityCaveat,
	MarketplaceCategory,
	MarketplacePlugin,
	PackageCompatibility,
	PiRuntimeInfo,
} from "@/lib/plugins-marketplace";

type MarketScopeFilter = "discover" | "available" | "installed";

const BADGE_TONES = [
	{ color: "#3b82f6", bg: "rgba(59, 130, 246, 0.12)" },
	{ color: "#8b5cf6", bg: "rgba(139, 92, 246, 0.12)" },
	{ color: "#10b981", bg: "rgba(16, 185, 129, 0.12)" },
	{ color: "#f59e0b", bg: "rgba(245, 158, 11, 0.12)" },
	{ color: "#06b6d4", bg: "rgba(6, 182, 212, 0.12)" },
] as const;

function badgeToneForName(name: string) {
	let hash = 0;
	for (let i = 0; i < name.length; i += 1) {
		hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	}
	return BADGE_TONES[hash % BADGE_TONES.length];
}

function normalizeNpmPackageName(source: string): string | null {
	const cleaned = source.trim();
	if (!cleaned) return null;
	if (/^(?:git[:+]|https?:|[./~]|[a-zA-Z]:[\\/])/i.test(cleaned)) return null;
	const withoutPrefix = cleaned.replace(/^npm:/i, "");
	if (withoutPrefix.startsWith("@")) {
		const slashIdx = withoutPrefix.indexOf("/");
		if (slashIdx < 0) return null;
		const atVersionIdx = withoutPrefix.indexOf("@", slashIdx + 1);
		return (atVersionIdx > 0 ? withoutPrefix.slice(0, atVersionIdx) : withoutPrefix).toLowerCase();
	}
	const atVersionIdx = withoutPrefix.indexOf("@");
	return (atVersionIdx > 0 ? withoutPrefix.slice(0, atVersionIdx) : withoutPrefix).toLowerCase();
}

function formatDownloads(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

export function PluginMarketplace({
	installedPackageSources,
	busy,
	busyKey,
	twoColumns,
	onInstall,
	initialCategory = "all",
	refreshSeq = 0,
	hideToolbarRefresh = false,
	onLoadingChange,
	installScope,
	onInstallScopeChange,
	installScopeControl,
}: {
	installedPackageSources: string[];
	busy: boolean;
	busyKey: string | null;
	twoColumns: boolean;
	onInstall: (source: string, itemKey: string) => void;
	initialCategory?: MarketplaceCategory;
	refreshSeq?: number;
	hideToolbarRefresh?: boolean;
	onLoadingChange?: (loading: boolean) => void;
	installScope?: "user" | "project";
	onInstallScopeChange?: (scope: "user" | "project") => void;
	/** 紧挨着「安装到」控件渲染的附加控件（市场页用它放「当前工作区」选择器） */
	installScopeControl?: ReactNode;
}) {
	const { t } = useI18n();
	const { confirm, confirmDialog } = useConfirmDialog();
	const [subTab, setSubTab] = useState<MarketScopeFilter>("discover");
	const [category, setCategory] = useState<MarketplaceCategory>(initialCategory);
	const [searchInput, setSearchInput] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [items, setItems] = useState<MarketplacePlugin[]>([]);
	const [runtime, setRuntime] = useState<PiRuntimeInfo | null>(null);
	const [compatMap, setCompatMap] = useState<Record<string, PackageCompatibility>>({});
	const [inspecting, setInspecting] = useState(false);
	const [hideIncompatible, setHideIncompatible] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const inspectAbortRef = useRef<AbortController | null>(null);
	const inspectSeqRef = useRef(0);
	const prevRefreshSeqRef = useRef(refreshSeq);

	useEffect(() => {
		setCategory(initialCategory);
	}, [initialCategory]);

	useEffect(() => {
		onLoadingChange?.(loading);
	}, [loading, onLoadingChange]);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQuery(searchInput.trim()), 260);
		return () => clearTimeout(timer);
	}, [searchInput]);

	const inspectItems = useCallback(async (list: MarketplacePlugin[]) => {
		inspectAbortRef.current?.abort();
		const seq = ++inspectSeqRef.current;
		if (list.length === 0) {
			setCompatMap({});
			setInspecting(false);
			return;
		}
		const controller = new AbortController();
		inspectAbortRef.current = controller;
		setCompatMap({});
		setInspecting(true);
		try {
			const res = await fetch("/api/plugins/marketplace", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					packages: list.map((item) => ({ name: item.name, version: item.version })),
				}),
				signal: controller.signal,
			});
			if (!res.ok) return;
			const j = (await res.json()) as {
				success?: boolean;
				data?: { compatibility?: Record<string, PackageCompatibility | { error: true }>; runtime?: PiRuntimeInfo };
			};
			if (controller.signal.aborted || seq !== inspectSeqRef.current || !j?.success || !j.data?.compatibility) return;
			if (j.data.runtime) setRuntime(j.data.runtime);
			const next: Record<string, PackageCompatibility> = {};
			for (const [pkgName, entry] of Object.entries(j.data.compatibility)) {
				if (entry && typeof entry === "object" && "status" in entry) {
					next[pkgName] = entry;
				}
			}
			setCompatMap(next);
		} catch {
			// Best-effort compatibility inspection must not block marketplace browsing.
		} finally {
			if (!controller.signal.aborted && seq === inspectSeqRef.current) {
				setInspecting(false);
			}
		}
	}, []);

	const fetchMarket = useCallback(
		async (queryText: string, cat: MarketplaceCategory, refresh = false) => {
			abortRef.current?.abort();
			inspectAbortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;
			setLoading(true);
			setError(null);
			try {
				const params = new URLSearchParams();
				if (queryText) params.set("q", queryText);
				if (cat !== "all") params.set("category", cat);
				if (refresh) params.set("refresh", "1");
				const r = await fetch(`/api/plugins/marketplace?${params.toString()}`, { signal: controller.signal });
				const j = await r.json();
				if (controller.signal.aborted) return;
				if (!r.ok) {
					throw new Error(typeof j?.error === "string" ? j.error : `HTTP ${r.status}`);
				}
				const nextItems: MarketplacePlugin[] = Array.isArray(j?.items) ? j.items : [];
				if (j?.runtime && typeof j.runtime === "object") {
					setRuntime(j.runtime as PiRuntimeInfo);
				}
				setItems(nextItems);
				void inspectItems(nextItems);
			} catch (err) {
				if (controller.signal.aborted || (err as { name?: string })?.name === "AbortError") return;
				setError(err instanceof Error ? err.message : t.marketplaceLoadError);
			} finally {
				if (!controller.signal.aborted && abortRef.current === controller) {
					setLoading(false);
				}
			}
		},
		[inspectItems, t.marketplaceLoadError],
	);

	useEffect(() => {
		const isRefresh = refreshSeq > prevRefreshSeqRef.current;
		prevRefreshSeqRef.current = refreshSeq;
		void fetchMarket(debouncedQuery, category, isRefresh);
		return () => {
			abortRef.current?.abort();
			inspectAbortRef.current?.abort();
		};
	}, [debouncedQuery, category, refreshSeq, fetchMarket]);

	const installedNames = useMemo(() => {
		const set = new Set<string>();
		for (const src of installedPackageSources) {
			const normalized = normalizeNpmPackageName(src);
			if (normalized) set.add(normalized);
		}
		return set;
	}, [installedPackageSources]);

	const formatBlocker = useCallback(
		(b: CompatibilityBlocker): string => {
			if (b.kind === "dsh_only") return t.marketplaceBlockerDshOnly;
			if (b.kind === "node_version") {
				return t.marketplaceBlockerNodeVersion
					.replace("{required}", b.required)
					.replace("{current}", b.current);
			}
			return t.marketplaceBlockerPiPeer
				.replace("{pkg}", b.pkg)
				.replace("{required}", b.required)
				.replace("{current}", b.current);
		},
		[t.marketplaceBlockerDshOnly, t.marketplaceBlockerNodeVersion, t.marketplaceBlockerPiPeer],
	);

	const formatCaveat = useCallback(
		(c: CompatibilityCaveat): string => {
			if (c.kind === "tui_peer") return t.marketplaceCaveatTui;
			if (c.kind === "themes_ignored") return t.marketplaceCaveatThemes;
			if (c.kind === "dsh_dual") return t.marketplaceCaveatDshDual;
			return t.marketplaceCaveatNoManifest;
		},
		[t.marketplaceCaveatDshDual, t.marketplaceCaveatNoManifest, t.marketplaceCaveatThemes, t.marketplaceCaveatTui],
	);

	const incompatibleCount = useMemo(
		() => items.filter((item) => compatMap[item.name]?.status === "incompatible").length,
		[items, compatMap],
	);

	const visibleItems = useMemo(() => {
		return items.filter((item) => {
			if (hideIncompatible && compatMap[item.name]?.status === "incompatible") return false;
			if (subTab === "discover") return true;
			const installed = installedNames.has(item.name.toLowerCase());
			return subTab === "installed" ? installed : !installed;
		});
	}, [items, subTab, installedNames, hideIncompatible, compatMap]);

	const { availableCount, installedCount } = useMemo(() => {
		let inst = 0;
		for (const item of items) {
			if (installedNames.has(item.name.toLowerCase())) inst += 1;
		}
		return { availableCount: items.length - inst, installedCount: inst };
	}, [items, installedNames]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex flex-wrap items-center gap-1" role="tablist">
					{(
						[
							{ id: "discover", label: t.marketplaceDiscover, count: items.length },
							{ id: "available", label: t.marketplaceAvailable, count: availableCount },
							{ id: "installed", label: t.marketplaceInstalled, count: installedCount },
						] as const
					).map((tab) => {
						const active = subTab === tab.id;
						return (
							<button
								key={tab.id}
								type="button"
								role="tab"
								aria-selected={active}
								onClick={() => setSubTab(tab.id)}
								className="rounded-lg transition-colors"
								style={{
									padding: "5px 11px",
									fontSize: 13,
									fontWeight: active ? 500 : 400,
									background: active ? "var(--dsw-active)" : "transparent",
									color: active ? "var(--dsw-label-primary)" : "var(--dsw-label-tertiary)",
								}}
							>
								<span>{tab.label}</span>
								{!loading && items.length > 0 && (
									<span className="ml-1.5 tabular-nums opacity-65" style={{ fontSize: 11.5 }}>
										{tab.count}
									</span>
								)}
							</button>
						);
					})}
				</div>

				<div className="ml-auto flex flex-wrap items-center gap-2">
					{installScope && onInstallScopeChange && (
						<div
							className="inline-flex items-center gap-1 rounded-lg p-0.5"
							style={{
								border: "0.5px solid var(--dsw-border-l2)",
								background: "var(--dsw-bg-elevated, transparent)",
							}}
							role="group"
							aria-label={t.marketInstallScopeLabel}
						>
							<span className="hidden pl-2 pr-1 sm:inline" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
								{t.marketInstallScopeLabel}
							</span>
							{(
								[
									{ id: "user", label: t.marketInstallScopeUser },
									{ id: "project", label: t.marketInstallScopeProject },
								] as const
							).map((opt) => {
								const selectedScope = installScope === opt.id;
								return (
									<button
										key={opt.id}
										type="button"
										aria-pressed={selectedScope}
										onClick={() => onInstallScopeChange(opt.id)}
										className="rounded-md transition-colors"
										style={{
											padding: "3px 9px",
											fontSize: 12,
											fontWeight: selectedScope ? 500 : 400,
											background: selectedScope ? "var(--dsw-active)" : "transparent",
											color: selectedScope ? "var(--dsw-label-primary)" : "var(--dsw-label-tertiary)",
										}}
									>
										{opt.label}
									</button>
								);
							})}
						</div>
					)}
					{installScopeControl}
					{!hideToolbarRefresh && (
						<>
							<span className="hidden sm:inline" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
								{t.marketplaceSourceNote}
							</span>
							<button
								type="button"
								className="icon-btn"
								style={{ width: 28, height: 28 }}
								title={t.panelRefresh}
								aria-label={t.panelRefresh}
								disabled={loading}
								onClick={() => void fetchMarket(searchInput.trim(), category, true)}
							>
								<IconRefreshOutline14 size={13} />
							</button>
						</>
					)}
				</div>
			</div>

			<div className="isx-search flex items-center gap-2.5 px-3.5" style={{ height: 38 }}>
				<IconSearchOutline16
					size={15}
					className="isx-search-icon flex-none"
					style={{ color: "var(--dsw-label-caption)" }}
				/>
				<input
					type="search"
					value={searchInput}
					onChange={(e) => setSearchInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							setDebouncedQuery(searchInput.trim());
						}
					}}
					placeholder={t.searchPlugins}
					aria-label={t.searchPlugins}
					className="w-full bg-transparent outline-none"
					style={{
						fontSize: 13,
						color: "var(--dsw-label-primary)",
					}}
				/>
			</div>

			<div className="flex flex-wrap items-center gap-1.5">
				{(
					[
						{ id: "all", label: t.marketplaceCatAll },
						{ id: "tools", label: t.marketplaceCatTools },
						{ id: "mcp", label: t.marketplaceCatMcp },
						{ id: "theme", label: t.marketplaceCatTheme },
						{ id: "context", label: t.marketplaceCatContext },
					] as const
				).map((cat) => {
					const active = category === cat.id;
					return (
						<button
							key={cat.id}
							type="button"
							aria-pressed={active}
							onClick={() => setCategory(cat.id)}
							className="rounded-lg transition-colors"
							style={{
								padding: "4px 10px",
								fontSize: 12,
								fontWeight: active ? 500 : 400,
								border: "0.5px solid var(--dsw-border-l2)",
								background: active ? "var(--dsw-active)" : "transparent",
								color: active ? "var(--dsw-label-primary)" : "var(--dsw-label-tertiary)",
							}}
						>
							{cat.label}
						</button>
					);
				})}
			</div>

			{(runtime || incompatibleCount > 0) && (
				<div className="flex flex-wrap items-center justify-between gap-2" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
					{runtime ? (
						<span>
							{t.marketplaceRuntimeBanner
								.replace("{pi}", runtime.piCodingAgent)
								.replace("{node}", runtime.node)}
						</span>
					) : (
						<span />
					)}
					{incompatibleCount > 0 && (
						<button
							type="button"
							aria-pressed={hideIncompatible}
							onClick={() => setHideIncompatible((prev) => !prev)}
							className="rounded-lg transition-colors"
							style={{
								padding: "3px 9px",
								fontSize: 11.5,
								fontWeight: hideIncompatible ? 500 : 400,
								border: "0.5px solid var(--dsw-border-l2)",
								background: hideIncompatible ? "var(--dsw-active)" : "transparent",
								color: hideIncompatible ? "var(--dsw-label-primary)" : "var(--dsw-label-tertiary)",
							}}
						>
							{t.marketplaceHideIncompatible} ({incompatibleCount})
						</button>
					)}
				</div>
			)}

			{error && (
				<div
					role="alert"
					className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3"
					style={{
						fontSize: 12.5,
						background: "color-mix(in srgb, var(--dsw-danger) 10%, transparent)",
						border: "0.5px solid color-mix(in srgb, var(--dsw-danger) 30%, transparent)",
						color: "var(--dsw-danger)",
					}}
				>
					<span>
						{t.marketplaceLoadError}: {error}
					</span>
					<button
						type="button"
						onClick={() => void fetchMarket(searchInput.trim(), category, true)}
						className="rounded-lg transition-opacity hover:opacity-85"
						style={{
							padding: "4px 10px",
							fontSize: 12,
							fontWeight: 500,
							border: "0.5px solid currentColor",
						}}
					>
						{t.marketplaceRetry}
					</button>
				</div>
			)}

			{loading && (
				<div className={twoColumns ? "grid grid-cols-1 gap-3 md:grid-cols-2" : "flex flex-col gap-2.5"}>
					{Array.from({ length: 4 }).map((_, idx) => (
						<div
							key={idx}
							className="animate-pulse rounded-lg p-4"
							style={{ border: "0.5px solid var(--dsw-border-l2)", height: 132, background: "var(--dsw-hover)" }}
						/>
					))}
				</div>
			)}

			{!loading && !error && visibleItems.length === 0 && (
				<div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
					<span
						className="flex items-center justify-center rounded-xl"
						style={{ width: 42, height: 42, background: "var(--dsw-hover)", color: "var(--dsw-label-caption)" }}
					>
						<IconPluginOutline16 size={20} />
					</span>
					<div style={{ fontSize: 13.5, color: "var(--dsw-label-tertiary)" }}>{t.marketplaceEmpty}</div>
				</div>
			)}

			{!loading && visibleItems.length > 0 && (
				<div className={twoColumns ? "grid grid-cols-1 gap-3 md:grid-cols-2" : "flex flex-col gap-2.5"}>
					{visibleItems.map((item) => {
						const installed = installedNames.has(item.name.toLowerCase());
						const marketKey = `market:${item.name}`;
						const installingThis = busyKey === marketKey;
						const tone = badgeToneForName(item.name);
						const compat = compatMap[item.name];
						const compatDetail = compat
							? compat.blockers.length > 0
								? formatBlocker(compat.blockers[0])
								: compat.caveats.length > 0
									? formatCaveat(compat.caveats[0])
									: undefined
							: undefined;
						const compatBadge = compat
							? compat.status === "compatible"
								? { label: t.marketplaceCompatCompatible, bg: "rgba(34, 197, 94, 0.12)", color: "var(--dsw-success)" }
								: compat.status === "partial"
									? { label: t.marketplaceCompatPartial, bg: "rgba(245, 158, 11, 0.14)", color: "#d97706" }
									: compat.status === "incompatible"
										? { label: t.marketplaceCompatIncompatible, bg: "rgba(239, 68, 68, 0.12)", color: "var(--dsw-danger)" }
										: { label: t.marketplaceCompatUnknown, bg: "var(--dsw-hover)", color: "var(--dsw-label-tertiary)" }
							: inspecting
								? { label: t.marketplaceCompatChecking, bg: "var(--dsw-hover)", color: "var(--dsw-label-caption)" }
								: null;

						const handleInstallClick = async () => {
							if (!(await confirm({ title: t.install, message: t.pluginInstallConfirm.replace("{source}", item.source), confirmLabel: t.install }))) return;
							if (compat?.status === "incompatible" && compat.blockers.length > 0) {
								const reason = compat.blockers.map(formatBlocker).join("; ");
								const ok = await confirm({
									title: t.marketplaceInstallForceTitle,
									message: t.marketplaceInstallForceDesc
										.replace("{name}", item.name)
										.replace("{reason}", reason),
									confirmLabel: t.marketplaceInstallForceConfirm,
									danger: true,
								});
								if (!ok) return;
							}
							onInstall(item.source, marketKey);
						};

						const resBadges = compat
							? [
									compat.resources.extensions ? t.marketplaceResExtensions : null,
									compat.resources.skills ? t.marketplaceResSkills : null,
									compat.resources.prompts ? t.marketplaceResPrompts : null,
									compat.resources.themes ? t.pluginTypeThemes : null,
								].filter((label): label is string => Boolean(label))
							: [];

						return (
							<div
								key={item.name}
								className="flex flex-col rounded-xl px-4 py-3.5 transition-colors hover:bg-[var(--dsw-hover)]"
								style={{
									border: "0.5px solid var(--dsw-border-l2)",
									background: "var(--dsw-bg-elevated, transparent)",
								}}
							>
								<div className="flex items-start gap-3">
									<div
										className="flex flex-none items-center justify-center rounded-lg"
										style={{ width: 36, height: 36, background: tone.bg, color: tone.color }}
									>
										<IconPluginOutline16 size={17} />
									</div>

									<div className="min-w-0 flex-1">
										<div className="flex items-start justify-between gap-2">
											<div className="min-w-0 flex-1">
												<div className="flex flex-wrap items-center gap-1.5">
													<span className="truncate font-semibold" style={{ fontSize: 14, color: "var(--dsw-label-primary)" }} title={item.name}>
														{item.name}
													</span>
													{compatBadge && (
														<span
															className="inline-flex flex-none items-center rounded-md px-1.5 py-0.5"
															title={compatDetail}
															style={{
																fontSize: 10.5,
																fontWeight: 500,
																background: compatBadge.bg,
																color: compatBadge.color,
															}}
														>
															{compatBadge.label}
														</span>
													)}
												</div>
												<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
													{item.author && <span className="truncate">{item.author}</span>}
													{item.version && <span>v{item.version}</span>}
													{item.monthlyDownloads !== null && (
														<span>
															↓ {formatDownloads(item.monthlyDownloads)}
															{t.marketplaceDownloadsSuffix}
														</span>
													)}
												</div>
											</div>

											{installed ? (
												<span
													className="inline-flex flex-none items-center gap-1 rounded-lg"
													style={{
														padding: "4px 10px",
														fontSize: 12,
														fontWeight: 500,
														background: "var(--dsw-active)",
														color: "var(--dsw-label-secondary)",
													}}
												>
													<IconCheckOutline14 size={12} />
													<span>{t.marketplaceInstalledBadge}</span>
												</span>
											) : (
												<button
													type="button"
													disabled={busy}
													onClick={() => void handleInstallClick()}
													className="flex-none rounded-lg transition-colors hover:opacity-90 disabled:opacity-45"
													style={{
														padding: "5px 12px",
														fontSize: 12.5,
														fontWeight: 500,
														border: "0.5px solid var(--dsw-border-l2)",
														background: "var(--dsw-hover)",
														color: compat?.status === "incompatible" ? "var(--dsw-label-tertiary)" : "var(--dsw-label-primary)",
													}}
												>
													{installingThis ? t.marketplaceInstalling : t.marketplaceInstallBtn}
												</button>
											)}
										</div>

										<p
											className="mt-2 line-clamp-2"
											style={{
												fontSize: 12.5,
												lineHeight: 1.5,
												color: "var(--dsw-label-secondary)",
												minHeight: twoColumns ? 38 : undefined,
											}}
											title={item.description}
										>
											{item.description || item.source}
										</p>
										{compatDetail && (
											<div
												className="mt-1.5 truncate"
												style={{
													fontSize: 11,
													color: compat?.status === "incompatible" ? "var(--dsw-danger)" : "var(--dsw-label-caption)",
												}}
												title={compatDetail}
											>
												{compatDetail}
											</div>
										)}
									</div>
								</div>

								{(resBadges.length > 0 || item.keywords.length > 0 || item.repoUrl || item.npmUrl) && (
									<div className="hairline-t mt-3 flex flex-wrap items-center justify-between gap-2 pt-2.5">
										<div className="flex flex-wrap items-center gap-1.5">
											{resBadges.map((label) => (
												<span
													key={label}
													className="rounded-md px-1.5 py-0.5"
													style={{
														fontSize: 10.5,
														fontWeight: 500,
														border: "0.5px solid var(--dsw-border-l2)",
														background: "var(--dsw-active)",
														color: "var(--dsw-label-secondary)",
													}}
												>
													{label}
												</span>
											))}
											{item.keywords.slice(0, 3).map((kw) => (
												<span
													key={kw}
													className="rounded-full px-2 py-0.5"
													style={{
														fontSize: 10.5,
														background: "var(--dsw-hover)",
														color: "var(--dsw-label-tertiary)",
													}}
												>
													{kw}
												</span>
											))}
										</div>
										<div className="flex items-center gap-2.5" style={{ fontSize: 11.5 }}>
											{item.repoUrl && (
												<a
													href={item.repoUrl}
													target="_blank"
													rel="noreferrer"
													className="transition-opacity hover:opacity-80"
													style={{ color: "var(--dsw-label-tertiary)" }}
												>
													{t.marketplaceViewRepo}
												</a>
											)}
											{item.npmUrl && (
												<a
													href={item.npmUrl}
													target="_blank"
													rel="noreferrer"
													className="transition-opacity hover:opacity-80"
													style={{ color: "var(--dsw-label-tertiary)" }}
												>
													{t.marketplaceViewNpm}
												</a>
											)}
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
			{confirmDialog}
		</div>
	);
}
