"use client";

/**
 * 设置 → 导入会话：把本机其它 AI 编程工具的对话无损导成 pi 会话。
 *
 * 交互上刻意保守：**默认一条都不勾**（本机 ZCode 421 条、opencode 860 条，一键全选就是事故），
 * 已导过的行标出来并且不能再勾。写入去向由服务端决定（源项目还在就导回原工作区），
 * 这里只负责在源项目已不在本机时给一个兜底工作区——从已知工作区里选，不允许手输路径。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { IconRefreshOutline14, IconDownloadOutline16 } from "@/components/icons";

interface Summary {
	source: string;
	externalId: string;
	title?: string;
	projectPath?: string;
	provider?: string;
	model?: string;
	createdAt?: number;
	updatedAt?: number;
	messageCount?: number;
}

interface SourceError {
	source: string;
	message: string;
}

interface ImportOutcome {
	source: string;
	externalId: string;
	title?: string;
	status: "imported" | "skipped" | "failed";
	reason?: string;
	messageCount?: number;
	workspace?: string;
}

interface ImportReport {
	imported: number;
	skipped: number;
	failed: number;
	results: ImportOutcome[];
	workspaces: string[];
}

/** 来源中文名/英文名放在 i18n 里，这里只保留稳定的顺序与徽标色 */
const SOURCE_ORDER = ["claude", "codex", "grok", "zcode", "dsh", "opencode"] as const;

/** 与 src/lib/session-import/index.ts 的 SCAN_LIMIT_PER_SOURCE 保持一致（仅用于提示文案） */
const SCAN_LIMIT = 15;

