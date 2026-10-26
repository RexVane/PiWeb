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

/** 与 src/lib/session-import/index.ts 的 SCAN_LIMIT_PER_SOURCE 保持一致（仅用于提示文案） */
const SCAN_LIMIT = 15;

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
	const scanInFlight = useRef(false);
	const importInFlight = useRef(false);
	const scrollBody = useRef<HTMLDivElement>(null);
	const pickerRef = useRef<HTMLDivElement>(null);
	const pickerTrigger = useRef<HTMLButtonElement>(null);
	const pickerId = useId();
	const [pickerOpen, setPickerOpen] = useState(false);
	const [sourceQuery, setSourceQuery] = useState("");
	const [highlightedSource, setHighlightedSource] = useState("");

	const scan = useCallback(async () => {
		if (scanInFlight.current) return;
		scanInFlight.current = true;
		setScanning(true);
		setFailure(null);
		try {
			const response = await fetch("/api/sessions/import");
			const json = await response.json();
			if (!response.ok || !json.success) {
				setFailure(json.error || t.toastError);
				return;
			}
			const nextSummaries: Summary[] = json.data.sessions ?? [];
			const nextImported = new Set<string>(json.data.imported ?? []);
			const nextArchived = new Set<string>(json.data.archived ?? []);
			setSummaries(nextSummaries);
			setErrors(json.data.errors ?? []);
			setImportedKeys(nextImported);
			setArchivedKeys(nextArchived);
			const available = new Set(nextSummaries.map((row) => `${row.source}:${row.externalId}`).filter((key) => !nextImported.has(key) || nextArchived.has(key)));
			setSelected((previous) => new Set([...previous].filter((key) => available.has(key))));
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
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

	const key = (summary: Summary) => `${summary.source}:${summary.externalId}`;
	const isImported = (summary: Summary) => importedKeys.has(key(summary)) && !archivedKeys.has(key(summary));

	const groups = useMemo(() => {
		const bySource = new Map<string, Summary[]>();
		for (const summary of summaries) {
			const list = bySource.get(summary.source);
			if (list) list.push(summary);
			else bySource.set(summary.source, [summary]);
		}
		return SOURCE_ORDER.map((source) => {
			const rows = [...(bySource.get(source) ?? [])].sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0));
			return { source, rows, imported: rows.filter((row) => importedKeys.has(key(row))).length };
		});
	}, [summaries, importedKeys]);

	/**
	 * 一次只显示一个来源：六个工具各列 15 条就是 90 行，全铺出来既难找也没必要。
	 * 默认落在第一个有会话的来源上（SOURCE_ORDER 的顺序），用户切换后不被扫描结果重置。
	 */
	const [activeSource, setActiveSource] = useState("");
	useEffect(() => {
		if (scanning) return;
		// 扫描完成的 effect 可能晚于用户点击；按执行时的最新选择决定是否回退。
		setActiveSource((current) => groups.some((group) => group.source === current) ? current : (groups.find((group) => group.rows.length) ?? groups[0]).source);
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
	const visibleRows = (activeGroup?.rows ?? []).filter((row) => !search || [row.title, row.projectPath, row.model, row.externalId].some((value) => value?.toLocaleLowerCase().includes(search)));
	const availableRows = visibleRows.filter((row) => !isImported(row));
	const selectedArchived = [...selected].filter((key) => archivedKeys.has(key)).length;

	const toggle = (summary: Summary) => {
		if (isImported(summary) || importInFlight.current || scanInFlight.current) return;
		setSelected((previous) => {
			const next = new Set(previous);
			if (next.has(key(summary))) next.delete(key(summary));
			else next.add(key(summary));
			return next;
		});
	};

	const selectGroup = (rows: Summary[], checked: boolean) => {
		if (importInFlight.current || scanInFlight.current) return;
		setSelected((previous) => {
			const next = new Set(previous);
			for (const row of rows) {
				if (isImported(row)) continue;
				if (checked) next.add(key(row));
				else next.delete(key(row));
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
			await scan(); // 重新扫描：已经导过的行马上变成"已导入"
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
		} finally {
			importInFlight.current = false;
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
	const brandId = (source: string) => source === "claude" ? "anthropic" : source === "codex" ? "openai" : source === "grok" ? "xai" : source;
	const sourceSearch = sourceQuery.trim().toLocaleLowerCase();
	const filteredSources = groups.filter((group) => !sourceSearch || [sourceLabel(group.source), group.source].some((value) => value.toLocaleLowerCase().includes(sourceSearch)));
	const highlighted = filteredSources.find((group) => group.source === highlightedSource) ?? filteredSources[0];
	const chooseSource = (source: string) => {
		setActiveSource(source);
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
				<p className={styles.hint} data-testid="import-limit-hint">{t.importLimitHint.replace("{n}", String(SCAN_LIMIT))}</p>

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
								<ProviderBrand id={brandId(activeSource)} name={sourceLabel(activeSource)} size={30} />
								<span className={styles.sourceText}><strong>{sourceLabel(activeSource)}</strong><span>{activeSource} · {t.importSourceCount.replace("{n}", String(activeGroup?.rows.length ?? 0))}</span></span>
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
											<ProviderBrand id={brandId(group.source)} name={sourceLabel(group.source)} size={28} />
											<span className={styles.sourceText}><strong>{sourceLabel(group.source)}</strong><span>{group.source} · {errors.some((error) => error.source === group.source) ? t.importSourceScanFailed : t.importSourceCount.replace("{n}", String(group.rows.length))}</span></span>
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

						{activeGroup && (
							<div className={styles.group} data-testid={"import-group-" + activeGroup.source}>
								<div className={styles.groupToolbar}>
									<span>{t.importGroupCount.replace("{n}", String(activeGroup.rows.length)).replace("{imported}", String(activeGroup.imported))}</span>
									<button type="button" onClick={() => selectGroup(visibleRows, true)} disabled={scanning || importing || !availableRows.some((row) => !selected.has(key(row)))}>
										{search ? t.importSelectResults : t.importSelectAll}
									</button>
									<button type="button" onClick={() => selectGroup(visibleRows, false)} disabled={scanning || importing || !visibleRows.some((row) => selected.has(key(row)))}>{t.importSelectNone}</button>
								</div>
								{!activeGroup.rows.length ? (
									<div className={styles.empty} role="status"><IconFolderOpenOutline16 size={24} /><strong>{errors.some((error) => error.source === activeSource) ? t.importSourceScanFailed : t.importEmpty}</strong><p>{t.importEmptyHint}</p></div>
								) : !visibleRows.length ? (
									<div className={styles.empty} role="status"><IconSearchOutline16 size={24} /><strong>{t.importNoMatches}</strong><button type="button" onClick={() => setQuery("")}>{t.importClearSearch}</button></div>
								) : (
									<div className={styles.rows}>
										{visibleRows.map((row) => {
											const done = isImported(row);
											const archived = archivedKeys.has(key(row));
											const checked = selected.has(key(row));
											const date = dayOf(row.updatedAt ?? row.createdAt);
											return (
												<label key={key(row)} className={styles.row} data-selected={checked} data-imported={done}>
													<input type="checkbox" checked={checked} disabled={done || scanning || importing} onChange={() => toggle(row)} />
													<div className={styles.rowContent}>
														<div className={styles.rowTitle}><strong title={row.title}>{row.title || t.importUntitled}</strong>{done && <span className={styles.imported}><IconCheckOutline14 size={11} />{t.importAlready}</span>}{archived && <span className={styles.imported} title={t.importRestoreHint}>{t.importArchived}</span>}</div>
														{archived && <p className={styles.restoreHint}>{t.importRestoreHint}</p>}
														<div className={styles.project} title={row.projectPath}><IconFolderOpenOutline16 size={12} /><span>{row.projectPath ? folderName(row.projectPath) : t.importNoProject}</span></div>
														<div className={styles.metadata}>
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
							</div>
						)}
					</>
				)}
				<details className={styles.help}><summary>{t.importHowItWorks}<IconChevronDown14 size={12} /></summary><p>{t.importDesc}</p></details>
			</div>

			<footer className={styles.footer}>
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
				<div className={styles.selection} aria-live="polite">
					<span>{selected.size ? t.importSelectedCount.replace("{n}", String(selected.size)) : t.importSelectionHint}</span>
					<button type="button" onClick={() => setSelected(new Set())} disabled={!selected.size || importing}>{t.importClearSelection}</button>
				</div>
				<button type="button" className={styles.run} onClick={() => void run()} disabled={!selected.size || importing || scanning} data-testid="import-run">
					{importing ? <IconRefreshOutline14 className={styles.spinning} /> : <IconDownloadOutline16 size={16} />}
					{importing ? t.importRunning : (selectedArchived ? selectedArchived === selected.size ? t.importRestoreRun : t.importMixedRun : t.importRun).replace("{n}", String(selected.size))}
				</button>
			</footer>
		</section>
	);
}
