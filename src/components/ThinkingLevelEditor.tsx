"use client";
import { useI18n } from "@/i18n";
import { SelectOption as ThinkingSelect } from "./settings/SharedControls";
import { IconPlusOutline16, IconTrashOutline16 } from "./icons";
import { THINKING_LEVELS } from "@/lib/thinking-level";
import { nextThinkingRow, thinkingApiValue, validThinkingRows, type ThinkingLevelRow } from "@/lib/thinking-config";
import styles from "./ThinkingLevelEditor.module.css";

export function ThinkingLevelEditor({ rows, onChange }: { rows?: ThinkingLevelRow[]; onChange: (rows: ThinkingLevelRow[] | undefined) => void }) {
	const { t } = useI18n();
	const current = rows ?? [];
	const next = nextThinkingRow(current);
	const update = (index: number, patch: Partial<ThinkingLevelRow>) => onChange(current.map((row, i) => i === index ? { ...row, ...patch } : row));
	return (
		<div className={styles.editor} data-testid="thinking-level-editor">
			<p className={styles.hint}>{rows === undefined ? t.thinkingAutoHint : t.thinkingManualHint}</p>
			{current.length > 0 && <div className={styles.labels}><span>{t.thinkingLevelColumn}</span><span>{t.thinkingValueColumn}</span><span /></div>}
			{current.map((row, index) => (
				<div className={styles.row} key={index}>
					<ThinkingSelect label={`${t.thinkingLevelColumn} ${index + 1}`} value={row.level}
						options={THINKING_LEVELS.map((level) => ({ value: level, label: level, disabled: current.some((other, i) => i !== index && other.level === level) }))}
						onChange={(level) => update(index, { level, ...(row.value === thinkingApiValue(row.level) ? { value: thinkingApiValue(level) } : {}) })} />
					<input className={styles.input} aria-label={`${t.thinkingValueColumn} ${index + 1}`} value={row.value} maxLength={64}
						aria-invalid={!row.value.trim() || undefined} onChange={(event) => update(index, { value: event.target.value })} />
					<button type="button" className="icon-btn" aria-label={`${t.thinkingRemoveLevel} ${row.level}`} title={t.thinkingRemoveLevel}
						onClick={() => { const remaining = current.filter((_, i) => i !== index); onChange(remaining.length ? remaining : undefined); }}><IconTrashOutline16 size={14} /></button>
				</div>
			))}
			{rows !== undefined && !validThinkingRows(rows) && <p role="alert" className={styles.error}>{t.thinkingInvalidRows}</p>}
			<div className={styles.actions}>
				<button type="button" className="btn-outline" disabled={!next} onClick={() => { if (next) onChange([...current, next]); }}><IconPlusOutline16 size={14} />{t.thinkingAddLevel}</button>
				{rows !== undefined && <button type="button" className="btn-outline" onClick={() => onChange(undefined)}>{t.thinkingUseAutomatic}</button>}
			</div>
		</div>
	);
}
