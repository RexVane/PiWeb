"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { FloatingToast } from "@/components/FloatingToast";
import {
	IconChevronDown14,
	IconCloseOutline14,
	IconDatabaseOutline16,
	IconPluginOutline16,
	IconRefreshOutline14,
	IconSearchOutline16,
	IconTerminalOutline14,
} from "@/components/icons";
import { useDialog } from "@/hooks/useDialog";
import { useI18n } from "@/i18n";
import { ScopeWorkspaceFilterBar } from "@/components/settings/SharedControls";
import type { PluginResourceType } from "@/lib/plugins-service";

// ---------- Plugins ----------

interface PackageItem {
	source: string;
	scope: "user" | "project";
	installedPath?: string;
	resources: { extensions: number; skills: number; prompts: number; themes: number };
	/** 服务端按资源计数算出的类型标签（扩展/技能/提示词/主题） */
	types?: PluginResourceType[];
	disabled?: boolean;
}

type PluginScope = "user" | "project" | "temporary";
type PluginOrigin = "builtin" | "top-level" | "package";

interface ExtensionItem {
	name: string;
	path: string;
	disabled?: boolean;
	error?: string;
	/** 服务端算好的作用域/来源；缺失时由界面兜底推断 */
	scope?: PluginScope;
	origin?: PluginOrigin;
	sourceInfo?: { source: string; scope: PluginScope; origin: "package" | "top-level" };
}

interface BuiltinMeta {
	title: string;
	description: string;
	iconBg: string;
	iconColor: string;
	icon: ReactNode;
}

function IconCodemode18() {
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
			<path d="M5 17l.9 2.1L8 20l-2.1.9L5 23l-.9-2.1L2 20l2.1-.9L5 17z" />
			<path d="M19 14l.7 1.6L21.3 16.3l-1.6.7L19 18.6l-.7-1.6-1.6-.7 1.6-.7L19 14z" />
		</svg>
	);
}

function IconMcpPlug18() {
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 22v-5" />
			<path d="M9 8V2" />
			<path d="M15 8V2" />
			<path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
		</svg>
	);
}

function PluginRow({
	icon,
	iconBg,
	iconColor,
	title,
	badges,
	subtitle,
	subtitleError,
	expandable,
	expanded,
	borderedTop = false,
	onToggleExpand,
	details,
	controls,
}: {
	icon: ReactNode;
	iconBg: string;
	iconColor: string;
	title: string;
	badges?: ReactNode;
	subtitle?: string;
	subtitleError?: boolean;
	expandable?: boolean;
	expanded?: boolean;
	borderedTop?: boolean;
	onToggleExpand?: () => void;
	details?: ReactNode;
	controls?: ReactNode;
}) {
	return (
		<div
			className="transition-colors"
			style={{
				borderTop: borderedTop ? "0.5px solid var(--dsw-border-l1)" : undefined,
				background: expanded ? "var(--dsw-hover)" : "transparent",
			}}
		>
			<div
				className={`flex items-center gap-3.5 transition-colors hover:bg-[var(--dsw-hover)] ${expandable ? "cursor-pointer" : ""}`}
				style={{ padding: "11px 14px" }}
				onClick={expandable ? onToggleExpand : undefined}
			>
				<div
					className="flex h-9 w-9 flex-none items-center justify-center rounded-lg"
					style={{ borderRadius: 8, background: iconBg, color: iconColor }}
				>
					{icon}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--dsw-label-primary)" }}>{title}</span>
						{badges}
					</div>
					{subtitle && (
						<div
							className="mt-0.5 truncate"
							style={{
								fontSize: 12,
								color: subtitleError ? "var(--dsw-danger)" : "var(--dsw-label-tertiary)",
							}}
							title={subtitle}
						>
							{subtitle}
						</div>
					)}
				</div>
				<div className="flex flex-none items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
					{controls}
					{expandable && (
						<button
							type="button"
							className="icon-btn"
							style={{ width: 26, height: 26, borderRadius: 8 }}
							aria-expanded={expanded}
							onClick={onToggleExpand}
						>
							<span
								className="inline-flex"
								style={{
									color: "var(--dsw-label-tertiary)",
									transform: expanded ? "rotate(180deg)" : "none",
									transition: "transform 140ms var(--ds-ease-in-out)",
								}}
							>
								<IconChevronDown14 size={14} />
							</span>
						</button>
					)}
				</div>
			</div>
			{expanded && details && (
				<div
					className="hairline-t flex flex-col gap-1.5"
					style={{ padding: "10px 14px 12px 62px", fontSize: 12, color: "var(--dsw-label-secondary)" }}
				>
					{details}
				</div>
			)}
		</div>
	);
}

