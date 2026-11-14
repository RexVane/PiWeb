"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FloatingToast, type FloatingToastState } from "@/components/FloatingToast";
import {
	IconFileOutline16,
	IconMarketOutline16,
	IconPluginOutline16,
	IconPromptOutline16,
	IconRefreshOutline14,
	IconSearchOutline16,
	IconSkillOutline16,
} from "@/components/icons";
import { PluginMarketplace } from "@/components/settings/PluginMarketplace";
import { PluginsSection } from "@/components/settings/PluginsSection";
import { SkillsSection } from "@/components/settings/SkillsSection";
import { SelectOption } from "@/components/settings/SharedControls";
import { useI18n } from "@/i18n";
import type { MarketplaceCategory } from "@/lib/plugins-marketplace";
import { WorkspaceViewShell } from "./WorkspaceViewShell";

function useScopedWorkspace(knownCwds: string[], defaultCwd: string, getWorkspaceName: (cwd: string) => string) {
	const [selectedCwd, setSelectedCwd] = useState(defaultCwd || knownCwds[0] || "");

	useEffect(() => {
		if (!selectedCwd && (defaultCwd || knownCwds[0])) {
			setSelectedCwd(defaultCwd || knownCwds[0] || "");
		}
	}, [selectedCwd, defaultCwd, knownCwds]);

	const workspaceOptions = useMemo(
		() => knownCwds.map((c) => ({ value: c, label: getWorkspaceName(c) || c })),
		[knownCwds, getWorkspaceName],
	);

	const activeCwd = selectedCwd || defaultCwd || knownCwds[0] || "";
	return { activeCwd, setSelectedCwd, workspaceOptions };
}

export function SkillsWorkspaceView({
	knownCwds,
	defaultCwd,
	getWorkspaceName,
	onOpenFileContent,
}: {
	knownCwds: string[];
	defaultCwd: string;
	getWorkspaceName: (cwd: string) => string;
	onOpenFileContent?: (path: string, content: string) => void;
}) {
	const { t } = useI18n();
	const { activeCwd, setSelectedCwd, workspaceOptions } = useScopedWorkspace(knownCwds, defaultCwd, getWorkspaceName);
	const [reloadSeq, setReloadSeq] = useState(0);

	return (
		<WorkspaceViewShell
			title={t.navSkills}
			description={t.skillsDesc}
			icon={<IconSkillOutline16 size={16} />}
			actions={
				<button
					type="button"
					className="icon-btn"
					title={t.panelRefresh}
					aria-label={t.panelRefresh}
					onClick={() => setReloadSeq((n) => n + 1)}
					style={{ width: 32, height: 32 }}
				>
					<IconRefreshOutline14 size={14} />
				</button>
			}
		>
			<SkillsSection
				cwd={activeCwd}
				onOpenFileContent={onOpenFileContent}
				hideDesc
				reloadSeq={reloadSeq}
				workspaceOptions={workspaceOptions}
				onCwdChange={setSelectedCwd}
			/>
		</WorkspaceViewShell>
	);
}

type PromptOriginValue = { scope?: string; name?: string } | string | undefined;
type PromptItem = {
	kind: string;
	name: string;
	path?: string;
	origin?: PromptOriginValue;
	bytes?: number;
};
type PromptFilter = "all" | "rules" | "skill" | "template";

