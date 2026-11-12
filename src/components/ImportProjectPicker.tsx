"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconCheckOutline14, IconChevronDown14, IconFolderOpenOutline16, IconSearchOutline16 } from "@/components/icons";
import { useI18n } from "@/i18n";
import styles from "./ImportProjectPicker.module.css";

interface ProjectOption {
	value: string;
	path: string;
	count: number;
}

function directoryName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "") || path;
	return trimmed.split(/[\\/]/).pop() || path;
}

export function ImportProjectPicker({ value, onChange, projects, disabled = false }: {
	value: string;
	onChange: (value: string) => void;
	projects: ProjectOption[];
	disabled?: boolean;
}) {
	const { t } = useI18n();
	const id = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [highlighted, setHighlighted] = useState<string | null>(null);
	const expanded = open && !disabled;
	const options = useMemo(() => [
		{ value: "", path: "", count: projects.reduce((sum, project) => sum + project.count, 0), name: t.importProjectAll },
		...projects.filter((project) => project.value !== "").map((project) => ({
			...project, name: project.path ? directoryName(project.path) : t.importNoProject,
		})),
	], [projects, t.importProjectAll, t.importNoProject]);
	const selected = options.find((option) => option.value === value) ?? options[0];
	const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	const filtered = options.filter((option) => words.every((word) => `${option.name} ${option.path}`.toLocaleLowerCase().includes(word)));
	const active = filtered.find((option) => option.value === highlighted) ?? filtered[0];
	const activeIndex = active ? filtered.indexOf(active) : -1;
	const optionId = (index: number) => `${id}-option-${index}`;
	const countLabel = (count: number) => t.importSourceCount.replace("{n}", String(count));
	const close = (restoreFocus = false) => {
		setOpen(false);
		if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
	};
	const openPicker = () => {
		if (disabled) return;
		setQuery("");
		setHighlighted(value);
		setOpen(true);
	};
	const choose = (next: string) => {
		if (disabled) return;
		onChange(next);
		close(true);
	};

	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
	useEffect(() => {
		if (!expanded) return;
		searchRef.current?.focus({ preventScroll: true });
		const outside = (event: MouseEvent | TouchEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", outside);
		document.addEventListener("touchstart", outside);
		return () => {
			document.removeEventListener("mousedown", outside);
			document.removeEventListener("touchstart", outside);
		};
	}, [expanded]);
	useEffect(() => {
		const list = listRef.current;
		if (!expanded || activeIndex < 0 || !list?.clientHeight) return;
		const option = document.getElementById(optionId(activeIndex));
		if (!option) return;
		const top = list.getBoundingClientRect().top + list.clientTop;
		const bottom = top + list.clientHeight;
		const rect = option.getBoundingClientRect();
		if (rect.top < top) list.scrollTop += rect.top - top;
		else if (rect.bottom > bottom) list.scrollTop += rect.bottom - bottom;
	}, [expanded, active?.value, query]);

	return (
		<div ref={rootRef} className={styles.root} onBlurCapture={(event) => {
			if (event.relatedTarget instanceof Node && !rootRef.current?.contains(event.relatedTarget)) close();
		}} onKeyDownCapture={(event) => {
			if (!expanded || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				close(true);
			} else if (event.key === "Tab") {
				// Continue normal Tab order from the trigger after the search field unmounts.
				close(true);
			}
		}}>
			<button ref={triggerRef} type="button" className={styles.trigger} disabled={disabled} data-open={expanded}
				data-testid="import-project-picker" aria-label={t.importProjectFilter} aria-haspopup="dialog" aria-expanded={expanded}
				aria-controls={expanded ? `${id}-popup` : undefined} aria-describedby={`${id}-value`}
				title={selected.path || selected.name} onClick={() => expanded ? close() : openPicker()}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						event.stopPropagation();
						openPicker();
					}
				}}>
				<span className={styles.folder}><IconFolderOpenOutline16 size={17} /></span>
				<span id={`${id}-value`} className={styles.copy}><strong>{selected.name}</strong>
					{selected.path && <span className={styles.path}>{selected.path}</span>}</span>
				<span className={styles.count} title={countLabel(selected.count)} aria-label={countLabel(selected.count)}>{selected.count}</span>
				<IconChevronDown14 className={styles.chevron} size={14} />
			</button>
			{expanded && <div id={`${id}-popup`} className={styles.menu} role="dialog" aria-label={t.importProjectFilter}>
				<div className={styles.search}>
					<IconSearchOutline16 size={15} />
					<input ref={searchRef} type="search" role="combobox" aria-label={t.importProjectSearch} placeholder={t.importProjectSearch}
						value={query} autoComplete="off" spellCheck={false} aria-expanded="true" aria-autocomplete="list"
						aria-controls={`${id}-list`} aria-activedescendant={active ? optionId(activeIndex) : undefined}
						onChange={(event) => { setQuery(event.target.value); setHighlighted(null); }} onKeyDown={(event) => {
							if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								event.stopPropagation();
								const next = filtered[(activeIndex + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length];
								if (next) setHighlighted(next.value);
							} else if (event.key === "Enter") {
								event.preventDefault();
								event.stopPropagation();
								if (active) choose(active.value);
							}
						}} />
				</div>
				<div ref={listRef} id={`${id}-list`} className={styles.list} role="listbox" aria-label={t.importProjectFilter}>
					{filtered.map((option, index) => <button key={option.value} id={optionId(index)} type="button" role="option" tabIndex={-1}
						className={styles.option} aria-selected={value === option.value} aria-label={option.path || option.name}
						aria-describedby={`${id}-count-${index}`} data-highlighted={active?.value === option.value} title={option.path || option.name}
						onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setHighlighted(option.value)} onClick={() => choose(option.value)}>
						<span className={styles.optionFolder}><IconFolderOpenOutline16 size={16} /></span>
						<span className={styles.copy}><strong>{option.name}</strong>{option.path && <span className={styles.path}>{option.path}</span>}</span>
						<span id={`${id}-count-${index}`} className={styles.count} aria-label={countLabel(option.count)}>{option.count}</span>
						<span className={styles.check} aria-hidden="true">{value === option.value && <IconCheckOutline14 size={14} />}</span>
					</button>)}
					{!filtered.length && <p className={styles.empty} role="status">{t.importProjectNoMatches}</p>}
				</div>
			</div>}
		</div>
	);
}