function AddPluginModal({
	open,
	cwd,
	source,
	setSource,
	local,
	setLocal,
	busy,
	onClose,
	onSubmit,
}: {
	open: boolean;
	cwd: string;
	source: string;
	setSource: (v: string) => void;
	local: boolean;
	setLocal: (v: boolean) => void;
	busy: boolean;
	onClose: () => void;
	onSubmit: () => void;
}) {
	const { t } = useI18n();
	const dialogRef = useRef<HTMLDivElement>(null);
	const titleId = useId();
	useDialog({ open, onClose: () => { if (!busy) onClose(); }, ref: dialogRef });

	if (!open) return null;

	return (
		<div
			className="modal-mask fixed inset-0 z-[110] flex items-center justify-center p-4"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget && !busy) onClose();
			}}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				className="glass-modal w-full overflow-hidden"
				style={{
					maxWidth: 480,
					borderRadius: "var(--pw-radius-modal)",
					boxShadow: "var(--pw-shadow-modal)",
				}}
			>
				<div className="hairline-b flex items-center justify-between px-5 py-3.5">
					<h2 id={titleId} style={{ fontSize: 15, fontWeight: 600, color: "var(--dsw-label-primary)" }}>
						{t.addPackage}
					</h2>
					<button type="button" className="icon-btn" aria-label={t.close} disabled={busy} onClick={onClose}>
						<IconCloseOutline14 size={14} />
					</button>
				</div>
				<form
					className="flex flex-col gap-4 p-5"
					onSubmit={(e) => {
						e.preventDefault();
						if (source.trim() && !busy) onSubmit();
					}}
				>
					<div className="flex flex-col gap-1.5">
						<input
							autoFocus
							value={source}
							onChange={(e) => setSource(e.target.value)}
							placeholder={t.addPackagePlaceholder}
							className="w-full rounded-lg outline-none"
							style={{
								borderRadius: 8,
								padding: "9px 12px",
								fontSize: 13,
								background: "var(--dsw-hover)",
								border: "0.5px solid var(--dsw-border-l2)",
								color: "var(--dsw-label-primary)",
								fontFamily: "var(--font-mono)",
							}}
						/>
					</div>
					<label className="flex cursor-pointer items-center gap-2 select-none" style={{ fontSize: 12.5, color: "var(--dsw-label-secondary)" }}>
						<input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} disabled={!cwd || busy} />
						{t.installLocal}
					</label>
					<div className="flex items-center justify-end gap-2 pt-1">
						<button
							type="button"
							className="btn-outline"
							style={{ height: 32, padding: "0 14px", fontSize: 13 }}
							disabled={busy}
							onClick={onClose}
						>
							{t.cancel}
						</button>
						<button
							type="submit"
							className="btn-primary-white"
							style={{ height: 32, padding: "0 16px", fontSize: 13 }}
							disabled={!source.trim() || busy}
						>
							{busy ? t.installing : t.install}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

