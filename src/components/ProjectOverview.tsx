"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { OverviewSourceRow, OverviewSourcesDialog } from "./OverviewSourcesDialog";
import { useI18n } from "@/i18n";
import { clientFetch } from "@/lib/client-fetch";
import type { GitInfo } from "@/lib/git-service";
import type { WebMessage } from "@/lib/types";
import type { ToolCardState } from "@/hooks/usePiWeb";
import type { DraftStore } from "./ChatInput";
import { overviewSourceKey, overviewSources, type OverviewSource } from "@/lib/overview-sources";
import { normalizeWebUrl } from "@/lib/web-search";
import { ImageViewer, type PreviewImageSource } from "./ImageViewer";
import { IconChevronDown14, IconFileOutline16, IconGlobeOutline14, IconOverviewOutline16, IconPlusOutline16, IconTerminalOutline14 } from "./icons";
import styles from "./ProjectOverview.module.css";

interface Props {
	cwd: string;
	name: string;
	messages: WebMessage[];
	tools: Record<string, ToolCardState>;
	draftKey: string;
	draftStore: DraftStore;
	refreshKey: number;
	live?: boolean;
	hasEarlier: boolean;
	loadingEarlier: boolean;
	onLoadEarlier: () => void;
	onOpenChanges: () => void;
	onOpenFile: (path: string) => void;
	onOpenUpload: (path: string) => void;
	onPickFiles: () => void;
	onAddLink: (url: string) => void;
}

