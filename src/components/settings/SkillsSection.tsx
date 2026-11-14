"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { IconFileOutline16, IconSearchOutline16, IconSkillOutline16 } from "@/components/icons";
import { useI18n } from "@/i18n";
import { ScopeWorkspaceFilterBar } from "@/components/settings/SharedControls";
import type { SkillScope, SkillView } from "@/lib/types";

// ---------- Skills ----------

type SkillScopeFilter = "all" | SkillScope;

/** 作用域决定图标色调；来源（local / package）只做小徽章 */
const SCOPE_STYLE: Record<SkillScope, { color: string; bg: string }> = {
	user: { color: "#3b82f6", bg: "rgba(59, 130, 246, 0.12)" },
	project: { color: "#10b981", bg: "rgba(16, 185, 129, 0.12)" },
	temporary: { color: "#f59e0b", bg: "rgba(245, 158, 11, 0.12)" },
};

function shortenSkillPath(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const markers = ["/.pi/", "/.agents/", "/.codex/", "/.claude/"];
	for (const m of markers) {
		const idx = normalized.toLowerCase().lastIndexOf(m);
		if (idx >= 0) return normalized.slice(idx + 1);
	}
	const parts = normalized.split("/").filter(Boolean);
	return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : normalized;
}

export function SkillsSection({
	cwd,
	onOpenFileContent,
	hideDesc = false,
	reloadSeq = 0,
	workspaceOptions,
	onCwdChange,
}: {
	cwd: string;
	onOpenFileContent?: (path: string, content: string) => void;
	hideDesc?: boolean;
	reloadSeq?: number;
	/** 切到「项目」页签时用来切换工作区 */
	workspaceOptions?: { value: string; label: string }[];
	onCwdChange?: (cwd: string) => void;
}) {
	const { t } = useI18n();
	const { confirm, confirmDialog } = useConfirmDialog();
	const [skills, setSkills] = useState<SkillView[]>([]);
	const [scopeFilter, setScopeFilter] = useState<SkillScopeFilter>("all");
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const workspaceSeqRef = useRef(0);
	const loadSeqRef = useRef(0);

	const load = useCallback(async () => {
		const workspaceSeq = workspaceSeqRef.current;
		const loadSeq = ++loadSeqRef.current;
		try {
			const r = await fetch(`/api/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
			const j = await r.json();
			if (workspaceSeq !== workspaceSeqRef.current || loadSeq !== loadSeqRef.current) return;
			if (j.success && Array.isArray(j.data?.skills)) {
				setSkills(j.data.skills);
				setError(null);
			} else setError(j.error || t.toastError);
		} catch (err: unknown) {
			if (workspaceSeq === workspaceSeqRef.current && loadSeq === loadSeqRef.current) {
				setError(err instanceof Error ? err.message : t.toastError);
			}
		}
	}, [cwd, t.toastError]);

	useEffect(() => {
		workspaceSeqRef.current += 1;
		busyRef.current = false;
		setSkills([]);
		setError(null);
		setBusy(false);
		return () => {
			workspaceSeqRef.current += 1;
			loadSeqRef.current += 1;
		};
	}, [cwd]);

	useEffect(() => {
		void load();
	}, [load, reloadSeq]);

	const perform = async (s: SkillView, action: "toggle" | "read" | "delete") => {
		if (busyRef.current) return;
		const workspaceSeq = workspaceSeqRef.current;
		busyRef.current = true;
		setBusy(true);
		setError(null);
		try {
			let expectedPath: string | undefined;
			if (action === "delete") {
				const previewResponse = await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "previewDelete", filePath: s.filePath, cwd }) });
				const preview = await previewResponse.json();
				if (!previewResponse.ok || !preview.success || typeof preview.data?.removed !== "string") throw new Error(preview.error || t.toastError);
				expectedPath = preview.data.removed;
				if (!(await confirm({ title: t.delete, message: `${t.confirmDeleteSkill.replace("{name}", s.name)}\n\n${expectedPath}`, confirmLabel: t.delete }))) return;
				if (workspaceSeq !== workspaceSeqRef.current) return;
			}
			if (action !== "read") loadSeqRef.current += 1;
			const r = await fetch("/api/skills", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, filePath: s.filePath, ...(expectedPath ? { expectedPath } : {}), ...(action === "toggle" ? { disabled: !s.disabled } : {}), cwd }),
			});
			const j = await r.json();
			if (workspaceSeq !== workspaceSeqRef.current) return;
			if (!j.success) setError(j.error || t.toastError);
			else if (action === "read") onOpenFileContent?.(s.filePath, j.data.content);
			else { await load(); if (j.data?.warning) setError(j.data.warning); }
		} catch (err: unknown) {
			if (workspaceSeq === workspaceSeqRef.current) setError(err instanceof Error ? err.message : t.toastError);
		} finally {
			if (workspaceSeq === workspaceSeqRef.current) {
				busyRef.current = false;
				setBusy(false);
			}
		}
	};

	const counts = useMemo(() => {
		let user = 0;
		let project = 0;
		let temporary = 0;
		for (const s of skills) {
			if (s.scope === "user") user += 1;
			else if (s.scope === "project") project += 1;
			else temporary += 1;
		}
		return { all: skills.length, user, project, temporary };
	}, [skills]);

	const q = query.trim().toLowerCase();
	const filteredSkills = useMemo(
		() =>
			skills.filter((s) => {
				if (scopeFilter !== "all" && s.scope !== scopeFilter) return false;
				if (!q) return true;
				return (
					s.name.toLowerCase().includes(q)
					|| `/skill:${s.name}`.toLowerCase().includes(q)
					|| s.description.toLowerCase().includes(q)
					|| s.filePath.toLowerCase().includes(q)
				);
			}),
		[skills, scopeFilter, q],
	);

	const scopeLabel = (s: SkillView) =>
		s.scope === "user" ? t.skillScopeUser : s.scope === "project" ? t.skillScopeProject : t.skillScopeTemporary;
	const scopeHint = (s: SkillView) =>
		s.scope === "user" ? t.skillScopeUserHint : s.scope === "project" ? t.skillScopeProjectHint : t.skillScopeTemporaryHint;
	// 作用域只有个人 / 项目两档；temporary 只有命令行 -e 才会产生，真出现了再补一个页签
	const tabs: { id: SkillScopeFilter; label: string; count: number }[] = [
		{ id: "all", label: t.skillFilterAll, count: counts.all },
		{ id: "user", label: t.skillScopeUser, count: counts.user },
		{ id: "project", label: t.skillScopeProject, count: counts.project },
		...(counts.temporary > 0 ? [{ id: "temporary" as const, label: t.skillScopeTemporary, count: counts.temporary }] : []),
	];

	return (
		<div className="flex flex-col gap-4">
			{!hideDesc && <div style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.skillsDesc}</div>}
			{error && (
				<div role="alert" className="rounded-lg px-3 py-2" style={{ fontSize: 12.5, background: "var(--dsw-hover)", color: "var(--dsw-danger)" }}>
					{error}
				</div>
			)}

			{/* 切到空工作区时也保留页签和「当前工作区」，否则用户会被困在空页面切换不出来 */}
			{(skills.length > 0 || scopeFilter === "project" || Boolean(workspaceOptions && workspaceOptions.length > 0)) && (
				<ScopeWorkspaceFilterBar
					tabs={tabs}
					activeTab={scopeFilter}
					onTabChange={setScopeFilter}
					ariaLabel={t.skillScopeFilterLabel}
					workspace={{
						visible: scopeFilter === "project",
						cwd,
						label: t.workspaceScope,
						options: workspaceOptions,
						onChange: onCwdChange,
					}}
				/>
			)}

			{skills.length > 0 && (
				<div className="isx-search relative">
					<IconSearchOutline16
						size={15}
						className="isx-search-icon pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2"
						style={{ color: "var(--dsw-label-caption)" }}
					/>
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t.skillSearchPlaceholder}
						aria-label={t.skillSearchPlaceholder}
						className="w-full rounded-lg outline-none"
						style={{
							height: 38,
							paddingLeft: 36,
							paddingRight: 12,
							fontSize: 13,
							background: "var(--dsw-bg-elevated, transparent)",
							border: "0.5px solid var(--dsw-border-l2)",
							color: "var(--dsw-label-primary)",
						}}
					/>
				</div>
			)}

			{skills.length === 0 && (
				<div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
					<span
						className="flex items-center justify-center rounded-xl"
						style={{ width: 44, height: 44, background: "var(--dsw-hover)", color: "var(--dsw-label-caption)" }}
					>
						<IconSkillOutline16 size={22} />
					</span>
					<div style={{ fontSize: 13.5, color: "var(--dsw-label-tertiary)" }}>{t.skillsEmpty}</div>
				</div>
			)}

			{skills.length > 0 && filteredSkills.length === 0 && (
				<div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
					<span
						className="flex items-center justify-center rounded-xl"
						style={{ width: 40, height: 40, background: "var(--dsw-hover)", color: "var(--dsw-label-caption)" }}
					>
						<IconSkillOutline16 size={20} />
					</span>
					<div style={{ fontSize: 13.5, color: "var(--dsw-label-tertiary)" }}>{t.skillFilterEmpty}</div>
				</div>
			)}

			{filteredSkills.length > 0 && (
				<div className={hideDesc ? "grid grid-cols-1 gap-3 md:grid-cols-2" : "flex flex-col gap-2.5"}>
					{filteredSkills.map((s) => {
						const accent = SCOPE_STYLE[s.scope];
						return (
							<div
								key={s.filePath}
								className="flex flex-col rounded-lg px-4 py-3.5 transition-colors hover:bg-[var(--dsw-hover)]"
								style={{
									border: "0.5px solid var(--dsw-border-l2)",
									opacity: s.disabled ? 0.68 : 1,
								}}
							>
								<div className="flex items-start gap-3">
									<div
										className="flex flex-none items-center justify-center rounded-lg"
										style={{ width: 38, height: 38, background: accent.bg, color: accent.color }}
									>
										<IconSkillOutline16 size={18} />
									</div>

									<div className="min-w-0 flex-1">
										<div className="flex items-center justify-between gap-2">
											<div className="flex min-w-0 flex-wrap items-center gap-1.5">
												<span className="truncate font-semibold" style={{ fontSize: 14, color: "var(--dsw-label-primary)" }}>
													{s.name}
												</span>
												<span
													className="rounded-full px-2 py-0.5"
													style={{
														fontSize: 10.5,
														background: accent.bg,
														color: accent.color,
														fontWeight: 500,
													}}
													title={scopeHint(s)}
												>
													{scopeLabel(s)}
												</span>
												{s.origin === "package" && (
													<span
														className="rounded-full px-2 py-0.5"
														style={{
															fontSize: 10.5,
															background: "rgba(139, 92, 246, 0.12)",
															color: "#8b5cf6",
															fontWeight: 500,
														}}
														title={t.skillOriginPackageHint}
													>
														{t.skillOriginPackage}
													</span>
												)}
												{s.disabled && (
													<span
														className="rounded-full px-2 py-0.5"
														style={{
															fontSize: 10.5,
															background: "var(--dsw-hover)",
															color: "var(--dsw-label-caption)",
														}}
													>
														{t.skillDisabledBadge}
													</span>
												)}
											</div>

											<button
												className="liq-sw flex-none"
												data-on={!s.disabled ? "true" : undefined}
												role="switch"
												aria-checked={!s.disabled}
												aria-label={s.name}
												disabled={busy}
												onClick={() => void perform(s, "toggle")}
											>
												<span className="liq-thumb" />
											</button>
										</div>

										<p
											className="mt-1.5 line-clamp-2"
											style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--dsw-label-secondary)", minHeight: hideDesc ? 38 : undefined }}
											title={s.description}
										>
											{s.description || shortenSkillPath(s.filePath)}
										</p>
									</div>
								</div>

								<div className="hairline-t mt-3 flex flex-wrap items-center justify-between gap-2 pt-2.5">
									<div className="flex min-w-0 items-center gap-2">
										<code
											className="truncate rounded px-1.5 py-0.5"
											style={{
												fontSize: 11,
												fontFamily: "var(--font-mono)",
												background: "var(--dsw-hover)",
												color: "var(--dsw-label-tertiary)",
											}}
											title={`${t.skillTriggerLabel}: /skill:${s.name}`}
										>
											/skill:{s.name}
										</code>
										<span
											className="hidden truncate sm:inline"
											style={{ fontSize: 11, color: "var(--dsw-label-caption)" }}
											title={s.filePath}
										>
											{shortenSkillPath(s.filePath)}
										</span>
										{s.sourceLabel && s.sourceLabel !== shortenSkillPath(s.filePath) && (
											<span
												className="truncate rounded px-1.5 py-0.5"
												style={{
													fontSize: 10.5,
													fontFamily: "var(--font-mono)",
													background: "var(--dsw-hover)",
													color: "var(--dsw-label-caption)",
												}}
												title={`${t.skillSourceLabel}: ${s.sourceLabel}`}
											>
												{s.sourceLabel}
											</span>
										)}
									</div>

									<div className="flex flex-none items-center gap-1.5">
										<button
											type="button"
											className="inline-flex items-center gap-1 rounded-lg transition-colors hover:bg-[var(--dsw-active)]"
											style={{ fontSize: 12, padding: "4px 10px", color: "var(--dsw-label-secondary)", background: "var(--dsw-hover)" }}
											disabled={busy}
											onClick={() => void perform(s, "read")}
										>
											<IconFileOutline16 size={13} />
											<span>{t.viewSkillFile}</span>
										</button>
										{s.origin !== "package" && (
											<button
												type="button"
												className="rounded-lg transition-colors hover:bg-[var(--dsw-hover)]"
												style={{ fontSize: 12, padding: "4px 10px", color: "var(--dsw-danger)" }}
												title={t.deleteSkillHint}
												disabled={busy}
												onClick={() => void perform(s, "delete")}
											>
												{t.delete}
											</button>
										)}
										{s.origin === "package" && (
											<span style={{ fontSize: 10.5, color: "var(--dsw-label-caption)" }} title={t.skillDeletePackageHint}>
												{t.skillDeletePackageHint}
											</span>
										)}
									</div>
								</div>
							</div>
						);
					})}
				</div>
			)}

			{confirmDialog}
		</div>
	);
}
