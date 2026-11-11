"use client";

/**
 * 抽屉 → 导入会话：把本机其它 AI 编程工具的对话导成 pi 会话。
 *
 * 默认一条都不勾，支持按来源浏览、搜索与跨来源选择，
 * 已导入的会话禁止重复选择，已归档的会话可恢复。写入去向由服务端决定（源项目还在就导回原工作区），
 * 这里只负责在源项目已不在本机时给一个兜底工作区——从已知工作区里选，不允许手输路径。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { IconRefreshOutline14, IconDownloadOutline16, IconSearchOutline16, IconFolderOpenOutline16, IconCheckOutline14, IconCloseOutline14, IconChevronDown14 } from "@/components/icons";
import { ProviderBrand } from "@/components/ProviderBrand";
import { ImportProjectPicker } from "@/components/ImportProjectPicker";
import { INITIAL_SCAN_LIMIT, MAX_SCAN_LIMIT, MAX_IMPORT_SELECTION } from "@/lib/session-import/limits";
import { SESSION_CHANGE_EVENT, notifySessionsChanged } from "@/lib/session-change-events";
import styles from "./SessionImportSection.module.css";

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
	status: "imported" | "restored" | "skipped" | "failed";
	reason?: string;
	messageCount?: number;
	workspace?: string;
}

interface ImportReport {
	imported: number;
	restored?: number;
	skipped: number;
	failed: number;
	results: ImportOutcome[];
	workspaces: string[];
}

/** 来源中文名/英文名放在 i18n 里，这里只保留稳定的顺序与徽标色 */
const SOURCE_ORDER = ["claude", "codex", "grok", "zcode", "dsh", "opencode"] as const;