function WorkspaceChanges({ cwd, refreshKey, onOpen }: { cwd: string; refreshKey: number; onOpen: () => void }) {
	const { t } = useI18n();
	const [result, setResult] = useState<{ info?: GitInfo | null; error?: string }>();
	useEffect(() => {
		if (!cwd) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let pending = false;
		const refresh = async () => {
			clearTimeout(timer);
			if (document.hidden || pending) return;
			pending = true;
			try {
				const response = await clientFetch("/api/git?summary=lines&cwd=" + encodeURIComponent(cwd), { signal: controller.signal, cache: "no-store" });
				const body = await response.json();
				if (!response.ok || !body.success) throw new Error(body.error || String(response.status));
				if (!controller.signal.aborted) setResult({ info: body.data });
			} catch (error) {
				if (!controller.signal.aborted) setResult({ error: error instanceof Error ? error.message : String(error) });
			} finally {
				pending = false;
				if (!controller.signal.aborted && !document.hidden) timer = setTimeout(refresh, 3000);
			}
		};
		void refresh();
		document.addEventListener("visibilitychange", refresh);
		return () => {
			controller.abort();
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [cwd, refreshKey]);

	const info = result?.info;
	const error = result?.error ?? info?.statusError;
	let status: string | undefined;
	if (!cwd) status = t.pickWorkspaceFirst;
	else if (!result) status = t.panelLoading;
	else if (error) status = t.gitStatusUnknown;
	else if (!info) status = t.overviewStatsUnavailable;
	else if (!info.available) status = t.gitUnavailable;
	else if (!info.isRepo) status = t.gitNotRepo;
	else if (!info.lineStats) status = t.overviewStatsUnavailable;
	const stats = !status ? info?.lineStats : undefined;
	const untracked = !status ? info?.counts?.untracked ?? 0 : 0;
	return <button type="button" className={styles.changes} disabled={!cwd} onClick={onOpen} title={error || t.overviewTrackedLines}>
		<IconFileOutline16 /><strong>{t.overviewChanges}</strong>
		<span className={styles.numbers}>
			{stats && <><span className={styles.added}>+{stats.add}</span> <span className={styles.deleted}>−{stats.del}</span></>}
		</span>
		{untracked > 0 && <small>{t.gitUntracked} {untracked}</small>}
		{status && <small>{status}</small>}
	</button>;
}

function RunningProcesses({ messages, tools }: Pick<Props, "messages" | "tools">) {
	const commands: { id: string; text: string }[] = [];
	for (const message of messages) {
		if (message.role === "bashExecution" && message.bash?.running) {
			commands.push({ id: "bash:" + (message.streamId || message.id || message.timestamp), text: message.bash.command });
		}
	}
	for (const [id, tool] of Object.entries(tools)) {
		if (tool.state !== "running" || !["bash", "powershell", "pwsh", "shell", "sh", "cmd"].includes(tool.name.toLowerCase())) continue;
		const args = tool.args as { command?: unknown; cmd?: unknown } | null;
		const command = args?.command ?? args?.cmd;
		if (typeof command === "string" && command.trim()) commands.push({ id: "tool:" + id, text: command });
	}
	const { t } = useI18n();
	if (!commands.length) return null;
	return <details open className={styles.processes}>
		<summary>{t.overviewProcesses}<IconChevronDown14 /></summary>
		<ul>{commands.map(({ id, text }) => <li key={id} title={text}><IconTerminalOutline14 /><span>{text}</span></li>)}</ul>
	</details>;
}

function OverviewContent({
	props,
	close,
	onBeforeOpenChanges,
	closeOnSourceOpen = true,
	preview,
}: {
	props: Props;
	close: () => void;
	onBeforeOpenChanges?: () => void;
	closeOnSourceOpen?: boolean;
	preview: (image: PreviewImageSource) => void;
}) {
	const { t } = useI18n();
	const { draftKey, draftStore, messages, tools } = props;
	const draft = useSyncExternalStore(draftStore.subscribe, () => draftStore.get(draftKey), () => draftStore.get(draftKey));
	const collection = useMemo(() => overviewSources(draft, messages, tools), [draft, messages, tools]);
	const [showAll, setShowAll] = useState(false);
	const [adding, setAdding] = useState(false);
	const [link, setLink] = useState("");
	const url = normalizeWebUrl(link);
	const openSource = (source: Exclude<OverviewSource, { kind: "link" }>) => {
		setShowAll(false);
		if (closeOnSourceOpen) close();
		if (source.kind === "image") preview(source.image);
		else if (source.kind === "upload") props.onOpenUpload(source.path);
		else props.onOpenFile(source.path);
	};
	return <>
		<header className={styles.name} title={props.cwd}>{props.name}</header>
		<WorkspaceChanges cwd={props.cwd} refreshKey={props.refreshKey} onOpen={() => { (onBeforeOpenChanges ?? close)(); props.onOpenChanges(); }} />
		{props.live && <RunningProcesses messages={messages} tools={tools} />}
		<div className={styles.sourceHeader}>
			<span>{t.overviewSources}</span>
			<button type="button" className="icon-btn" aria-label={t.overviewAddSource} title={t.overviewAddSource}
				aria-expanded={adding} onClick={() => setAdding(!adding)}><IconPlusOutline16 /></button>
		</div>
		{adding && <form className={styles.addSource} onSubmit={(event) => {
			event.preventDefault();
			if (!url) return;
			props.onAddLink(url);
			setLink("");
			setAdding(false);
		}}>
			<button type="button" className={styles.source} onClick={() => { props.onPickFiles(); setAdding(false); }}>
				<IconFileOutline16 />{t.overviewAttach}
			</button>
			<div className={styles.linkForm}>
				<input type="url" aria-label={t.overviewLink} placeholder="https://…" value={link} onChange={(event) => setLink(event.target.value)} />
				<button type="submit" className="icon-btn" disabled={!url} title={t.overviewAddLink} aria-label={t.overviewAddLink}><IconPlusOutline16 /></button>
			</div>
		</form>}
		{collection.sources.length === 0 && <p className={styles.empty}>{t.overviewNoSources}</p>}
		<ul className={styles.sources}>{collection.sources.slice(0, 3).map((source, index) =>
			<OverviewSourceRow key={overviewSourceKey(source)} source={source} index={index} cwd={props.cwd} onOpen={openSource} />
		)}</ul>
		{(collection.sources.length > 0 || collection.searches > 0 || props.hasEarlier) && <button type="button" aria-haspopup="dialog" className={styles.more} onClick={() => setShowAll(true)}>
			<IconGlobeOutline14 />{t.overviewShowAll}
		</button>}
		{showAll && <OverviewSourcesDialog collection={collection} cwd={props.cwd} hasEarlier={props.hasEarlier} loadingEarlier={props.loadingEarlier}
			onLoadEarlier={props.onLoadEarlier} onClose={() => setShowAll(false)} onOpen={openSource} />}
	</>;
}

export function ProjectOverviewToggle({
	open,
	controlsId,
	triggerRef,
	onToggle,
}: {
	open: boolean;
	controlsId: string;
	triggerRef?: React.RefObject<HTMLButtonElement | null>;
	onToggle: () => void;
}) {
	const { t } = useI18n();
	return (
		<button
			ref={triggerRef}
			type="button"
			className={styles.toggle + " icon-btn"}
			title={t.projectOverview}
			aria-label={t.projectOverview}
			aria-expanded={open}
			aria-controls={open ? controlsId : undefined}
			aria-haspopup="dialog"
			onClick={onToggle}
		>
			<IconOverviewOutline16 size={16} />
		</button>
	);
}

export function ProjectOverviewPanel({
	id,
	open,
	mode,
	triggerRef,
	resetKey,
	onClose,
	...props
}: Props & {
	id: string;
	open: boolean;
	mode: "docked" | "overlay";
	triggerRef?: React.RefObject<HTMLButtonElement | null>;
	resetKey?: string;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const [image, setImage] = useState<PreviewImageSource | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const escape = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.isComposing ||
				image !== null ||
				Boolean(document.querySelector('[aria-modal="true"]'))
			) {
				return;
			}
			event.preventDefault();
			onClose();
			triggerRef?.current?.focus();
		};
		document.addEventListener("keydown", escape);
		if (mode !== "overlay") {
			return () => {
				document.removeEventListener("keydown", escape);
			};
		}
		const outside = (event: PointerEvent | FocusEvent) => {
			const target = event.target as Node | null;
			if (target instanceof Element && target.closest("[data-overview-sources]")) return;
			if (!panelRef.current?.contains(target) && !triggerRef?.current?.contains(target)) onClose();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
			document.removeEventListener("keydown", escape);
		};
	}, [open, mode, image, onClose, triggerRef]);

	const closeAndFocus = () => {
		onClose();
		triggerRef?.current?.focus();
	};

	return (
		<>
			{open && (
				<div
					ref={panelRef}
					className={mode === "docked" ? styles.dockedRail : styles.overlayRail}
					data-testid="project-overview-rail"
					data-mode={mode}
				>
					<section id={id} role="dialog" aria-label={t.projectOverview} className={styles.card}>
						<OverviewContent
							key={resetKey}
							props={props}
							close={closeAndFocus}
							onBeforeOpenChanges={onClose}
							closeOnSourceOpen={mode === "overlay"}
							preview={setImage}
						/>
					</section>
				</div>
			)}
			{image && createPortal(<ImageViewer images={[image]} index={0} onIndex={() => {}} onClose={() => setImage(null)} />, document.body)}
		</>
	);
}

export function ProjectOverview(props: Props) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const [image, setImage] = useState<PreviewImageSource | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const id = useId();
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent | FocusEvent) => {
			if (event.target instanceof Element && event.target.closest("[data-overview-sources]")) return;
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || document.querySelector('[aria-modal="true"]')) return;
			event.preventDefault();
			setOpen(false);
			trigger.current?.focus();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
			document.removeEventListener("keydown", escape);
		};
	}, [open]);
	const close = () => { setOpen(false); trigger.current?.focus(); };
	return <div ref={root}>
		<ProjectOverviewToggle open={open} controlsId={id} triggerRef={trigger} onToggle={() => setOpen(!open)} />
		{open && <section id={id} role="dialog" aria-label={t.projectOverview} className={styles.card}>
			<OverviewContent props={props} close={close} preview={setImage} />
		</section>}
		{image && createPortal(<ImageViewer images={[image]} index={0} onIndex={() => {}} onClose={() => setImage(null)} />, document.body)}
	</div>;
}