/** 导出仅供测试与工作区插件页复用 */
export function PluginsSection({
	cwd,
	hideHeader = false,
	installOpen,
	onInstallOpenChange,
	reloadSeq = 0,
	onReloadBusyChange,
	workspaceOptions,
	onCwdChange,
}: {
	cwd: string;
	hideHeader?: boolean;
	installOpen?: boolean;
	onInstallOpenChange?: (open: boolean) => void;
	reloadSeq?: number;
	onReloadBusyChange?: (busy: boolean) => void;
	/** 切到「项目」页签时用来切换工作区 */
	workspaceOptions?: { value: string; label: string }[];
	onCwdChange?: (cwd: string) => void;
}) {
	const { t, lang } = useI18n();
	const { confirm, confirmDialog } = useConfirmDialog();
	const confirmUninstall = async (src: string) => {
		const workspaceSeq = workspaceSeqRef.current;
		const confirmed = await confirm({ title: t.uninstall, message: t.confirmUninstallPackage.replace("{source}", src), confirmLabel: t.uninstall });
		return confirmed && workspaceSeq === workspaceSeqRef.current;
	};

	const [packages, setPackages] = useState<PackageItem[]>([]);
	const [extensions, setExtensions] = useState<ExtensionItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [scopeFilter, setScopeFilter] = useState<"all" | PluginScope>("all");
	const [q, setQ] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [internalInstallOpen, setInternalInstallOpen] = useState(false);
	const [source, setSource] = useState("");
	const [local, setLocal] = useState(false);
	const [busy, setBusy] = useState(false);
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [toast, setToast] = useState<{ ok: boolean; msg: string; loading?: boolean } | null>(null);
	const busyRef = useRef(false);
	const workspaceSeqRef = useRef(0);
	const loadSeqRef = useRef(0);
	const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const modalOpen = installOpen ?? internalInstallOpen;
	const setModalOpen = onInstallOpenChange ?? setInternalInstallOpen;

	const load = useCallback(async () => {
		const workspaceSeq = workspaceSeqRef.current;
		const loadSeq = ++loadSeqRef.current;
		try {
			const r = await fetch(`/api/plugins${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
			const j = await r.json();
			if (workspaceSeq !== workspaceSeqRef.current || loadSeq !== loadSeqRef.current) return;
			if (j.success) {
				setPackages(j.data.packages ?? []);
				setExtensions(j.data.extensions ?? []);
			} else setToast({ ok: false, msg: j.error || t.toastError });
		} catch (err: unknown) {
			if (workspaceSeq === workspaceSeqRef.current && loadSeq === loadSeqRef.current) {
				setToast({ ok: false, msg: err instanceof Error ? err.message : t.toastError });
			}
		} finally {
			if (workspaceSeq === workspaceSeqRef.current && loadSeq === loadSeqRef.current) {
				setLoading(false);
			}
		}
	}, [cwd, t.toastError]);

	useEffect(() => {
		workspaceSeqRef.current += 1;
		busyRef.current = false;
		setPackages([]);
		setExtensions([]);
		setLoading(true);
		setExpanded(new Set());
		setToast(null);
		setBusy(false);
		setBusyKey(null);
		onReloadBusyChange?.(false);
		return () => {
			workspaceSeqRef.current += 1;
			loadSeqRef.current += 1;
			if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		};
	}, [cwd, onReloadBusyChange]);

	useEffect(() => {
		void load();
	}, [load]);

	const notify = useCallback(
		(ok: boolean, msg?: string) => {
			if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
			setToast({ ok, msg: msg ?? (ok ? t.toastSaved : t.toastError), loading: false });
			toastTimerRef.current = setTimeout(() => setToast(null), 2600);
		},
		[t.toastError, t.toastSaved],
	);

	const handleReload = useCallback(async () => {
		if (busyRef.current) return;
		const workspaceSeq = workspaceSeqRef.current;
		loadSeqRef.current += 1;
		busyRef.current = true;
		setBusy(true);
		onReloadBusyChange?.(true);
		try {
			const r = await fetch("/api/plugins", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "reload", cwd }),
			});
			const j = await r.json();
			if (workspaceSeq !== workspaceSeqRef.current) return;
			notify(
				j.success,
				j.success
					? t.reloadedSessions.replace("{loaders}", String(j.data?.loaders ?? 0)).replace("{sessions}", String(j.data?.sessions ?? 0))
					: j.error,
			);
			if (j.success) await load();
		} catch (e: any) {
			if (workspaceSeq === workspaceSeqRef.current) notify(false, e?.message ?? t.toastError);
		} finally {
			if (workspaceSeq === workspaceSeqRef.current) {
				busyRef.current = false;
				setBusy(false);
				onReloadBusyChange?.(false);
			}
		}
	}, [cwd, load, notify, onReloadBusyChange, t.reloadedSessions, t.toastError]);

	const lastReloadSeqRef = useRef(reloadSeq);
	useEffect(() => {
		if (reloadSeq !== lastReloadSeqRef.current) {
			lastReloadSeqRef.current = reloadSeq;
			void handleReload();
		}
	}, [reloadSeq, handleReload]);

	const act = async (
		action: string,
		payload: Record<string, unknown> = {},
		itemKey?: string,
		loadingMsg?: string,
		successMsg?: string,
	) => {
		if (busyRef.current) return false;
		const workspaceSeq = workspaceSeqRef.current;
		loadSeqRef.current += 1;
		busyRef.current = true;
		setBusy(true);
		if (itemKey) setBusyKey(itemKey);
		if (loadingMsg) setToast({ ok: true, msg: loadingMsg, loading: true });
		try {
			const r = await fetch("/api/plugins", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, cwd, ...payload }),
			});
			const j = await r.json();
			if (workspaceSeq !== workspaceSeqRef.current) return false;
			if (j.success) {
				notify(!j.data?.warning, j.data?.warning ?? successMsg ?? (action === "toggle" ? (payload.disabled ? t.disabled : t.enabled) : t.toastSaved));
				await load();
				return true;
			}
			notify(false, j.error ?? t.toastError);
			return false;
		} catch (e: any) {
			if (workspaceSeq === workspaceSeqRef.current) notify(false, e?.message ?? t.toastError);
			return false;
		} finally {
			if (workspaceSeq === workspaceSeqRef.current) {
				busyRef.current = false;
				setBusy(false);
				setBusyKey(null);
			}
		}
	};

	const toggleExpand = (key: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	/**
	 * 作用域（个人/项目）与来源（内置/本地/包）是两条独立的轴，服务端已经算好；
	 * 这里只做兜底，避免旧快照或老字段在界面上渲染成空白。
	 */
	const placementOf = (extension: ExtensionItem): { scope: PluginScope; origin: PluginOrigin } => {
		if (extension.scope && extension.origin) return { scope: extension.scope, origin: extension.origin };
		if (extension.path.startsWith("builtin:")) return { scope: "user", origin: "builtin" };
		if (extension.sourceInfo?.origin === "package") return { scope: extension.sourceInfo.scope, origin: "package" };
		return { scope: extension.sourceInfo?.scope ?? "user", origin: "top-level" };
	};

	const scopeLabelOf = (scope: PluginScope) =>
		scope === "user" ? t.scopeUser : scope === "project" ? t.scopeProject : t.skillScopeTemporary;

	const originLabelOf = (origin: PluginOrigin) =>
		origin === "builtin" ? t.promptToolBuiltin : origin === "package" ? t.scopePackage : t.originLocal;

	const matchesScope = (scope: PluginScope) => scopeFilter === "all" || scope === scopeFilter;

	const getBuiltinMeta = (name: string): BuiltinMeta => {
		if (name === "codemode") {
			return {
				title: t.pluginBuiltinCodemodeTitle,
				description: t.pluginBuiltinCodemodeDesc,
				iconBg: "rgba(139, 92, 246, 0.14)",
				iconColor: "#a78bfa",
				icon: <IconCodemode18 />,
			};
		}
		if (name === "tool-search") {
			return {
				title: t.pluginBuiltinToolSearchTitle,
				description: t.pluginBuiltinToolSearchDesc,
				iconBg: "rgba(56, 189, 248, 0.14)",
				iconColor: "#38bdf8",
				icon: <IconSearchOutline16 size={17} />,
			};
		}
		if (name === "mcp") {
			return {
				title: t.pluginBuiltinMcpTitle,
				description: t.pluginBuiltinMcpDesc,
				iconBg: "rgba(20, 184, 166, 0.14)",
				iconColor: "#2dd4bf",
				icon: <IconMcpPlug18 />,
			};
		}
		return {
			title: name,
			description: `builtin:${name}`,
			iconBg: "var(--dsw-hover)",
			iconColor: "var(--dsw-label-secondary)",
			icon: <IconPluginOutline16 size={17} />,
		};
	};

	const query = q.trim().toLowerCase();
	// 包带入的扩展不单独列（由所属 pi 包那一行代表），内置单列，其余都算本地扩展
	const builtinExtensions = extensions.filter((e) => placementOf(e).origin === "builtin");
	const localExtensions = extensions.filter((e) => placementOf(e).origin === "top-level");

	const matchesQuery = (text: string) => !query || text.toLowerCase().includes(query);
	// 内置扩展在「全部」视图集中展示，不占「个人 / 项目」扩展包计数
	const visibleBuiltins = scopeFilter === "all"
		? builtinExtensions.filter((e) => {
			const meta = getBuiltinMeta(e.name);
			return matchesQuery(`${e.name} ${meta.title} ${meta.description}`);
		})
		: [];
	const visibleLocals = localExtensions.filter((e) => matchesScope(placementOf(e).scope) && matchesQuery(`${e.name} ${e.path}`));
	const visiblePackages = packages.filter((p) => {
		const shortName = p.source.replace(/^npm:/, "").replace(/^git[^:]*:/, "");
		return matchesScope(p.scope) && matchesQuery(`${shortName} ${p.source}`);
	});

	const stateBadge = (disabled: boolean) => (
		<span
			className="inline-flex flex-none items-center gap-1.5 rounded-md px-1.5 py-0.5"
			style={{
				fontSize: 10.5,
				...(disabled
					? { background: "var(--dsw-selector)", color: "var(--dsw-label-tertiary)" }
					: { background: "rgba(34,197,94,.12)", color: "var(--dsw-success)" }),
			}}
		>
			<span className="h-1.5 w-1.5 rounded-full" style={{ background: disabled ? "var(--dsw-label-tertiary)" : "var(--dsw-success)" }} />
			{disabled ? t.disabled : t.enabled}
		</span>
	);

	const scopeBadge = (label: string) => (
		<span
			className="rounded-md px-1.5 py-0.5"
			style={{ fontSize: 10.5, background: "var(--dsw-hover)", color: "var(--dsw-label-tertiary)" }}
		>
			{label}
		</span>
	);

	/** 来源徽章：内置 / 本地 / 包。虚边框，跟实心的作用域徽章区分开 */
	const originBadge = (origin: PluginOrigin) => (
		<span
			className="rounded-md px-1.5 py-0.5"
			style={{
				fontSize: 10.5,
				border: "0.5px dashed var(--dsw-border-l2)",
				color: origin === "package" ? "#a78bfa" : "var(--dsw-label-caption)",
			}}
			title={origin === "package" ? t.skillOriginPackageHint : undefined}
		>
			{originLabelOf(origin)}
		</span>
	);

	const resourceTypeLabel = (type: PluginResourceType) =>
		type === "extensions" ? t.pluginTypeExtensions
			: type === "skills" ? t.pluginTypeSkills
				: type === "prompts" ? t.pluginTypePrompts
					: t.pluginTypeThemes;

	const resourceTypeBadges = (types: PluginResourceType[] | undefined) =>
		(types ?? []).map((type) => (
			<span
				key={type}
				className="rounded-md px-1.5 py-0.5"
				style={{ fontSize: 10.5, background: "var(--dsw-selector)", color: "var(--dsw-label-tertiary)" }}
			>
				{resourceTypeLabel(type)}
			</span>
		));

	const scopeCount = (scope: "user" | "project") =>
		localExtensions.filter((e) => placementOf(e).scope === scope).length
		+ packages.filter((p) => p.scope === scope).length;

	const totalItems = builtinExtensions.length + localExtensions.length + packages.length;
	const showSearch = totalItems > 5 || query.length > 0;

	const renderToggle = (label: string, itemKey: string, isDisabled: boolean, payload: Record<string, unknown>) => (
		<button
			type="button"
			className="liq-sw flex-none"
			data-on={!isDisabled ? "true" : undefined}
			role="switch"
			aria-checked={!isDisabled}
			aria-label={label}
			disabled={busyKey === itemKey || busy}
			onClick={() =>
				void act(
					"toggle",
					payload,
					itemKey,
					isDisabled
						? lang === "zh"
							? "正在启用..."
							: "Enabling..."
						: lang === "zh"
						? "正在停用..."
						: "Disabling...",
					isDisabled ? t.enabled : t.disabled,
				)
			}
		>
			<span className="liq-thumb" />
		</button>
	);

	return (
		<div className="flex flex-col gap-6">
			{!hideHeader && (
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<div style={{ fontSize: "var(--dsh-ui-font-xl)", fontWeight: 600, color: "var(--dsw-label-primary)" }}>{t.setPlugins}</div>
						<div className="mt-1" style={{ fontSize: "var(--dsh-ui-font-sm)", color: "var(--dsw-label-tertiary)" }}>
							{t.pluginPageDesc}
						</div>
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="btn-outline"
							style={{ height: 32, padding: "0 12px", fontSize: "var(--dsh-ui-font-sm)" }}
							disabled={busy}
							onClick={() => void handleReload()}
						>
							<IconRefreshOutline14 size={13} /> {t.panelRefresh}
						</button>
						<button
							type="button"
							className="btn-primary-white"
							style={{ height: 32, padding: "0 14px", fontSize: "var(--dsh-ui-font-sm)" }}
							onClick={() => setModalOpen(true)}
						>
							+ {t.addPluginAction}
						</button>
					</div>
				</div>
			)}

			<FloatingToast toast={toast} />

			<ScopeWorkspaceFilterBar
				tabs={[
					{ id: "all", label: t.skillFilterAll, count: builtinExtensions.length + localExtensions.length + packages.length },
					{ id: "user", label: t.scopeUser, count: scopeCount("user") },
					{ id: "project", label: t.scopeProject, count: scopeCount("project") },
				]}
				activeTab={scopeFilter}
				onTabChange={setScopeFilter}
				ariaLabel={t.pluginScopeFilterLabel}
				workspace={{
					visible: scopeFilter === "project",
					cwd,
					label: t.workspaceScope,
					options: workspaceOptions,
					onChange: onCwdChange,
				}}
			/>

			{showSearch && (
				<div className="isx-search flex items-center gap-2.5 px-3.5" style={{ height: 38 }}>
					<IconSearchOutline16 size={15} className="isx-search-icon flex-none" style={{ color: "var(--dsw-label-caption)" }} />
					<input
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder={t.searchPlugins}
						aria-label={t.searchPlugins}
						className="w-full bg-transparent outline-none"
						style={{ fontSize: "var(--dsh-ui-font-sm)", color: "var(--dsw-label-primary)" }}
					/>
				</div>
			)}

			{/* 内置插件配置（SDK builtin:codemode / builtin:tool-search / builtin:mcp） */}
			{visibleBuiltins.length > 0 && (
				<section className="flex flex-col gap-2">
					<div className="flex items-center gap-2" style={{ paddingLeft: 4 }}>
						<h2 style={{ fontSize: "var(--dsh-ui-font-sm)", fontWeight: 500, color: "var(--dsw-label-secondary)" }}>
							{t.builtinPluginsSection}
						</h2>
						<span className="tabular-nums" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)" }}>
							{visibleBuiltins.length}
						</span>
					</div>
					<div
						className="overflow-hidden rounded-xl"
						style={{ border: "0.5px solid var(--dsw-border-l2)", background: "var(--dsw-bg-elevated, transparent)" }}
					>
						{visibleBuiltins.map((e, idx) => {
							const key = `ext:${e.path}`;
							const isDisabled = e.disabled === true;
							const placement = placementOf(e);
							const meta = getBuiltinMeta(e.name);
							return (
								<PluginRow
									key={key}
									borderedTop={idx > 0}
									icon={meta.icon}
									iconBg={meta.iconBg}
									iconColor={meta.iconColor}
									title={meta.title}
									badges={
										<>
											{placement.scope === "project" && scopeBadge(scopeLabelOf(placement.scope))}
											{originBadge(placement.origin)}
											{isDisabled && stateBadge(true)}
										</>
									}
									subtitle={e.error ?? meta.description}
									subtitleError={Boolean(e.error)}
									controls={renderToggle(meta.title, key, isDisabled, {
										kind: "extension",
										path: e.path,
										disabled: !isDisabled,
									})}
								/>
							);
						})}
					</div>
				</section>
			)}

			{/* 本地扩展（全局 ~/.pi/agent/extensions 与项目 .pi/extensions） */}
			{visibleLocals.length > 0 && (
				<section className="flex flex-col gap-2">
					<div className="flex items-center gap-2" style={{ paddingLeft: 4 }}>
						<h2 style={{ fontSize: 13, fontWeight: 500, color: "var(--dsw-label-secondary)" }}>
							{t.localExtensionsSection}
						</h2>
						<span className="tabular-nums" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
							{visibleLocals.length}
						</span>
					</div>
					<div
						className="overflow-hidden rounded-xl"
						style={{ border: "0.5px solid var(--dsw-border-l2)", background: "var(--dsw-bg-elevated, transparent)" }}
					>
						{visibleLocals.map((e, idx) => {
							const key = `ext:${e.path}`;
							const placement = placementOf(e);
							const open = expanded.has(key);
							const isDisabled = e.disabled === true;
							return (
								<PluginRow
									key={key}
									borderedTop={idx > 0}
									icon={<IconTerminalOutline14 size={16} />}
									iconBg="rgba(59, 130, 246, 0.14)"
									iconColor="#60a5fa"
									title={e.name}
									badges={
										<>
											{scopeBadge(scopeLabelOf(placement.scope))}
											{originBadge(placement.origin)}
											{e.error ? (
												<span
													className="rounded px-1.5 py-0.5"
													style={{
														fontSize: 10.5,
														color: "var(--dsw-danger)",
														background: "var(--pw-danger-soft, rgba(236,19,19,.12))",
													}}
												>
													{t.extensionLoadError}
												</span>
											) : (
												stateBadge(isDisabled)
											)}
										</>
									}
									subtitle={e.error ?? e.path}
									subtitleError={Boolean(e.error)}
									expandable
									expanded={open}
									onToggleExpand={() => toggleExpand(key)}
									details={
										<div className="break-all" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
											{e.path}
										</div>
									}
									controls={renderToggle(e.name, key, isDisabled, {
										kind: "extension",
										path: e.path,
										disabled: !isDisabled,
									})}
								/>
							);
						})}
					</div>
				</section>
			)}

			{/* 已安装插件 */}
			{visiblePackages.length > 0 && (
				<section className="flex flex-col gap-2">
					<div className="flex items-center gap-2" style={{ paddingLeft: 4 }}>
						<h2 style={{ fontSize: 13, fontWeight: 500, color: "var(--dsw-label-secondary)" }}>
							{t.installedPluginsSection}
						</h2>
						<span className="tabular-nums" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
							{visiblePackages.length}
						</span>
					</div>
					<div
						className="overflow-hidden rounded-xl"
						style={{ border: "0.5px solid var(--dsw-border-l2)", background: "var(--dsw-bg-elevated, transparent)" }}
					>
						{visiblePackages.map((p, idx) => {
							const key = `pkg:${p.scope}:${p.source}`;
							const shortName = p.source.replace(/^npm:/, "").replace(/^git[^:]*:/, "");
							const isDisabled = p.disabled === true;
							const open = expanded.has(key);
							return (
								<PluginRow
									key={key}
									borderedTop={idx > 0}
									icon={<IconDatabaseOutline16 size={16} />}
									iconBg="rgba(245, 158, 11, 0.14)"
									iconColor="#f59e0b"
									title={shortName}
									badges={
										<>
											{scopeBadge(p.scope === "user" ? t.scopeUser : t.scopeProject)}
											{originBadge("package")}
											{resourceTypeBadges(p.types)}
											{stateBadge(isDisabled)}
										</>
									}
									subtitle={p.source}
									expandable
									expanded={open}
									onToggleExpand={() => toggleExpand(key)}
									details={
										<>
											<div className="break-all" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
												{p.installedPath || p.source}
											</div>
											<div style={{ color: "var(--dsw-label-caption)", fontSize: 11.5 }}>
												{t.resources}: {p.resources.extensions} ext · {p.resources.skills} skills · {p.resources.prompts} prompts
											</div>
										</>
									}
									controls={
										<>
											<button
												type="button"
												disabled={busy || isDisabled}
												title={isDisabled ? t.updateNeedsEnable : undefined}
												className="rounded-lg transition-colors hover:bg-[var(--dsw-hover)] disabled:opacity-45"
												style={{
													borderRadius: 8,
													height: 28,
													padding: "0 10px",
													fontSize: 12,
													color: "var(--dsw-label-secondary)",
												}}
												onClick={() =>
													void act("update", { source: p.source }, key, t.updating, t.updateSuccess)
												}
											>
												{t.update}
											</button>
											<button
												type="button"
												disabled={busy}
												className="rounded-lg transition-colors hover:bg-[var(--dsw-hover)] disabled:opacity-45"
												style={{
													borderRadius: 8,
													height: 28,
													padding: "0 10px",
													fontSize: 12,
													color: "var(--dsw-danger)",
												}}
												onClick={async () => {
													if (!(await confirmUninstall(p.source))) return;
													void act(
														"remove",
														{ source: p.source, local: p.scope === "project" },
														key,
														t.uninstalling,
														t.uninstallSuccess,
													);
												}}
											>
												{t.uninstall}
											</button>
											{renderToggle(shortName, key, isDisabled, {
												kind: "package",
												source: p.source,
												scope: p.scope,
												disabled: !isDisabled,
											})}
										</>
									}
								/>
							);
						})}
					</div>
				</section>
			)}

			{loading && totalItems === 0 && (
				<div className="flex flex-col gap-2 py-1" aria-busy="true" aria-label={t.loadingPlugins}>
					{Array.from({ length: 3 }).map((_, idx) => (
						<div
							key={idx}
							className="animate-pulse rounded-lg"
							style={{ height: 52, background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)" }}
						/>
					))}
				</div>
			)}

			{!loading && scopeFilter === "all" && !query && localExtensions.length === 0 && packages.length === 0 && (
				<div
					className="flex flex-wrap items-center justify-between gap-4 rounded-xl px-4 py-3.5"
					style={{
						border: "0.5px dashed var(--dsw-border-l2)",
						background: "var(--dsw-bg-elevated, transparent)",
					}}
				>
					<div className="flex min-w-0 items-center gap-3">
						<div
							className="flex h-9 w-9 flex-none items-center justify-center rounded-lg"
							style={{ background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b" }}
						>
							<IconDatabaseOutline16 size={16} />
						</div>
						<div className="min-w-0">
							<div style={{ fontSize: 13, fontWeight: 500, color: "var(--dsw-label-primary)" }}>
								{t.pluginsEmptyInstalledTitle}
							</div>
							<div className="mt-0.5" style={{ fontSize: 12, color: "var(--dsw-label-tertiary)" }}>
								{t.pluginsEmptyInstalledDesc}
							</div>
						</div>
					</div>
				</div>
			)}

			{!loading && visibleBuiltins.length === 0 && visibleLocals.length === 0 && visiblePackages.length === 0 && (
				<div
					className="flex flex-wrap items-center justify-between gap-4 rounded-xl px-4 py-4"
					style={{
						border: "0.5px dashed var(--dsw-border-l2)",
						background: "var(--dsw-bg-elevated, transparent)",
					}}
				>
					<div style={{ fontSize: 12.5, color: "var(--dsw-label-tertiary)" }}>
						{query
							? t.searchNoMatch
							: scopeFilter === "project"
							? t.pluginsEmptyScopeProjectDesc
							: scopeFilter === "user"
							? t.pluginsEmptyScopeUserDesc
							: t.extensionsEmpty}
					</div>
				</div>
			)}

			<AddPluginModal
				open={modalOpen}
				cwd={cwd}
				source={source}
				setSource={setSource}
				local={local}
				setLocal={setLocal}
				busy={busy}
				onClose={() => setModalOpen(false)}
				onSubmit={() => {
					const installSource = source.trim();
					const projectScope = local;
					const workspaceSeq = workspaceSeqRef.current;
					void (async () => {
						if (!(await confirm({ title: t.install, message: t.pluginInstallConfirm.replace("{source}", installSource), confirmLabel: t.install }))) return;
						if (workspaceSeq !== workspaceSeqRef.current) return;
						if (await act("install", { source: installSource, local: projectScope }, undefined, t.installing, t.installSuccess)) {
							setSource(""); setModalOpen(false);
						}
					})();
				}}
			/>

			{confirmDialog}
		</div>
	);
}