function formatPromptBytes(bytes?: number): string | null {
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PromptsWorkspaceView({
	knownCwds,
	defaultCwd,
	getWorkspaceName,
	onOpenFileContent,
}: {
	knownCwds: string[];
	defaultCwd: string;
	getWorkspaceName: (cwd: string) => string;
	onOpenFileContent?: (path: string, content: string) => void;
}) {
	const { t } = useI18n();
	const { activeCwd, setSelectedCwd, workspaceOptions } = useScopedWorkspace(knownCwds, defaultCwd, getWorkspaceName);
	const [prompts, setPrompts] = useState<PromptItem[]>([]);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [reloadSeq, setReloadSeq] = useState(0);
	const [query, setQuery] = useState("");
	const [kindFilter, setKindFilter] = useState<PromptFilter>("all");
	const [openingPath, setOpeningPath] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError("");
		void (async () => {
			try {
				const q = `?cwd=${encodeURIComponent(activeCwd)}`;
				const promptResult = await fetch(`/api/prompts${q}`, { cache: "no-store" }).then((r) => r.json());
				if (!alive) return;
				if (promptResult?.success) setPrompts(promptResult.data?.sources ?? []);
				else setError(promptResult?.error ?? "");
			} catch (err) {
				if (alive) setError(err instanceof Error ? err.message : t.toastError);
			} finally {
				if (alive) setLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [activeCwd, reloadSeq, t.toastError]);

	const openPrompt = async (path: string | undefined) => {
		if (!path || !onOpenFileContent || openingPath) return;
		setOpeningPath(path);
		try {
			const response = await fetch("/api/prompts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "read", filePath: path, cwd: activeCwd }),
			});
			const result = await response.json();
			if (result?.success) onOpenFileContent(path, result.data.content);
			else setError(result?.error ?? t.toastError);
		} catch (err) {
			setError(err instanceof Error ? err.message : t.toastError);
		} finally {
			setOpeningPath(null);
		}
	};

	const originInfoOf = useCallback(
		(origin: PromptOriginValue) => {
			const scope = typeof origin === "string" ? origin : origin?.scope;
			const originName = typeof origin === "object" ? origin?.name : undefined;
			if (scope === "project") return { label: t.promptOriginProject, color: "#60a5fa", bg: "rgba(59, 130, 246, 0.12)", dashed: false };
			if (scope === "agent") return { label: t.promptOriginAgent, color: "var(--dsw-label-secondary)", bg: "var(--dsw-hover)", dashed: false };
			if (scope === "package") {
				return {
					label: originName ? `${t.promptOriginPackage}: ${originName}` : t.promptOriginPackage,
					color: "#a78bfa",
					bg: "rgba(139, 92, 246, 0.12)",
					dashed: true,
				};
			}
			if (scope === "extension") {
				return {
					label: originName ? `${t.promptOriginExtension}: ${originName}` : t.promptOriginExtension,
					color: "#2dd4bf",
					bg: "rgba(20, 184, 166, 0.12)",
					dashed: true,
				};
			}
			return null;
		},
		[t.promptOriginAgent, t.promptOriginExtension, t.promptOriginPackage, t.promptOriginProject],
	);

	const kindInfoOf = useCallback(
		(kind: string) => {
			if (kind === "agents") return { label: t.promptKindAgents, color: "#60a5fa", bg: "rgba(59, 130, 246, 0.14)", group: "rules" as const };
			if (kind === "system") return { label: t.promptKindSystem, color: "#a78bfa", bg: "rgba(139, 92, 246, 0.14)", group: "rules" as const };
			if (kind === "append") return { label: t.promptKindAppend, color: "#c084fc", bg: "rgba(192, 132, 252, 0.14)", group: "rules" as const };
			if (kind === "skill") return { label: t.promptKindSkill, color: "#34d399", bg: "rgba(16, 185, 129, 0.14)", group: "skill" as const };
			if (kind === "template") return { label: t.promptKindTemplate, color: "#f59e0b", bg: "rgba(245, 158, 11, 0.14)", group: "template" as const };
			return { label: kind, color: "var(--dsw-label-secondary)", bg: "var(--dsw-hover)", group: "rules" as const };
		},
		[t.promptKindAgents, t.promptKindAppend, t.promptKindSkill, t.promptKindSystem, t.promptKindTemplate],
	);

	const counts = useMemo(() => {
		let rules = 0;
		let skill = 0;
		let template = 0;
		for (const p of prompts) {
			const group = kindInfoOf(p.kind).group;
			if (group === "rules") rules += 1;
			else if (group === "skill") skill += 1;
			else if (group === "template") template += 1;
		}
		return { all: prompts.length, rules, skill, template };
	}, [prompts, kindInfoOf]);

	const filteredPrompts = useMemo(() => {
		const trimmed = query.trim().toLowerCase();
		return prompts.filter((p) => {
			const kindInfo = kindInfoOf(p.kind);
			if (kindFilter !== "all" && kindInfo.group !== kindFilter) return false;
			if (!trimmed) return true;
			const originLabel = originInfoOf(p.origin)?.label ?? "";
			return `${p.name} ${p.path ?? ""} ${kindInfo.label} ${originLabel}`.toLowerCase().includes(trimmed);
		});
	}, [prompts, query, kindFilter, kindInfoOf, originInfoOf]);

	return (
		<WorkspaceViewShell
			title={t.navPrompts}
			description={t.promptsPageDesc}
			icon={<IconPromptOutline16 size={16} />}
			cwd={activeCwd}
			onCwdChange={setSelectedCwd}
			workspaceOptions={workspaceOptions}
			actions={
				<button
					type="button"
					className="btn-outline"
					style={{ height: 32, padding: "0 12px", fontSize: 13 }}
					disabled={loading}
					onClick={() => setReloadSeq((n) => n + 1)}
				>
					<IconRefreshOutline14 size={13} /> {t.panelRefresh}
				</button>
			}
		>
			<div className="flex flex-col gap-6">
				{error && (
					<div
						role="alert"
						className="rounded-lg px-3.5 py-2.5"
						style={{
							fontSize: 12.5,
							background: "color-mix(in srgb, var(--dsw-danger) 10%, transparent)",
							border: "0.5px solid color-mix(in srgb, var(--dsw-danger) 30%, transparent)",
							color: "var(--dsw-danger)",
						}}
					>
						{error}
					</div>
				)}

				<section className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="flex items-center gap-2" style={{ paddingLeft: 2 }}>
							<h2 style={{ fontSize: 13, fontWeight: 500, color: "var(--dsw-label-secondary)" }}>{t.promptsSection}</h2>
							{!loading && prompts.length > 0 && (
								<span className="tabular-nums" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
									{prompts.length}
								</span>
							)}
						</div>
					</div>

					{!loading && prompts.length > 0 && (
						<>
							<div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t.promptsSection}>
								{(
									[
										{ id: "all", label: t.promptsFilterAll, count: counts.all },
										{ id: "rules", label: t.promptsFilterRules, count: counts.rules },
										{ id: "skill", label: t.promptsFilterSkills, count: counts.skill },
										{ id: "template", label: t.promptsFilterTemplates, count: counts.template },
									] as const
								).map((tab) => {
									const active = kindFilter === tab.id;
									return (
										<button
											key={tab.id}
											type="button"
											role="tab"
											aria-selected={active}
											onClick={() => setKindFilter(tab.id)}
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
											<span className="ml-1.5 tabular-nums opacity-70" style={{ fontSize: 11.5 }}>
												{tab.count}
											</span>
										</button>
									);
								})}
							</div>

							<div className="isx-search flex items-center gap-2.5 px-3.5" style={{ height: 38 }}>
								<IconSearchOutline16 size={15} className="isx-search-icon flex-none" style={{ color: "var(--dsw-label-caption)" }} />
								<input
									type="search"
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder={t.promptsSearchPlaceholder}
									aria-label={t.promptsSearchPlaceholder}
									className="w-full bg-transparent outline-none"
									style={{ fontSize: 13, color: "var(--dsw-label-primary)" }}
								/>
							</div>
						</>
					)}

					{loading && prompts.length === 0 && (
						<div className="flex flex-col gap-2" aria-busy="true" aria-label={t.promptsLoading}>
							{Array.from({ length: 4 }).map((_, idx) => (
								<div
									key={idx}
									className="animate-pulse rounded-xl"
									style={{ height: 56, background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)" }}
								/>
							))}
						</div>
					)}

					{!loading && prompts.length === 0 && (
						<div
							className="rounded-xl px-4 py-4"
							style={{
								fontSize: 12.5,
								color: "var(--dsw-label-tertiary)",
								border: "0.5px dashed var(--dsw-border-l2)",
								background: "var(--dsw-bg-elevated, transparent)",
							}}
						>
							{t.promptsEmpty}
						</div>
					)}

					{!loading && prompts.length > 0 && filteredPrompts.length === 0 && (
						<div
							className="rounded-xl px-4 py-4"
							style={{
								fontSize: 12.5,
								color: "var(--dsw-label-tertiary)",
								border: "0.5px dashed var(--dsw-border-l2)",
								background: "var(--dsw-bg-elevated, transparent)",
							}}
						>
							{t.promptsNoMatch}
						</div>
					)}

					{filteredPrompts.length > 0 && (
						<div
							className="overflow-hidden rounded-xl"
							style={{ border: "0.5px solid var(--dsw-border-l2)", background: "var(--dsw-bg-elevated, transparent)" }}
						>
							{filteredPrompts.map((prompt, idx) => {
								const kindInfo = kindInfoOf(prompt.kind);
								const originInfo = originInfoOf(prompt.origin);
								const sizeText = formatPromptBytes(prompt.bytes);
								const canOpen = Boolean(prompt.path && onOpenFileContent);
								const rowBody = (
									<>
										<div
											className="flex h-9 w-9 flex-none items-center justify-center rounded-lg"
											style={{ background: kindInfo.bg, color: kindInfo.color }}
										>
											<IconFileOutline16 size={16} />
										</div>
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-1.5">
												<span className="truncate" style={{ fontSize: 13.5, fontWeight: 500, color: "var(--dsw-label-primary)" }}>
													{prompt.name}
												</span>
												<span
													className="rounded-md px-1.5 py-0.5"
													style={{ fontSize: 10.5, fontWeight: 500, background: kindInfo.bg, color: kindInfo.color }}
												>
													{kindInfo.label}
												</span>
												{originInfo && (
													<span
														className="rounded-md px-1.5 py-0.5"
														style={{
															fontSize: 10.5,
															background: originInfo.bg,
															color: originInfo.color,
															border: originInfo.dashed ? "0.5px dashed var(--dsw-border-l2)" : undefined,
														}}
													>
														{originInfo.label}
													</span>
												)}
											</div>
											{prompt.path && (
												<div
													className="mt-0.5 truncate"
													style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--dsw-label-caption)" }}
													title={prompt.path}
												>
													{prompt.path}
												</div>
											)}
										</div>
										<div className="flex flex-none items-center gap-2.5">
											{sizeText && (
												<span className="tabular-nums" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
													{sizeText}
												</span>
											)}
											{canOpen && (
												<span
													className="rounded-md px-2 py-0.5 opacity-80 transition-opacity group-hover:opacity-100"
													style={{
														fontSize: 11.5,
														color: "var(--dsw-label-secondary)",
														border: "0.5px solid var(--dsw-border-l2)",
														background: "var(--dsw-hover)",
													}}
												>
													{openingPath === prompt.path ? t.promptsLoading : t.promptsViewFile}
												</span>
											)}
										</div>
									</>
								);

								const rowKey = `${prompt.kind}:${prompt.path ?? prompt.name}:${idx}`;
								const borderTopStyle = idx > 0 ? { borderTop: "0.5px solid var(--dsw-border-l1)" } : undefined;
								if (!canOpen) {
									return (
										<div
											key={rowKey}
											title={t.promptsNoPathHint}
											className="flex items-center gap-3.5 px-3.5 py-2.5"
											style={borderTopStyle}
										>
											{rowBody}
										</div>
									);
								}
								return (
									<button
										key={rowKey}
										type="button"
										disabled={openingPath === prompt.path}
										onClick={() => void openPrompt(prompt.path)}
										className="group flex w-full items-center gap-3.5 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--dsw-hover)] disabled:opacity-60"
										style={borderTopStyle}
									>
										{rowBody}
									</button>
								);
							})}
						</div>
					)}
				</section>

			</div>
		</WorkspaceViewShell>
	);
}

export function MarketWorkspaceView({
	knownCwds,
	defaultCwd,
	getWorkspaceName,
	initialCategory = "all",
}: {
	knownCwds: string[];
	defaultCwd: string;
	getWorkspaceName: (cwd: string) => string;
	initialCategory?: MarketplaceCategory;
}) {
	const { t } = useI18n();
	const { activeCwd, setSelectedCwd, workspaceOptions } = useScopedWorkspace(knownCwds, defaultCwd, getWorkspaceName);
	const [installed, setInstalled] = useState<string[]>([]);
	const [installScope, setInstallScope] = useState<"user" | "project">("user");
	const [busy, setBusy] = useState(false);
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [marketLoading, setMarketLoading] = useState(true);
	const [reloadSeq, setReloadSeq] = useState(0);
	const [toast, setToast] = useState<FloatingToastState | null>(null);
	const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const installedRequestRef = useRef(0);

	useEffect(() => {
		return () => {
			if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		};
	}, []);

	const showToast = useCallback((next: FloatingToastState, durationMs?: number) => {
		if (toastTimerRef.current) {
			clearTimeout(toastTimerRef.current);
			toastTimerRef.current = null;
		}
		setToast(next);
		if (durationMs && durationMs > 0) {
			toastTimerRef.current = setTimeout(() => {
				setToast(null);
				toastTimerRef.current = null;
			}, durationMs);
		}
	}, []);

	const loadInstalled = useCallback(async () => {
		const request = ++installedRequestRef.current;
		try {
			const response = await fetch(`/api/plugins?cwd=${encodeURIComponent(activeCwd)}`, { cache: "no-store" });
			const result = await response.json();
			if (request === installedRequestRef.current && result?.success) {
				setInstalled((result.data?.packages ?? []).map((pkg: { source: string }) => pkg.source));
			}
		} catch {
			/* 市场自己会展示加载失败 */
		}
	}, [activeCwd]);

	useEffect(() => {
		setInstalled([]);
		void loadInstalled();
		return () => { installedRequestRef.current += 1; };
	}, [loadInstalled, reloadSeq]);

	const install = async (source: string, itemKey: string) => {
		if (busy) return;
		setBusy(true);
		setBusyKey(itemKey);
		showToast({ ok: true, msg: t.installing, loading: true });
		try {
			const response = await fetch("/api/plugins", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "install",
					source,
					local: installScope === "project",
					cwd: activeCwd,
				}),
			});
			const result = await response.json();
			if (!response.ok || !result?.success) {
				showToast({ ok: false, msg: result?.error || `HTTP ${response.status}` }, 5000);
				return;
			}
			await loadInstalled();
			showToast({ ok: !result.data?.warning, msg: result.data?.warning || t.installSuccess }, result.data?.warning ? 0 : 3200);
		} catch (err) {
			showToast({ ok: false, msg: err instanceof Error ? err.message : t.toastError }, 5000);
		} finally {
			setBusy(false);
			setBusyKey(null);
		}
	};

	return (
		<WorkspaceViewShell
			title={t.navMarket}
			description={t.marketPageDesc}
			icon={<IconMarketOutline16 size={16} />}
			actions={
				<button
					type="button"
					className="btn-outline"
					style={{ height: 32, padding: "0 12px", fontSize: 13 }}
					disabled={busy || marketLoading}
					onClick={() => setReloadSeq((n) => n + 1)}
				>
					<IconRefreshOutline14 size={13} /> {t.panelRefresh}
				</button>
			}
		>
			<FloatingToast toast={toast} />
			<PluginMarketplace
				installedPackageSources={installed}
				busy={busy}
				busyKey={busyKey}
				twoColumns
				initialCategory={initialCategory}
				refreshSeq={reloadSeq}
				hideToolbarRefresh
				onLoadingChange={setMarketLoading}
				installScope={installScope}
				onInstallScopeChange={setInstallScope}
				installScopeControl={
					installScope === "project" && workspaceOptions.length > 0 ? (
						<SelectOption
							value={activeCwd}
							label={t.workspaceScope}
							options={workspaceOptions}
							onChange={setSelectedCwd}
							width={180}
						/>
					) : null
				}
				onInstall={(source, itemKey) => void install(source, itemKey)}
			/>
		</WorkspaceViewShell>
	);
}

