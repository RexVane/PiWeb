"use client";

import { useMemo, useState } from "react";
import { IconCloseOutline14, IconSearchOutline16 } from "@/components/icons";
import { useI18n } from "@/i18n";
import type { TrajEntry, TrajTokens } from "@/lib/types";
import styles from "./TrajectoryAnalyzer.module.css";

type Lane = 0 | 1 | 2;
type DetailTab = "summary" | "preview" | "raw" | "source";

interface DisplayRow {
	entry: TrajEntry;
	index: number;
	lane: Lane;
	turn?: number;
}

const KIND_NAME: Record<TrajEntry["kind"], string> = {
	system: "SYSTEM",
	context: "CONTEXT",
	user: "USER",
	message: "ASSISTANT",
	tool: "TOOL",
	compacted: "COMPACT",
};

function fmtTok(value?: number): string {
	if (value == null) return "—";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

function fmtTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function durationOf(entry: TrajEntry): number | undefined {
	if (entry.timing?.durationMs != null) return entry.timing.durationMs;
	const { ttftMs, decodeMs } = entry.timing ?? {};
	if (ttftMs == null && decodeMs == null) return undefined;
	return (ttftMs ?? 0) + (decodeMs ?? 0);
}

function fmtDur(ms?: number): string {
	if (ms == null) return "—";
	if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
	if (ms >= 1_000) return `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
	return `${Math.round(ms)}ms`;
}

function previewOf(entry: TrajEntry): string {
	const value = entry.preview || entry.detail || entry.thinking || entry.title || KIND_NAME[entry.kind];
	return value.replace(/\s+/g, " ").trim();
}

function sourceOf(entry: TrajEntry): string {
	switch (entry.kind) {
		case "system": return "Pi SDK · AgentSession.systemPrompt";
		case "context": return `Pi ResourceLoader · ${entry.title || "context"}`;
		case "user": return "Pi SessionManager · user message";
		case "message": return "Pi AgentSession · model response";
		case "tool": return `Pi AgentSession · tool execution${entry.toolName ? ` · ${entry.toolName}` : ""}`;
		case "compacted": return "Pi SessionManager · compaction";
	}
}

function deriveRows(entries: TrajEntry[]): DisplayRow[] {
	let turn = 0;
	return entries.map((entry, index) => {
		if (entry.kind === "user") turn += 1;
		const currentTurn = turn > 0 ? turn : undefined;
		const lane: Lane = entry.kind === "tool" ? 2 : entry.kind === "message" ? 1 : 0;
		return { entry, index, lane, ...(currentTurn ? { turn: currentTurn } : {}) };
	});
}

function matchesQuery(row: DisplayRow, query: string): boolean {
	if (!query) return true;
	const entry = row.entry;
	return [entry.kind, entry.title, entry.toolName, entry.toolCallId, entry.preview, entry.detail, entry.thinking, String(entry.seq), row.turn ? String(row.turn) : ""]
		.filter(Boolean)
		.join("\n")
		.toLocaleLowerCase()
		.includes(query);
}

function FoldIcon({ expanded }: { expanded: boolean }) {
	return <span className={styles.foldIcon} aria-hidden>{expanded ? "⊟" : "⊞"}</span>;
}

function DurationIcon() {
	return (
		<svg className={styles.durationIcon} viewBox="0 0 16 16" fill="none" aria-hidden>
			<circle cx="8" cy="8" r="5.25" />
			<path d="M8 4.75V8l2.25 1.5" />
		</svg>
	);
}

function TrajectoryTimeline({ rows, actualDuration, matchedSeqs, selected, onSelect }: {
	rows: DisplayRow[];
	actualDuration: boolean;
	matchedSeqs: Set<number> | null;
	selected: TrajEntry | null;
	onSelect: (entry: TrajEntry) => void;
}) {
	const { t } = useI18n();
	const spans = useMemo(() => {
		if (!rows.length) return [];
		const startTs = Math.min(...rows.map((row) => row.entry.ts));
		const endTs = Math.max(...rows.map((row) => row.entry.ts + (durationOf(row.entry) ?? 0)));
		const domain = Math.max(endTs - startTs, 1);
		return rows.map((row, index) => {
			if (!actualDuration || endTs === startTs) {
				return { row, left: (index / rows.length) * 100, width: Math.max(100 / rows.length - 0.12, 0.25) };
			}
			return {
				row,
				left: ((row.entry.ts - startTs) / domain) * 100,
				width: Math.max(((durationOf(row.entry) ?? 0) / domain) * 100, 0.18),
			};
		});
	}, [actualDuration, rows]);

	return (
		<div className={styles.timeline} aria-label={t.trajTimeline}>
			<div className={styles.laneLabels} aria-hidden>
				<span>{t.trajInput}</span><span>{t.trajModel}</span><span>{t.trajTools}</span>
			</div>
			<div className={styles.timelineTrack}>
				{spans.map(({ row, left, width }) => {
					const entry = row.entry;
					const total = durationOf(entry);
					const ttft = entry.timing?.ttftMs;
					const timingStyle = row.lane === 1 && total && ttft != null
						? { background: `linear-gradient(to right, var(--traj-model-wait) 0 ${(ttft / total) * 100}%, var(--traj-model) ${(ttft / total) * 100}% 100%)` }
						: undefined;
					return (
						<button
							type="button"
							key={`${entry.seq}:${row.index}`}
							className={styles.timelineSpan}
							data-kind={entry.kind}
							data-selected={selected?.seq === entry.seq || undefined}
							data-muted={matchedSeqs && !matchedSeqs.has(entry.seq) ? "true" : undefined}
							data-error={entry.isError || undefined}
							style={{ left: `${left}%`, width: `${width}%`, top: 6 + row.lane * 14, ...timingStyle }}
							title={`${KIND_NAME[entry.kind]} · ${fmtTime(entry.ts)} · ${fmtDur(total)}`}
							onClick={() => onSelect({ ...entry, ...(row.turn ? { turn: row.turn } : {}) })}
						/>
					);
				})}
			</div>
		</div>
	);
}

export function TrajectoryView({ entries, selected, onSelect }: {
	entries: TrajEntry[];
	selected: TrajEntry | null;
	onSelect: (entry: TrajEntry | null) => void;
}) {
	const { t } = useI18n();
	const [actualDuration, setActualDuration] = useState(true);
	const [callsCollapsed, setCallsCollapsed] = useState(false);
	const [turnsCollapsed, setTurnsCollapsed] = useState(false);
	const [query, setQuery] = useState("");
	const rows = useMemo(() => deriveRows(entries), [entries]);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const matchedSeqs = useMemo(
		() => normalizedQuery ? new Set(rows.filter((row) => matchesQuery(row, normalizedQuery)).map((row) => row.entry.seq)) : null,
		[normalizedQuery, rows],
	);
	const visibleRows = useMemo(
		() => rows.filter((row) => {
			if (callsCollapsed && row.entry.kind === "tool") return false;
			if (turnsCollapsed && !["system", "context", "user", "compacted"].includes(row.entry.kind)) return false;
			return matchesQuery(row, normalizedQuery);
		}).reverse(),
		[callsCollapsed, normalizedQuery, rows, turnsCollapsed],
	);

	return (
		<div className={styles.root}>
			<div className={styles.toolbar} role="toolbar" aria-label={t.tabTrajectory}>
				<div className={styles.toolbarActions}>
					<button type="button" className={styles.toolbarButton} aria-pressed={actualDuration} onClick={() => setActualDuration((value) => !value)}>
						<DurationIcon />Duration
					</button>
					<button type="button" className={styles.toolbarButton} aria-pressed={turnsCollapsed} onClick={() => setTurnsCollapsed((value) => !value)}>
						<FoldIcon expanded={!turnsCollapsed} />Turns
					</button>
					<button type="button" className={styles.toolbarButton} aria-pressed={callsCollapsed} onClick={() => setCallsCollapsed((value) => !value)}>
						<FoldIcon expanded={!callsCollapsed} />Calls
					</button>
				</div>
				<label className={styles.searchBox}>
					<IconSearchOutline16 size={13} />
					<input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t.trajSearchPlaceholder} aria-label={t.trajSearchPlaceholder} />
				</label>
			</div>

			<TrajectoryTimeline rows={rows} actualDuration={actualDuration} matchedSeqs={matchedSeqs} selected={selected} onSelect={onSelect} />

			<div className={styles.ledger}>
				{!entries.length ? <div className={styles.empty}>{t.trajEmpty}</div> : visibleRows.length === 0 ? <div className={styles.empty}>{t.trajNoMatch}</div> : (
					<div className={styles.groupBody}>{visibleRows.map((row) => {
								const entry = row.entry;
								const tokens: TrajTokens = entry.tokens ?? {};
								return (
									<button
										type="button"
										key={`${entry.seq}:${row.index}`}
										className={styles.row}
										data-kind={entry.kind}
										data-environment={entry.kind === "system" || entry.kind === "context" || undefined}
										data-selected={selected?.seq === entry.seq || undefined}
										onClick={() => onSelect({ ...entry, ...(row.turn ? { turn: row.turn } : {}) })}
									>
										<span className={styles.kindTag}>{entry.kind === "tool" && entry.toolName ? entry.toolName : KIND_NAME[entry.kind]}</span>
										<span className={styles.rowText} title={previewOf(entry)}>{previewOf(entry) || KIND_NAME[entry.kind]}</span>
										<span className={styles.metric}>{fmtTok(tokens.input)}</span>
										<span className={styles.metric}>{fmtTok(tokens.output)}</span>
										<span className={styles.metric}>{entry.thinking ? "on" : "—"}</span>
										<span className={styles.metric}>{fmtDur(durationOf(entry))}</span>
									</button>
								);
							})}</div>
				)}
			</div>
		</div>
	);
}

export function TrajInspector({ entry, onClose }: { entry: TrajEntry; onClose: () => void }) {
	const { t } = useI18n();
	const [tab, setTab] = useState<DetailTab>("summary");
	const kind = entry.toolName || KIND_NAME[entry.kind];
	const position = entry.kind === "system" ? t.trajSystem : entry.turn ? `${t.trajTurn} ${entry.turn}` : t.trajSession;
	const preview = entry.detail || entry.preview || entry.thinking || "";
	const tabs: Array<{ id: DetailTab; label: string }> = [
		{ id: "summary", label: t.trajSummary },
		{ id: "preview", label: t.trajPreview },
		{ id: "raw", label: t.trajRaw },
		{ id: "source", label: t.trajSource },
	];

	return (
		<div className={styles.inspector}>
			<div className={styles.inspectorHeader}>
				<span className={styles.inspectorTag} data-kind={entry.kind}>{kind}</span>
				<span className={styles.inspectorTitle}>{position} · {entry.kind === "message" ? t.trajModel : kind}</span>
				<button type="button" className={styles.closeButton} onClick={onClose} aria-label={t.close}><IconCloseOutline14 size={15} /></button>
			</div>
			<div className={styles.inspectorTabs} role="tablist">
				{tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
			</div>
			<div className={styles.inspectorBody}>
				{entry.encodingLoss && <p role="status" style={{ margin: "0 0 14px", color: "var(--dsw-warning, #d5a13b)", fontSize: 13, lineHeight: 1.55 }}>{t.encodingLossWarning}</p>}
				{tab === "summary" && <>
					<dl className={styles.summaryList}>
						<div><dt>{t.trajSource}</dt><dd>{sourceOf(entry)}</dd></div>
						<div><dt>{t.trajStatus}</dt><dd data-error={entry.isError || undefined}>{entry.isError ? t.trajFailed : t.trajCompleted}</dd></div>
						<div><dt>{t.duration}</dt><dd>{fmtDur(durationOf(entry))}</dd></div>
						<div><dt>{t.trajStarted}</dt><dd>{fmtTime(entry.ts)}</dd></div>
						{entry.tokens && <div><dt>{t.trajTokens}</dt><dd>↑ {fmtTok(entry.tokens.input)} · ↓ {fmtTok(entry.tokens.output)} · cache {fmtTok(entry.tokens.cacheRead)}</dd></div>}
						{entry.toolCallId && <div><dt>Call ID</dt><dd className={styles.monoValue}>{entry.toolCallId}</dd></div>}
						{entry.timing?.ttftMs != null && <div><dt>{t.ttft}</dt><dd>{fmtDur(entry.timing.ttftMs)}</dd></div>}
						{entry.timing?.decodeMs != null && <div><dt>{t.decode}</dt><dd>{fmtDur(entry.timing.decodeMs)}</dd></div>}
					</dl>
					{preview && <InspectorPayload title={t.trajPreview} value={preview} />}
				</>}
				{tab === "preview" && <InspectorPayload title={entry.thinking ? t.trajThink : t.trajPreview} value={[entry.thinking, entry.detail || entry.preview].filter(Boolean).join("\n\n")} empty={t.trajNoContent} />}
				{tab === "raw" && <InspectorPayload title="JSON" value={JSON.stringify(entry, null, 2)} mono />}
				{tab === "source" && <InspectorPayload title={t.trajSource} value={`${sourceOf(entry)}\n\nseq: ${entry.seq}\ntimestamp: ${new Date(entry.ts).toISOString()}`} mono />}
			</div>
		</div>
	);
}

function InspectorPayload({ title, value, empty, mono = false }: { title: string; value: string; empty?: string; mono?: boolean }) {
	return <section className={styles.payloadSection}><h3>{title}</h3><pre data-mono={mono || undefined}>{value || empty || "—"}</pre></section>;
}