function dayOf(ms?: number): string {
	if (!ms) return "";
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function folderName(value: string): string {
	return value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || value;
}

function projectKey(value?: string): string {
	if (!value) return "__no_project";
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
	return /^[a-z]:|^\/\//i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

export function SessionImportSection({ cwd }: { cwd: string }) {
	const { t } = useI18n();
	const [summaries, setSummaries] = useState<Summary[]>([]);
	const [errors, setErrors] = useState<SourceError[]>([]);
	const [importedKeys, setImportedKeys] = useState<Set<string>>(new Set());
	const [archivedKeys, setArchivedKeys] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [scanning, setScanning] = useState(true);
	const [importing, setImporting] = useState(false);
	const [report, setReport] = useState<ImportReport | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [workspaces, setWorkspaces] = useState<string[]>([]);
	const [fallback, setFallback] = useState(cwd);
	const [query, setQuery] = useState("");
	const [projectFilter, setProjectFilter] = useState("");
	const [selectedOnly, setSelectedOnly] = useState(false);
	const [scanLimit, setScanLimit] = useState(INITIAL_SCAN_LIMIT);
	const scanLimitRef = useRef(INITIAL_SCAN_LIMIT);
	const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
	const scanInFlight = useRef(false);
	const pendingScanLimit = useRef<number | null>(null);
	const importInFlight = useRef(false);
	const scrollBody = useRef<HTMLDivElement>(null);
	const pickerRef = useRef<HTMLDivElement>(null);
	const pickerTrigger = useRef<HTMLButtonElement>(null);
	const pickerId = useId();
	const [pickerOpen, setPickerOpen] = useState(false);
	const [sourceQuery, setSourceQuery] = useState("");
	const [highlightedSource, setHighlightedSource] = useState("");

	const scan = useCallback(async (limit = scanLimitRef.current) => {
		// Keep changes received during a scan: its response may predate a deletion or archive change.
		scanLimitRef.current = Math.max(scanLimitRef.current, limit);
		if (scanInFlight.current) {
			pendingScanLimit.current = scanLimitRef.current;
			return;
		}
		scanInFlight.current = true;
		setScanning(true);
		setFailure(null);
		try {
			do {
				limit = pendingScanLimit.current ?? scanLimitRef.current;
				pendingScanLimit.current = null;
				try {
					const response = await fetch(limit === INITIAL_SCAN_LIMIT ? "/api/sessions/import" : `/api/sessions/import?limit=${limit}`);
					const json = await response.json();
					if (!response.ok || !json.success) {
						setFailure(json.error || t.toastError);
						continue;
					}
					const nextSummaries: Summary[] = json.data.sessions ?? [];
					const nextImported = new Set<string>(json.data.imported ?? []);
					const nextArchived = new Set<string>(json.data.archived ?? []);
					setSummaries(nextSummaries);
					setErrors(json.data.errors ?? []);
					setImportedKeys(nextImported);
					setArchivedKeys(nextArchived);
					setScanLimit(limit);
					setHasMore(json.data.hasMore ?? {});
					const available = new Set(nextSummaries.map((row) => `${row.source}:${row.externalId}`).filter((key) => !nextImported.has(key) || nextArchived.has(key)));
					setSelected((previous) => new Set([...previous].filter((key) => available.has(key))));
				} catch (error) {
					setFailure(error instanceof Error ? error.message : String(error));
				}
			} while (pendingScanLimit.current !== null);
		} finally {
			scanInFlight.current = false;
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
	useEffect(() => {
		const refresh = () => void scan();
		const visible = () => { if (document.visibilityState === "visible") refresh(); };
		window.addEventListener(SESSION_CHANGE_EVENT, refresh);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", visible);
		return () => {
			window.removeEventListener(SESSION_CHANGE_EVENT, refresh);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [scan]);

	const key = (summary: Summary) => `${summary.source}:${summary.externalId}`;
	const isImported = (summary: Summary) => importedKeys.has(key(summary)) && !archivedKeys.has(key(summary));

	const groups = useMemo(() => {
		const bySource = new Map<string, Summary[]>();
		for (const summary of summaries) {
			const list = bySource.get(summary.source);
			if (list) list.push(summary);
			else bySource.set(summary.source, [summary]);
		}
		const sources = SOURCE_ORDER.map((source) => {
			const rows = [...(bySource.get(source) ?? [])].sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0));
			return { source, rows, imported: rows.filter((row) => importedKeys.has(key(row))).length };
		});
		return [{ source: "all", rows: [...summaries].sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0)), imported: summaries.filter((row) => importedKeys.has(key(row))).length }, ...sources];
	}, [summaries, importedKeys]);

	/**
	 * 默认落在第一个有会话的来源上，也可跨来源查找；重新扫描保留用户当前的来源。
	 */
	const [activeSource, setActiveSource] = useState("");
	useEffect(() => {
		if (scanning) return;
		// 扫描完成的 effect 可能晚于用户点击；按执行时的最新选择决定是否回退。
		setActiveSource((current) => groups.some((group) => group.source === current) ? current : (groups.find((group) => group.source !== "all" && group.rows.length) ?? groups[0]).source);
	}, [groups, scanning]);
	useEffect(() => {
		if (!pickerOpen) return;
		const outside = (event: MouseEvent | TouchEvent) => {
			if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
		};
		document.addEventListener("mousedown", outside);
		document.addEventListener("touchstart", outside);
		return () => {
			document.removeEventListener("mousedown", outside);
			document.removeEventListener("touchstart", outside);
		};
	}, [pickerOpen]);
	useEffect(() => {
		if (pickerOpen) document.getElementById(`${pickerId}-${highlightedSource}`)?.scrollIntoView?.({ block: "nearest" });
	}, [highlightedSource, pickerId, pickerOpen]);
	const activeGroup = groups.find((group) => group.source === activeSource);
	const search = query.trim().toLocaleLowerCase();
	const projects = useMemo(() => {
		const byProject = new Map<string, { value: string; path: string; count: number }>();
		for (const row of activeGroup?.rows ?? []) {
			const value = projectKey(row.projectPath);
			const existing = byProject.get(value);
			if (existing) existing.count += 1;
			else byProject.set(value, { value, path: row.projectPath ?? "", count: 1 });
		}
		return [...byProject.values()].sort((left, right) => folderName(left.path).localeCompare(folderName(right.path)) || left.path.localeCompare(right.path));
	}, [activeGroup]);
	useEffect(() => {
		if (!scanning && projectFilter && !projects.some((project) => project.value === projectFilter)) setProjectFilter("");
	}, [scanning, projectFilter, projects]);
	const visibleRows = (activeGroup?.rows ?? []).filter((row) =>
		(!search || [row.title, row.projectPath, row.provider, row.model, row.externalId].some((value) => value?.toLocaleLowerCase().includes(search))) &&
		(!projectFilter || projectKey(row.projectPath) === projectFilter) &&
		(!selectedOnly || selected.has(key(row))),
	);
	const availableRows = visibleRows.filter((row) => !isImported(row));
	const selectedArchived = [...selected].filter((key) => archivedKeys.has(key)).length;
	const hiddenSelected = selected.size - visibleRows.filter((row) => selected.has(key(row))).length;
	const filtersActive = Boolean(search || projectFilter || selectedOnly);
	const moreAvailable = activeSource === "all" ? Object.values(hasMore).some(Boolean) : Boolean(hasMore[activeSource]);
	const scanFailed = errors.some((error) => activeSource === "all" || error.source === activeSource);
	const clearFilters = () => { setQuery(""); setProjectFilter(""); setSelectedOnly(false); };
	const reviewSelected = () => { setActiveSource("all"); setQuery(""); setProjectFilter(""); setSelectedOnly(true); };
	useEffect(() => {
		if (!selected.size) setSelectedOnly(false);
	}, [selected.size]);

	const toggle = (summary: Summary) => {
		if (isImported(summary) || importInFlight.current || scanInFlight.current) return;
		setSelected((previous) => {
			const next = new Set(previous);
			if (next.has(key(summary))) next.delete(key(summary));
			else if (next.size < MAX_IMPORT_SELECTION) next.add(key(summary));
			return next;
		});
	};

	const selectGroup = (rows: Summary[], checked: boolean) => {
		if (importInFlight.current || scanInFlight.current) return;
		setSelected((previous) => {
			const next = new Set(previous);
			for (const row of rows) {
				if (isImported(row)) continue;
				if (checked) {
					if (next.size < MAX_IMPORT_SELECTION) next.add(key(row));
				} else next.delete(key(row));
			}
			return next;
		});
	};

	const run = async () => {
		if (!selected.size || importInFlight.current || scanInFlight.current) return;
		const items = summaries.filter((summary) => selected.has(key(summary)) && !isImported(summary)).map((summary) => ({ source: summary.source, externalId: summary.externalId }));
		if (!items.length) return;
		importInFlight.current = true;
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
			if (!response.ok || !json.success) {
				setFailure(json.error || t.toastError);
				return;
			}
			setReport(json.data as ImportReport);
			if (scrollBody.current) scrollBody.current.scrollTop = 0;
			setSelected(new Set());
			notifySessionsChanged(); // 导入状态与其它打开的会话视图一起刷新
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
		} finally {
			importInFlight.current = false;
			setImporting(false);
		}
	};

	const sourceLabel = (source: string) => {
		const labels: Record<string, string> = {
			all: t.importSourceAll,
			claude: t.importSourceClaude,
			codex: t.importSourceCodex,
			grok: t.importSourceGrok,
			zcode: t.importSourceZcode,
			dsh: t.importSourceDsh,
			opencode: t.importSourceOpencode,
		};
		return labels[source] ?? source;
	};
	const brandId = (source: string) => source === "claude" ? "anthropic" : source === "codex" ? "openai" : source === "grok" ? "xai" : source;
	const sourceSearch = sourceQuery.trim().toLocaleLowerCase();
	const filteredSources = groups.filter((group) => !sourceSearch || [sourceLabel(group.source), group.source].some((value) => value.toLocaleLowerCase().includes(sourceSearch)));
	const highlighted = filteredSources.find((group) => group.source === highlightedSource) ?? filteredSources[0];
	const chooseSource = (source: string) => {
		setActiveSource(source);
		setProjectFilter("");
		setSelectedOnly(false);
		setPickerOpen(false);
		pickerTrigger.current?.focus();
	};
	const openPicker = () => {
		setSourceQuery("");
		setHighlightedSource(activeSource);
		setPickerOpen(true);
	};
	return (
		<section className={styles.panel} data-testid="session-import" aria-label={t.importSessions}>
			<div className={styles.body} ref={scrollBody}>
				<header className={styles.intro}>
					<span className={styles.introIcon}><IconDownloadOutline16 size={20} /></span>
					<div>
						<h2>{t.importHeading}</h2>
						<p>{t.importIntro}</p>
					</div>
				</header>

				{report && (
					<div className={styles.report} data-testid="import-report" role="status">
						<div className={styles.reportTitle}><IconCheckOutline14 /> {t.importFinished}</div>
						<p>{t.importReportSummary.replace("{imported}", String(report.imported + (report.restored ?? 0))).replace("{skipped}", String(report.skipped)).replace("{failed}", String(report.failed))}</p>
						{!!report.restored && <p>{t.importRestoredSummary.replace("{n}", String(report.restored))}</p>}
						<details open={report.failed > 0}>
							<summary>{t.importViewResults}<IconChevronDown14 /></summary>
							<div className={styles.outcomes}>
								{report.results.map((result) => (
									<div key={result.source + ":" + result.externalId} className={styles.outcome} data-status={result.status}>
										<span className={styles.outcomeStatus}>{result.status === "imported" ? t.importAlready : result.status === "restored" ? t.importRestored : result.status === "failed" ? t.importFailed : t.importSkipped}</span>
										<div>
											<strong>{result.title || summaries.find((row) => key(row) === `${result.source}:${result.externalId}`)?.title || t.importUntitled}</strong>
											<span>{sourceLabel(result.source)}{result.reason ? " · " + result.reason : ""}</span>
											{result.workspace && <span title={result.workspace}>{folderName(result.workspace)}</span>}
										</div>
									</div>
								))}
							</div>
						</details>
					</div>
				)}

				<div className={styles.sectionHeading}>
					<h3><span>1</span>{t.importPickSource}</h3>
					<button type="button" className={styles.rescan} onClick={() => void scan()} disabled={scanning || importing} data-testid="import-rescan" aria-label={t.importRescan} title={t.importRescan}>
						<IconRefreshOutline14 className={scanning ? styles.spinning : undefined} />
						<span>{scanning ? t.importScanning : t.importRescan}</span>
					</button>
				</div>
				<p className={styles.hint} data-testid="import-limit-hint">{t.importLimitHint.replace("{n}", String(scanLimit))}</p>

				{failure && <div role="alert" className={styles.error}>{failure}</div>}
				{errors.map((error) => (
					<div key={error.source} className={styles.sourceError}>{t.importSourceError.replace("{source}", sourceLabel(error.source)).replace("{message}", error.message)}</div>
				))}

				{scanning && !summaries.length ? (
					<div className={styles.skeleton} role="status" aria-label={t.importScanning}><div /><div /><div /></div>
				) : (
					<>
						<div className={styles.picker} ref={pickerRef} onKeyDownCapture={(event) => {
							if (event.key === "Escape" && pickerOpen) {
								event.preventDefault();
								event.stopPropagation();
								setPickerOpen(false);
								pickerTrigger.current?.focus();
							} else if (event.key === "Tab") setPickerOpen(false);
						}}>
							<button type="button" ref={pickerTrigger} className={styles.sourceTrigger} data-open={pickerOpen} data-testid="import-source-picker" aria-label={t.importPickSource} aria-haspopup="listbox" aria-expanded={pickerOpen} aria-controls={pickerOpen ? pickerId : undefined} disabled={importing || scanning} onClick={() => pickerOpen ? setPickerOpen(false) : openPicker()} onKeyDown={(event) => {
								if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openPicker(); }
							}}>
								{activeSource === "all" ? <IconDownloadOutline16 size={26} /> : <ProviderBrand id={brandId(activeSource)} name={sourceLabel(activeSource)} size={30} />}
								<span className={styles.sourceText}><strong>{sourceLabel(activeSource)}</strong><span>{activeSource !== "all" && `${activeSource} · `}{t.importSourceCount.replace("{n}", String(activeGroup?.rows.length ?? 0))}</span></span>
								<IconChevronDown14 size={15} />
							</button>
							{pickerOpen && <div className={styles.sourceMenu}>
								<div className={styles.sourceSearch}><IconSearchOutline16 size={15} /><input autoFocus role="combobox" aria-label={t.importSourceSearch} aria-autocomplete="list" aria-expanded="true" aria-controls={pickerId} aria-activedescendant={highlighted ? `${pickerId}-${highlighted.source}` : undefined} placeholder={t.importSourceSearch} value={sourceQuery} onChange={(event) => { setSourceQuery(event.target.value); setHighlightedSource(""); }} onKeyDown={(event) => {
									if (event.key === "ArrowDown" || event.key === "ArrowUp") {
										event.preventDefault();
										const index = highlighted ? filteredSources.indexOf(highlighted) : -1;
										const next = filteredSources[(index + (event.key === "ArrowDown" ? 1 : -1) + filteredSources.length) % filteredSources.length];
										if (next) setHighlightedSource(next.source);
									} else if (event.key === "Enter") {
										event.preventDefault();
										if (highlighted) chooseSource(highlighted.source);
									}
								}} /></div>
								<div className={styles.sourceList} id={pickerId} role="listbox" aria-label={t.importPickSource}>
									{filteredSources.map((group) => {
										const count = group.rows.filter((row) => selected.has(key(row))).length;
										return <button key={group.source} type="button" id={`${pickerId}-${group.source}`} role="option" aria-selected={group.source === activeSource} tabIndex={-1} className={styles.sourceOption} data-highlighted={group.source === highlighted?.source} data-testid={"import-source-" + group.source} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSource(group.source)}>
											{group.source === "all" ? <IconDownloadOutline16 size={24} /> : <ProviderBrand id={brandId(group.source)} name={sourceLabel(group.source)} size={28} />}
											<span className={styles.sourceText}><strong>{sourceLabel(group.source)}</strong><span>{group.source !== "all" && `${group.source} · `}{errors.some((error) => error.source === group.source) ? t.importSourceScanFailed : t.importSourceCount.replace("{n}", String(group.rows.length))}</span></span>
											{count > 0 && <span className={styles.sourceSelected}>{t.importSourceSelected.replace("{n}", String(count))}</span>}
											{group.source === activeSource && <IconCheckOutline14 size={15} className={styles.sourceCheck} />}
										</button>;
									})}
									{!filteredSources.length && <p className={styles.sourceNoMatches} role="status">{t.importSourceNoMatches}</p>}
								</div>
							</div>}
						</div>

						<div className={styles.sectionHeading}>
							<h3><span>2</span>{t.importPickSessions}</h3>
						</div>
						<div className={styles.search}>
							<IconSearchOutline16 size={15} />
							<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.importSearch} aria-label={t.importSearch} disabled={importing} />
							{query && <button type="button" aria-label={t.importClearSearch} title={t.importClearSearch} onClick={() => setQuery("")} disabled={importing}><IconCloseOutline14 size={12} /></button>}
						</div>
						<div className={styles.filters}>
							<ImportProjectPicker value={projectFilter} onChange={setProjectFilter} projects={projects} disabled={importing || scanning} />
						</div>
						{selectedOnly && <div className={styles.reviewMode}><span>{t.importSelectedSessions} · {selected.size}</span><button type="button" onClick={clearFilters} disabled={importing || scanning}>{t.importBackToAll}</button></div>}
						{moreAvailable && scanLimit < MAX_SCAN_LIMIT && <button type="button" className={styles.loadMore} onClick={() => void scan(Math.min(MAX_SCAN_LIMIT, scanLimit * 2))} disabled={importing || scanning} data-testid="import-load-more"><IconRefreshOutline14 className={scanning ? styles.spinning : undefined} size={12} />{scanning ? t.importScanning : t.importLoadEarlier}</button>}

						{activeGroup && (
							<div className={styles.group} data-testid={"import-group-" + activeGroup.source}>
								<div className={styles.groupToolbar}>
									<span>{filtersActive ? t.importFilteredCount.replace("{visible}", String(visibleRows.length)).replace("{total}", String(activeGroup.rows.length)) : t.importGroupCount.replace("{n}", String(activeGroup.rows.length)).replace("{imported}", String(activeGroup.imported))}</span>
									<button type="button" onClick={() => selectGroup(visibleRows, true)} disabled={scanning || importing || selected.size >= MAX_IMPORT_SELECTION || !availableRows.some((row) => !selected.has(key(row)))}>
										{filtersActive ? t.importSelectResults : t.importSelectAll}
									</button>
									<button type="button" onClick={() => selectGroup(visibleRows, false)} disabled={scanning || importing || !visibleRows.some((row) => selected.has(key(row)))}>{filtersActive ? t.importClearResults : t.importSelectNone}</button>
								</div>
								{!activeGroup.rows.length ? (
									<div className={styles.empty} role="status"><IconFolderOpenOutline16 size={24} /><strong>{errors.some((error) => error.source === activeSource) ? t.importSourceScanFailed : t.importEmpty}</strong><p>{t.importEmptyHint}</p></div>
								) : !visibleRows.length ? (
									<div className={styles.empty} role="status"><IconSearchOutline16 size={24} /><strong>{t.importNoMatches}</strong><button type="button" onClick={clearFilters}>{projectFilter || selectedOnly ? t.importClearFilters : t.importClearSearch}</button></div>
								) : (
									<div className={styles.rows}>
										{visibleRows.map((row) => {
											const done = isImported(row);
											const archived = archivedKeys.has(key(row));
											const checked = selected.has(key(row));
											const date = dayOf(row.updatedAt ?? row.createdAt);
											return (
												<label key={key(row)} className={styles.row} data-selected={checked} data-imported={done}>
													<input type="checkbox" checked={checked} disabled={done || scanning || importing || (!checked && selected.size >= MAX_IMPORT_SELECTION)} onChange={() => toggle(row)} />
													<div className={styles.rowContent}>
														<div className={styles.rowTitle}><strong title={row.title}>{row.title || t.importUntitled}</strong>{done && <span className={styles.imported}><IconCheckOutline14 size={11} />{t.importAlready}</span>}{archived && <span className={styles.imported} title={t.importRestoreHint}>{t.importArchived}</span>}</div>
														{archived && <p className={styles.restoreHint}>{t.importRestoreHint}</p>}
														<div className={styles.project} title={row.projectPath}><IconFolderOpenOutline16 size={12} /><span>{row.projectPath ? folderName(row.projectPath) : t.importNoProject}</span></div>
														<div className={styles.metadata}>
															{activeSource === "all" && <span>{sourceLabel(row.source)}</span>}
															{date && <time dateTime={new Date(row.updatedAt ?? row.createdAt!).toISOString()}>{date}</time>}
															{typeof row.messageCount === "number" && <span>{t.importMessages.replace("{n}", String(row.messageCount))}</span>}
															{row.model && <span title={row.model}>{row.model}</span>}
														</div>
													</div>
												</label>
											);
										})}
									</div>
								)}
								{activeGroup.rows.length > 0 && !scanning && !scanFailed && <p className={styles.scanStatus}>{moreAvailable ? scanLimit >= MAX_SCAN_LIMIT ? t.importScanLimitReached.replace("{n}", String(MAX_SCAN_LIMIT)) : t.importLimitHint.replace("{n}", String(scanLimit)) : t.importScanComplete}</p>}
							</div>
						)}
					</>
				)}
				<details className={styles.destination}>
					<summary><IconFolderOpenOutline16 size={14} /><span>{t.importWhereGoes}<small>{t.importOriginalFirst}</small></span><IconChevronDown14 size={12} /></summary>
					<div className={styles.destinationOptions}>
						<label htmlFor="import-fallback-workspace">{t.importFallbackWorkspace}</label>
						<select id="import-fallback-workspace" value={fallback} onChange={(event) => setFallback(event.target.value)} disabled={importing} aria-label={t.importFallbackWorkspace} data-testid="import-fallback" title={fallback}>
							{!fallback && <option value="">{t.importChooseWorkspace}</option>}
							{(workspaces.includes(fallback) || !fallback ? workspaces : [fallback, ...workspaces]).map((workspace) => <option key={workspace} value={workspace}>{workspace}</option>)}
						</select>
						<p>{t.importFallbackHint}</p>
					</div>
				</details>
				<details className={styles.help}><summary>{t.importHowItWorks}<IconChevronDown14 size={12} /></summary><p>{t.importDesc}</p></details>
			</div>

			{selected.size > 0 && <footer className={styles.footer}>
				<div className={styles.selectionReview} aria-live="polite">
					{hiddenSelected > 0 && <span>{t.importHiddenSelected.replace("{n}", String(hiddenSelected))}</span>}
					<div className={styles.selectionActions}>
						<button type="button" onClick={reviewSelected} disabled={importing || scanning}>{t.importViewSelected}</button>
						<button type="button" onClick={() => setSelected(new Set())} disabled={importing || scanning}>{t.importClearSelection}</button>
					</div>
				</div>
				{selected.size >= MAX_IMPORT_SELECTION && <p className={styles.selectionLimit} role="status">{t.importSelectionLimit.replace("{n}", String(MAX_IMPORT_SELECTION))}</p>}
				<button type="button" className={styles.run} onClick={() => void run()} disabled={!selected.size || importing || scanning} data-testid="import-run">
					{importing ? <IconRefreshOutline14 className={styles.spinning} /> : <IconDownloadOutline16 size={16} />}
					{importing ? t.importRunning : (selectedArchived ? selectedArchived === selected.size ? t.importRestoreRun : t.importMixedRun : t.importRun).replace("{n}", String(selected.size))}
				</button>
			</footer>}
		</section>
	);
}