function dayOf(ms?: number): string {
	if (!ms) return "";
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function SessionImportSection({ cwd }: { cwd: string }) {
	const { t } = useI18n();
	const [summaries, setSummaries] = useState<Summary[]>([]);
	const [errors, setErrors] = useState<SourceError[]>([]);
	const [importedKeys, setImportedKeys] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [scanning, setScanning] = useState(false);
	const [importing, setImporting] = useState(false);
	const [report, setReport] = useState<ImportReport | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [workspaces, setWorkspaces] = useState<string[]>([]);
	const [fallback, setFallback] = useState(cwd);

	const scan = useCallback(async () => {
		setScanning(true);
		setFailure(null);
		try {
			const response = await fetch("/api/sessions/import");
			const json = await response.json();
			if (!json.success) {
				setFailure(json.error || t.toastError);
				return;
			}
			setSummaries(json.data.sessions ?? []);
			setErrors(json.data.errors ?? []);
			setImportedKeys(new Set<string>(json.data.imported ?? []));
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
		} finally {
			setScanning(false);
		}
	}, [t]);

	// 兜底工作区候选：已知工作区列表（只选不填），默认当前打开的工作区
	useEffect(() => {
		void (async () => {
			try {
				const json = await (await fetch("/api/workspaces")).json();
				if (json.success) setWorkspaces(json.data.workspaces ?? []);
			} catch {
				// 拿不到候选就把当前工作区当唯一条目，不影响导入
			}
		})();
	}, []);

	useEffect(() => {
		void scan();
	}, [scan]);

	const key = (summary: Summary) => `${summary.source}:${summary.externalId}`;

	const groups = useMemo(() => {
		const bySource = new Map<string, Summary[]>();
		for (const summary of summaries) {
			const list = bySource.get(summary.source);
			if (list) list.push(summary);
			else bySource.set(summary.source, [summary]);
		}
		return SOURCE_ORDER.filter((source) => bySource.has(source)).map((source) => {
			const rows = [...(bySource.get(source) as Summary[])].sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0));
			return { source, rows, imported: rows.filter((row) => importedKeys.has(key(row))).length };
		});
	}, [summaries, importedKeys]);

	/**
	 * 一次只显示一个来源：六个工具各列 15 条就是 90 行，全铺出来既难找也没必要。
	 * 默认落在第一个有会话的来源上（SOURCE_ORDER 的顺序），用户切换后不被扫描结果重置。
	 */
	const [activeSource, setActiveSource] = useState("");
	useEffect(() => {
		// 扫描完成的 effect 可能晚于用户点击；按执行时的最新选择决定是否回退。
		setActiveSource((current) => groups.some((group) => group.source === current) ? current : groups[0]?.source ?? "");
	}, [groups]);
	const activeGroup = groups.find((group) => group.source === activeSource);

	const toggle = (summary: Summary) => {
		if (importedKeys.has(key(summary))) return;
		setSelected((previous) => {
			const next = new Set(previous);
			if (next.has(key(summary))) next.delete(key(summary));
			else next.add(key(summary));
			return next;
		});
	};

	const selectGroup = (rows: Summary[], checked: boolean) => {
		setSelected((previous) => {
			const next = new Set(previous);
			for (const row of rows) {
				if (importedKeys.has(key(row))) continue;
				if (checked) next.add(key(row));
				else next.delete(key(row));
			}
			return next;
		});
	};

	const run = async () => {
		if (!selected.size) return;
		const items = summaries.filter((summary) => selected.has(key(summary))).map((summary) => ({ source: summary.source, externalId: summary.externalId }));
		setImporting(true);
		setFailure(null);
		setReport(null);
		try {
			const response = await fetch("/api/sessions/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessions: items, fallbackCwd: fallback || undefined }),
			});
			const json = await response.json();
			if (!json.success) {
				setFailure(json.error || t.toastError);
				return;
			}
			setReport(json.data as ImportReport);
			setSelected(new Set());
			await scan(); // 重新扫描：已经导过的行马上变成"已导入"
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
		} finally {
			setImporting(false);
		}
	};

	const sourceLabel = (source: string) => {
		const labels: Record<string, string> = {
			claude: t.importSourceClaude,
			codex: t.importSourceCodex,
			grok: t.importSourceGrok,
			zcode: t.importSourceZcode,
			dsh: t.importSourceDsh,
			opencode: t.importSourceOpencode,
		};
		return labels[source] ?? source;
	};

	const failures = report?.results.filter((result) => result.status === "failed") ?? [];
	const skipped = report?.results.filter((result) => result.status === "skipped") ?? [];

	return (
		<div className="flex flex-col gap-3.5" data-testid="session-import">
			{/* 说明区:主说明 + 扫描范围提示收进一个卡片,和下面的操作区分开 */}
			<div className="flex flex-col gap-1.5 rounded-2xl px-4 py-3" style={{ background: "var(--dsw-hover)" }}>
				<div style={{ fontSize: 12.5, color: "var(--dsw-label-secondary)", lineHeight: 1.6 }}>{t.importDesc}</div>
				<div style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }} title={t.importLimitHintTooltip} data-testid="import-limit-hint">
					{t.importLimitHint.replace("{n}", String(SCAN_LIMIT))}
				</div>
			</div>

			{/* 操作行:扫描 / 清空 / 导入。去向是"设置",单独一行读起来更清楚 */}
			<div className="flex flex-wrap items-center gap-2">
				<button
					className="btn-outline flex flex-none items-center gap-1.5 whitespace-nowrap"
					style={{ height: 30, padding: "0 12px", fontSize: 12.5 }}
					onClick={() => void scan()}
					disabled={scanning}
					data-testid="import-rescan"
				>
					<IconRefreshOutline14 size={13} /> {scanning ? t.importScanning : t.importRescan}
				</button>
				<div className="flex-1" />
				<button
					className="whitespace-nowrap rounded-lg px-2.5 py-1.5"
					style={{ fontSize: 12, color: selected.size ? "var(--dsw-label-secondary)" : "var(--dsw-label-tertiary)" }}
					onClick={() => setSelected(new Set())}
					disabled={!selected.size}
				>
					{t.importClearSelection}
				</button>
				<button
					className="flex flex-none items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5"
					style={{ fontSize: 12.5, background: selected.size && !importing ? "var(--dsw-accent)" : "var(--dsw-hover)", color: selected.size && !importing ? "#fff" : "var(--dsw-label-caption)" }}
					onClick={() => void run()}
					disabled={!selected.size || importing}
					data-testid="import-run"
				>
					<IconDownloadOutline16 size={13} /> {importing ? t.importRunning : t.importRun.replace("{n}", String(selected.size))}
				</button>
			</div>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<span className="flex-none" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.importFallbackWorkspace}</span>
				<select
					className="min-w-0 rounded-lg px-2 py-1"
					style={{ fontSize: 12, border: "0.5px solid var(--dsw-border-l2)", background: "transparent", maxWidth: 280 }}
					value={fallback}
					onChange={(event) => setFallback(event.target.value)}
					aria-label={t.importFallbackWorkspace}
					data-testid="import-fallback"
				>
					{(workspaces.includes(fallback) || !fallback ? workspaces : [fallback, ...workspaces]).map((workspace) => (
						<option key={workspace} value={workspace}>
							{workspace}
						</option>
					))}
				</select>
				<span className="min-w-0" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{t.importFallbackHint}</span>
			</div>

			{failure && (
				<div role="alert" className="rounded-lg px-3 py-2" style={{ fontSize: 12.5, background: "var(--dsw-hover)", color: "var(--dsw-danger)" }}>
					{failure}
				</div>
			)}

			{errors.map((error) => (
				<div key={error.source} className="rounded-lg px-3 py-2" style={{ fontSize: 12, background: "var(--dsw-hover)", color: "var(--dsw-label-tertiary)" }}>
					{t.importSourceError.replace("{source}", sourceLabel(error.source)).replace("{message}", error.message)}
				</div>
			))}

			{report && (
				<div className="rounded-2xl px-4 py-3" style={{ border: "0.5px solid var(--dsw-border-l2)" }} data-testid="import-report">
					<div style={{ fontSize: 13 }}>
						{t.importReportSummary
							.replace("{imported}", String(report.imported))
							.replace("{skipped}", String(report.skipped))
							.replace("{failed}", String(report.failed))}
					</div>
					{skipped.map((result) => (
						<div key={`skip-${result.source}-${result.externalId}`} className="mt-1" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
							{sourceLabel(result.source)} · {result.title || result.externalId} — {result.reason}
						</div>
					))}
					{failures.map((result) => (
						<div key={`fail-${result.source}-${result.externalId}`} className="mt-1" style={{ fontSize: 11.5, color: "var(--dsw-danger)" }}>
							{sourceLabel(result.source)} · {result.title || result.externalId} — {result.reason}
						</div>
					))}
				</div>
			)}

			{!scanning && !summaries.length && !errors.length && <div style={{ fontSize: 13, color: "var(--dsw-label-caption)" }}>{t.importEmpty}</div>}

			{/* 来源选择器：选中哪个就只列哪个工具的会话 */}
			{groups.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t.importPickSource} data-testid="import-source-tabs">
					{groups.map((group) => {
						const active = group.source === activeSource;
						return (
							<button
								key={group.source}
								type="button"
								role="tab"
								aria-selected={active}
								className="rounded-full px-3 py-1 transition-colors"
								style={{
									fontSize: 12,
									border: `0.5px solid ${active ? "var(--dsw-accent)" : "var(--dsw-border-l2)"}`,
									background: active ? "var(--dsw-accent)" : "transparent",
									color: active ? "#fff" : "var(--dsw-label-tertiary)",
								}}
								onClick={() => setActiveSource(group.source)}
								data-testid={`import-source-${group.source}`}
							>
								{sourceLabel(group.source)}
								<span style={{ marginLeft: 6, opacity: 0.75 }}>{group.rows.length}</span>
							</button>
						);
					})}
				</div>
			)}

			{activeGroup && (
				<div className="flex flex-col gap-2" data-testid={`import-group-${activeGroup.source}`}>
					<div className="flex items-center gap-2">
						<span style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
							{t.importGroupCount.replace("{n}", String(activeGroup.rows.length)).replace("{imported}", String(activeGroup.imported))}
						</span>
						<div className="flex-1" />
						<button className="rounded-lg px-2 py-0.5" style={{ fontSize: 11.5, color: "var(--dsw-label-tertiary)" }} onClick={() => selectGroup(activeGroup.rows, true)}>
							{t.importSelectAll}
						</button>
						<button className="rounded-lg px-2 py-0.5" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }} onClick={() => selectGroup(activeGroup.rows, false)}>
							{t.importSelectNone}
						</button>
					</div>
					<div className="flex flex-col gap-1.5">
						{activeGroup.rows.map((row) => {
							const rowKey = key(row);
							const done = importedKeys.has(rowKey);
							const checked = selected.has(rowKey);
							// 去向:源项目目录还在本机就回原工作区(服务端判定),否则用兜底工作区。
							// 这里只按"有没有 projectPath"给出预期,不假装知道目录是否真的存在。
							const target = row.projectPath || fallback;
							const goesOriginal = Boolean(row.projectPath);
							return (
								<label
									key={rowKey}
									className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors"
									style={{
										border: `0.5px solid ${checked ? "var(--dsw-accent)" : "var(--dsw-border-l2)"}`,
										background: checked ? "var(--dsw-accent-soft)" : "transparent",
										opacity: done ? 0.5 : 1,
									}}
								>
									<input type="checkbox" checked={checked} disabled={done} onChange={() => toggle(row)} className="flex-none" />
									<div className="flex min-w-0 flex-1 flex-col gap-0.5">
										<div className="truncate" style={{ fontSize: 12.5, color: done ? "var(--dsw-label-tertiary)" : "var(--dsw-label-primary)" }} title={row.title}>
											{row.title || t.importUntitled}
										</div>
										<div className="flex min-w-0 items-center gap-1.5" title={row.projectPath}>
											<span
												className="flex-none rounded px-1 py-0.5"
												style={{ fontSize: 10, background: "var(--dsw-selector)", color: "var(--dsw-label-tertiary)" }}
											>
												{goesOriginal ? t.importGoesOriginal : t.importGoesFallback}
											</span>
											<span className="truncate" style={{ fontSize: 11, color: "var(--dsw-label-caption)" }}>
												{target || t.importNoProject}
											</span>
										</div>
									</div>
									<span className="flex-none" style={{ fontSize: 11, color: "var(--dsw-label-caption)", whiteSpace: "nowrap" }}>
										{typeof row.messageCount === "number" ? t.importMessages.replace("{n}", String(row.messageCount)) : "—"}
									</span>
									<span className="flex-none" style={{ fontSize: 11, color: "var(--dsw-label-caption)", whiteSpace: "nowrap" }}>{dayOf(row.updatedAt ?? row.createdAt)}</span>
									{done && (
										<span className="flex-none rounded-full px-2 py-0.5" style={{ fontSize: 10, background: "var(--dsw-selector)", color: "var(--dsw-label-caption)" }}>
											{t.importAlready}
										</span>
									)}
								</label>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