export function PluginsWorkspaceView({
	knownCwds,
	defaultCwd,
	getWorkspaceName,
	onOpenMarket,
}: {
	knownCwds: string[];
	defaultCwd: string;
	getWorkspaceName: (cwd: string) => string;
	onOpenMarket?: () => void;
}) {
	const { t } = useI18n();
	const { activeCwd, setSelectedCwd, workspaceOptions } = useScopedWorkspace(knownCwds, defaultCwd, getWorkspaceName);
	const [installOpen, setInstallOpen] = useState(false);
	const [reloadSeq, setReloadSeq] = useState(0);
	const [reloadBusy, setReloadBusy] = useState(false);

	return (
		<WorkspaceViewShell
			title={t.navPlugins}
			description={t.pluginPageDesc}
			icon={<IconPluginOutline16 size={16} />}
			actions={
				<div className="flex items-center gap-2">
					<button
						type="button"
						className="btn-outline"
						style={{ height: 32, padding: "0 12px", fontSize: 13 }}
						disabled={reloadBusy}
						onClick={() => setReloadSeq((n) => n + 1)}
					>
						<IconRefreshOutline14 size={13} /> {t.panelRefresh}
					</button>
					<button
						type="button"
						className="btn-primary-white"
						style={{ height: 32, padding: "0 14px", fontSize: 13 }}
						onClick={() => setInstallOpen(true)}
					>
						+ {t.addPluginAction}
					</button>
				</div>
			}
		>
			<PluginsSection
				cwd={activeCwd}
				hideHeader
				installOpen={installOpen}
				onInstallOpenChange={setInstallOpen}
				reloadSeq={reloadSeq}
				onReloadBusyChange={setReloadBusy}
				onOpenMarket={onOpenMarket}
				workspaceOptions={workspaceOptions}
				onCwdChange={setSelectedCwd}
			/>
		</WorkspaceViewShell>
	);
}
